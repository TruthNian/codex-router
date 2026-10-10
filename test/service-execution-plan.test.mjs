import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import { freePort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// A separate unchanged checkout can run the native-only negative control.
// It never replaces the production installation or changes the tested fixture.
const source = process.env.CODEX_ROUTER_TEST_SERVICE_SOURCE_ROOT || root;
const callerKey = "service-plan-synthetic-caller-capability-with-length";
const internalKey = "service-plan-synthetic-internal-capability-with-length";
const serviceNames = ["router", "gateway", "oauth", "api", "grok", "antigravity", "devin", "cursor"];
const frame = (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function customModel(id, port, { protocol = "openai-responses", ...extra } = {}) {
  return { slug: `custom/${id}`, gatewayModel: `fixture-${id}`, upstreamModel: id,
    provider: "custom", displayName: `Fixture ${id}`, description: "Synthetic loopback fixture",
    listed: true, compHash: `fixture-${id}-v1`, priority: 1,
    contextWindow: 131072, autoCompact: 110000, inputModalities: ["text"],
    defaultEffort: "high", reasoningLevels: [{ effort: "high", description: "Fixture reasoning" }],
    endpoint: { protocol, baseUrl: `http://127.0.0.1:${port}/v1`, keyless: true },
    ...extra };
}

function runtimeEnvironment() {
  const names = new Set(["PATH", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "TEMP", "TMP",
    "PSModulePath", "SystemDrive", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"]
    .map((name) => name.toLowerCase()));
  return Object.fromEntries(Object.entries(process.env).filter(([name, value]) =>
    names.has(name.toLowerCase()) && typeof value === "string"));
}

async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function get(url, options = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000), ...options });
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) };
}

async function portClosed(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    const finish = (closed) => { socket.destroy(); resolve(closed); };
    socket.setTimeout(2_000, () => finish(false));
    socket.once("connect", () => finish(false));
    socket.once("error", () => finish(true));
  });
}

async function fixture(t, { models = (port) => [customModel("responses", port)],
  selection = ["custom"], missingSelection = false, services = ["api"], drainMs = 2_000, upstreamHandler } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "service-execution-plan-"));
  const user = path.join(directory, "user");
  const state = path.join(directory, "state");
  const home = path.join(directory, "codex");
  for (const folder of [state, home, user, path.join(user, "AppData", "Roaming"),
    path.join(user, "AppData", "Local")]) mkdirSync(folder, { recursive: true, mode: 0o700 });
  const servers = [];
  const upstreamRequests = [];
  let child;
  let errors = "";
  let exit;
  let exited;
  let stopPromise;
  const foreign = [];
  const expectedPorts = new Set(["router", ...services.map((service) =>
    ({ kimi: "oauth", grok: "grok", antigravity: "antigravity", devin: "devin" }[service] || service))]);
  const ports = Object.fromEntries(await Promise.all(serviceNames.map(async (name) => [name, await freePort()])));
  assert.equal(new Set(Object.values(ports)).size, serviceNames.length);
  const stopOnce = async () => {
    if (!child || exit) return exit;
    assert.equal(child.connected, true, `supervisor lost its IPC channel before shutdown:\n${errors}`);
    child.send({ type: "model-router:shutdown" });
    let timer;
    try {
      const result = await Promise.race([exited, new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`supervisor did not finish IPC shutdown:\n${errors}`)),
          2 * (drainMs + 1_000) + 6_000);
      })]);
      assert.equal(result.signal, null, errors);
      assert.equal(result.code, 0, errors);
      return result;
    } finally {
      clearTimeout(timer);
      // A failed IPC-exit assertion must not keep the test runner alive. This
      // releases only our channel after the helper's absolute stop allowance;
      // the failure is still reported, rather than certified as graceful exit.
      if (!exit && child.connected) child.disconnect();
    }
  };
  const stop = () => stopPromise ||= stopOnce();
  t.after(async () => {
    try {
      await stop();
      for (const name of expectedPorts) assert.equal(await portClosed(ports[name]), true,
        `owned ${name} listener survived supervisor exit:\n${errors}`);
      for (const record of foreign) {
        assert.equal(record.server.listening, true, `unused foreign ${record.name} listener was stopped`);
        assert.equal(record.requests, 0, `unused foreign ${record.name} listener was probed`);
      }
    } finally {
      // Servers belong to this fixture. Never infer ownership from a port.
      for (const server of servers) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    upstreamRequests.push(body);
    if (upstreamHandler) { await upstreamHandler(request, response, body, ports); return; }
    const identity = { id: "resp_fixture", object: "response", model: body.model,
      status: "in_progress", output: [] };
    const completed = { ...identity, status: "completed",
      output: [{ id: "msg_fixture", type: "message", status: "completed", role: "assistant",
        content: [{ type: "output_text", text: "fixture complete", annotations: [] }] }],
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } };
    if (body.stream === false) {
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(completed));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(frame({ type: "response.created", response: identity }));
    response.end(frame({ type: "response.completed", response: completed }));
  });
  servers.push(upstream);
  const upstreamPort = await listen(upstream);
  const registry = path.join(directory, "registry.json");
  const entries = models(upstreamPort);
  writeFileSync(registry, JSON.stringify({ version: 1, providers: [{ id: "custom",
    displayName: "Fixture custom", kind: "openai-compatible", ownedBy: "fixture",
    authMode: "per-model", perModelEndpoint: true }], models: entries }));
  const selectionFile = path.join(state, "enabled-providers.json");
  if (!missingSelection) writeFileSync(selectionFile, JSON.stringify({ version: 1, providers: selection }));
  for (const [name, value] of [["caller-secret", callerKey], ["internal-secret", internalKey]]) {
    writeFileSync(path.join(state, name), `${value}\n`, { mode: 0o600 });
  }
  // A successfully bound foreign listener is a stronger negative control than
  // a closed unused port: probing or starting the old all-stack service fails.
  for (const name of serviceNames.filter((name) => !expectedPorts.has(name))) {
    const record = { name, requests: 0 };
    record.server = http.createServer((_request, response) => {
      record.requests += 1;
      response.writeHead(418, { "Content-Type": "application/json" }).end('{"foreign":true}');
    });
    await listen(record.server, ports[name]);
    servers.push(record.server);
    foreign.push(record);
  }
  const env = {
    ...runtimeEnvironment(), HOME: user, USERPROFILE: user,
    APPDATA: path.join(user, "AppData", "Roaming"), LOCALAPPDATA: path.join(user, "AppData", "Local"),
    CODEX_HOME: home, KIMI_CODE_HOME: path.join(directory, "kimi"),
    DSH_HOME: path.join(directory, "dsh"), GEMINI_CLI_HOME: path.join(directory, "gemini"),
    CURSOR_HOME: path.join(directory, "cursor"), XDG_CONFIG_HOME: path.join(directory, "xdg"),
    MODEL_ROUTER_TARGET: "codex", MODEL_ROUTER_STATE_DIR: state, CODEX_ROUTER_STATE_DIR: state,
    CODEX_ROUTER_SOURCE_ROOT: source, MODEL_ROUTER_REGISTRY: registry,
    MODEL_ROUTER_USER_MODELS: path.join(state, "user-models.json"),
    MODEL_ROUTER_GENERIC_PROVIDERS: path.join(state, "generic-providers.json"),
    MODEL_ROUTER_MODEL_PICKER_STATE: path.join(state, "model-picker.json"),
    CODEX_ROUTER_SERVICE_PLATFORM: "test-fixture",
    CODEX_ROUTER_NO_DISCOVERY: "0", NO_DISCOVERY: "0",
    MODEL_ROUTER_SHOW_ALL_MODELS: "0", CODEX_ROUTER_SHOW_ALL_MODELS: "0",
    CODEX_ROUTER_NATIVE_SESSION_FALLBACK: "0", CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    MODEL_ROUTER_LITELLM_BIN: path.join(directory, "missing-litellm-launcher"),
    MODEL_ROUTER_SHUTDOWN_DRAIN_MS: String(drainMs),
    CODEX_ROUTER_STARTUP_HEALTH_TIMEOUT_MS: "10000", CODEX_ROUTER_GATEWAY_HEALTH_TIMEOUT_MS: "10000",
    MODEL_ROUTER_PORT: String(ports.router), MODEL_ROUTER_GATEWAY_PORT: String(ports.gateway),
    MODEL_ROUTER_OAUTH_PORT: String(ports.oauth), MODEL_ROUTER_API_PORT: String(ports.api),
    MODEL_ROUTER_GROK_OAUTH_PORT: String(ports.grok), MODEL_ROUTER_ANTIGRAVITY_OAUTH_PORT: String(ports.antigravity),
    MODEL_ROUTER_DEVIN_CLI_PORT: String(ports.devin), MODEL_ROUTER_CURSOR_PUBLIC_PORT: String(ports.cursor),
    MODEL_ROUTER_QUIET: "1", CODEX_ROUTER_QUIET: "1",
  };
  // Discovery is intentionally enabled to exercise native passthrough. The
  // registry has no OS keychain/CLI resolver, and every home/state file is ours.
  for (const name of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "CODEX_HOME", "KIMI_CODE_HOME",
    "DSH_HOME", "GEMINI_CLI_HOME", "CURSOR_HOME", "XDG_CONFIG_HOME", "MODEL_ROUTER_STATE_DIR",
    "CODEX_ROUTER_STATE_DIR", "MODEL_ROUTER_REGISTRY", "MODEL_ROUTER_USER_MODELS",
    "MODEL_ROUTER_GENERIC_PROVIDERS", "MODEL_ROUTER_MODEL_PICKER_STATE"]) {
    const relative = path.relative(directory, env[name]);
    assert.ok(relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
      `${name} escaped the synthetic fixture`);
  }
  child = spawn(process.execPath, [path.join(source, "src", "start.mjs")], {
    cwd: source, env, stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { errors += chunk; });
  exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => { exit = { code, signal }; resolve(exit); });
  });
  const health = () => get(`http://127.0.0.1:${ports.router}/health`);
  const live = () => get(`http://127.0.0.1:${ports.router}/health/live`);
  const deadline = Date.now() + 30_000;
  while (true) {
    if (exit) throw new Error(`supervisor exited before Router liveness (code=${exit.code}):\n${errors}`);
    try { if ((await live()).status === 200) break; } catch {}
    if (Date.now() >= deadline) throw new Error(`Router liveness never arrived:\n${errors}`);
    await pause(50);
  }
  const post = (model, stream = false) => fetch(`${callerBaseUrl(ports.router, callerKey)}/responses`, {
    method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ model, stream, input: "synthetic fixture input" }),
  });
  return { directory, state, ports, entries, registry, selectionFile, env, child,
    health, live, post, stop, upstreamRequests, errors: () => errors };
}

async function waitReady(stack, status = 200) {
  const deadline = Date.now() + 15_000;
  let result;
  do {
    result = await stack.health();
    if (result.status === status && (status === 200 ? result.body.ok === true
      : result.body.degraded.every((name) => name === "gateway"))) return result;
    await pause(50);
  } while (Date.now() < deadline);
  assert.fail(`readiness did not reach ${status}: ${JSON.stringify(result)}\n${stack.errors()}`);
}

test("native-only real start needs no Python and never probes or stops foreign unused listeners", { timeout: 60_000 }, async (t) => {
  const stack = await fixture(t, { selection: [], services: [] });
  const ready = await waitReady(stack);
  assert.deepEqual(ready.body.executionPlan.services, []);
  assert.equal(ready.body.executionPlan.needsGateway, false);
  assert.match(ready.body.executionPlan.fingerprint, /^[a-f0-9]{64}$/);
  const response = await stack.post("gpt-fixture");
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).status, "completed");
  assert.equal(stack.upstreamRequests.length, 1);
  writeFileSync(stack.selectionFile, JSON.stringify({ version: 1, providers: ["custom"] }));
  assert.deepEqual((await stack.health()).body.executionPlan, ready.body.executionPlan);
  const stillDisabled = await stack.post("custom/responses");
  assert.equal(stillDisabled.status, 409);
  assert.equal((await stillDisabled.json()).error.type, "provider_not_enabled");
  assert.equal(stack.upstreamRequests.length, 1);
  assert.doesNotMatch(stack.errors(), /LiteLLM is not installed|dependency unavailable|gateway unavailable/);
  await stack.stop();
});

test("custom HTTP Responses real start uses only API and keeps its adopted selection and plan", { timeout: 60_000 }, async (t) => {
  const stack = await fixture(t);
  const ready = await waitReady(stack);
  assert.deepEqual(ready.body.executionPlan.services, ["api"]);
  assert.equal(ready.body.executionPlan.needsGateway, false);
  const response = await stack.post("custom/responses");
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).status, "completed");
  // A candidate file write is not process adoption. Both registry semantics
  // and selection changes must leave this running generation unchanged.
  const replacement = JSON.parse(readFileSync(stack.registry, "utf8"));
  replacement.models[0].endpoint.protocol = "openai";
  replacement.models[0].endpoint.baseUrl = "http://127.0.0.1:9/v1";
  writeFileSync(stack.registry, JSON.stringify(replacement));
  writeFileSync(stack.selectionFile, JSON.stringify({ version: 1, providers: [] }));
  assert.deepEqual((await stack.health()).body.executionPlan, ready.body.executionPlan);
  const unchanged = await stack.post("custom/responses");
  assert.equal(unchanged.status, 200, await unchanged.clone().text());
  assert.equal((await unchanged.json()).status, "completed");
  assert.equal(stack.upstreamRequests.length, 2);
  assert.doesNotMatch(stack.errors(), /LiteLLM is not installed|gateway unavailable/);
});

test("mixed Chat and direct routes keep native and Responses available when the gateway is missing", { timeout: 60_000 }, async (t) => {
  const stack = await fixture(t, { services: ["api", "gateway"], models: (port) => [
    customModel("responses", port), customModel("chat", port, { protocol: "openai" }),
  ] });
  const health = await waitReady(stack, 503);
  assert.deepEqual(health.body.executionPlan.services, ["api", "gateway"]);
  assert.equal(health.body.executionPlan.needsGateway, true);
  assert.ok(health.body.degraded.includes("gateway"));
  assert.equal((await stack.live()).status, 200);
  for (const model of ["gpt-fixture", "custom/responses"]) {
    const response = await stack.post(model);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).status, "completed");
  }
  assert.equal(stack.child.exitCode, null);
});

test("a missing selection retains the all-provider default while an explicit empty list disables routes", { timeout: 60_000 }, async (t) => {
  // null is deliberately not used: omitting the document is the historic
  // all-provider default, unlike its explicit providers: [] representation.
  const stack = await fixture(t, { missingSelection: true, services: ["api", "gateway"],
    models: (port) => [customModel("chat", port, { protocol: "openai" })] });
  const health = await waitReady(stack, 503);
  assert.deepEqual(health.body.executionPlan.services, ["api", "gateway"]);
  assert.equal((await stack.live()).status, 200);
});

test("a selected Responses route without credentials keeps its error listener and names the setup problem", { timeout: 60_000 }, async (t) => {
  const stack = await fixture(t, { models: (port) => [customModel("needs-key", port, {
    endpoint: { protocol: "openai-responses", baseUrl: `http://127.0.0.1:${port}/v1`,
      credential: { file: "fixture-never-created.secret", environment: ["FIXTURE_NEVER_PRESENT_KEY"] } },
  })] });
  await waitReady(stack);
  const response = await stack.post("custom/needs-key");
  const body = await response.json();
  assert.equal(response.status, 503, JSON.stringify(body));
  assert.equal(body.error.type, "server_error");
  assert.match(body.error.message, /Fixture needs-key key is not configured/);
  assert.doesNotMatch(JSON.stringify(body), /ECONNREFUSED|connect ECONN|fetch failed/);
  const listener = await get(`http://127.0.0.1:${stack.ports.api}/v1/responses`, {
    method: "POST", headers: { Authorization: `Bearer ${internalKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "fixture-needs-key", stream: false, input: "synthetic fixture input" }),
  });
  assert.equal(listener.status, 503);
  assert.equal(listener.body.error.type, "provider_api_key_missing");
  assert.equal(listener.body.error.provider, "custom");
  assert.equal(stack.upstreamRequests.length, 0);
  assert.equal((await stack.live()).status, 200);
});

test("selected hidden vision routes still include their actual gateway dependency", { timeout: 60_000 }, async (t) => {
  const stack = await fixture(t, { services: ["api", "gateway"], models: (port) => [
    customModel("responses", port), customModel("hidden-vision", port, {
      protocol: "openai", listed: false, inputModalities: ["text", "image"],
    }),
  ] });
  const health = await waitReady(stack, 503);
  assert.deepEqual(health.body.executionPlan.services, ["api", "gateway"]);
  assert.equal(health.body.executionPlan.needsGateway, true);
  assert.ok(health.body.degraded.includes("gateway"));
});

for (const completes of [true, false]) {
  test(`real IPC shutdown ${completes ? "finishes the stream with API still alive" : "ends an over-budget stream with a typed terminal and clean EOF"}`,
    { timeout: 60_000 }, async (t) => {
      let providerResponse;
      let apiHealthAtCompletion;
      let providerClosed = false;
      const stack = await fixture(t, { drainMs: completes ? 2_000 : 150,
        upstreamHandler: async (_request, response, body) => {
          providerResponse = response;
          response.once("close", () => { providerClosed = true; });
          response.writeHead(200, { "Content-Type": "text/event-stream" });
          response.write(frame({ type: "response.created", sequence_number: 0, response: {
            id: "resp_draining", object: "response", created_at: 1_700_000_000,
            model: body.model, status: "in_progress", output: [],
          } }));
          response.write(frame({ type: "response.output_text.delta", sequence_number: 1, item_id: "msg_drain", output_index: 0,
            content_index: 0, delta: "before shutdown" }));
        } });
      await waitReady(stack);
      const response = await stack.post("custom/responses", true);
      assert.equal(response.status, 200);
      const reader = response.body.getReader();
      const first = await reader.read();
      const chunks = [first.value];
      assert.equal(first.done, false);
      assert.ok(providerResponse);
      const stopping = stack.stop();
      if (completes) {
        await pause(200);
        apiHealthAtCompletion = await get(`http://127.0.0.1:${stack.ports.api}/health`, {
          headers: { Authorization: `Bearer ${internalKey}` },
        });
        providerResponse.end(frame({ type: "response.completed", sequence_number: 2, response: {
          id: "resp_draining", object: "response", created_at: 1_700_000_000,
          model: "responses", status: "completed", output: [],
          usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
        } }));
      }
      // reader.read must reach clean EOF, rather than throwing a socket reset.
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        chunks.push(chunk.value);
      }
      const text = Buffer.concat(chunks).toString("utf8");
      if (completes) {
        assert.equal(apiHealthAtCompletion.status, 200);
        assert.match(text, /event: response\.completed/);
        assert.doesNotMatch(text, /local_router_stream_failed|response\.failed/);
      } else {
        assert.match(text, /event: response\.failed/);
        assert.match(text, /"code":"server_error"/);
        assert.match(text, /The local router is restarting/);
        assert.doesNotMatch(text, /event: response\.completed/);
      }
      await stopping;
      assert.equal(providerClosed, true, "API did not close its owned upstream connection");
    });
}
