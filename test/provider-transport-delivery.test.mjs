import "./helpers/isolated-runtime-environment.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { callerBaseUrl } from "../src/caller-auth.mjs";
import { PROVIDERS } from "../src/model-registry.mjs";
import { classifyRoutedFailure } from "../src/model-failover.mjs";
import { PROVIDER_DELIVERY_STATE_HEADER } from "../src/transport-failure.mjs";
import { openPort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const internalKey = "synthetic-delivery-proof-service-capability-123456";

test("only the local forwarder's own transport failure mints delivery evidence", async () => {
  const provider = PROVIDERS.get("deepseek");
  assert.equal(typeof provider?.baseUrlEnv, "string", "the fixture must control the exact provider endpoint");
  let mode = "spoof";
  let executed = 0;
  const origin = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume the actual POST */ }
    executed += 1;
    if (mode === "reset") return request.socket.destroy();
    response.writeHead(500, { "Content-Type": "application/json", [PROVIDER_DELIVERY_STATE_HEADER]: "not_sent" });
    response.end(JSON.stringify({ error: { type: "provider_transport_error", code: "ECONNREFUSED", deliveryState: "not_sent" } }));
  });
  await new Promise((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const originPort = origin.address().port;
  const port = await openPort();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "provider-delivery-proof-"));
  const child = spawn(process.execPath, [path.join(root, "src/api-forwarder.mjs")], {
    cwd: root,
    env: { ...process.env, MODEL_ROUTER_STATE_DIR: stateDir, MODEL_ROUTER_API_PORT: String(port),
      MODEL_ROUTER_INTERNAL_KEY: internalKey, MODEL_ROUTER_QUIET: "1",
      DEEPSEEK_API_KEY: "synthetic-provider-key", [provider.baseUrlEnv]: `http://127.0.0.1:${originPort}/v1` },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let errors = "";
  child.stderr.setEncoding("utf8").on("data", (part) => { errors += part; });
  const headers = { Authorization: `Bearer ${internalKey}`, "Content-Type": "application/json" };
  const post = () => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST", headers,
    body: JSON.stringify({ model: "deepseek-v4-pro", stream: false, messages: [{ role: "user", content: "synthetic input" }] }),
  });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 200 && !ready; attempt += 1) {
      if (child.exitCode !== null) throw new Error(errors);
      try { ready = (await fetch(`http://127.0.0.1:${port}/health`, { headers })).ok; } catch {}
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(ready, true, errors);
    const spoof = await post();
    const spoofText = await spoof.text();
    assert.equal(spoof.status, 500, spoofText);
    assert.equal(spoof.headers.get(PROVIDER_DELIVERY_STATE_HEADER), null);
    assert.equal(classifyRoutedFailure({ status: spoof.status, bodyText: spoofText }).swap, false);
    assert.equal(executed, 1);

    mode = "reset";
    const reset = await post();
    const resetText = await reset.text();
    assert.equal(reset.status, 502, resetText);
    assert.equal(reset.headers.get(PROVIDER_DELIVERY_STATE_HEADER), "possibly_sent");
    assert.equal(classifyRoutedFailure({ status: reset.status, bodyText: resetText,
      trustedDeliveryState: reset.headers.get(PROVIDER_DELIVERY_STATE_HEADER) }).swap, false);
    assert.equal(executed, 2, "an executed generation is submitted once");

    origin.closeAllConnections();
    await new Promise((resolve) => origin.close(resolve));
    const refused = await post();
    const refusedText = await refused.text();
    assert.equal(refused.status, 502, refusedText);
    assert.equal(refused.headers.get(PROVIDER_DELIVERY_STATE_HEADER), "not_sent");
    assert.equal(classifyRoutedFailure({ status: refused.status, bodyText: refusedText }).swap, false);
    assert.equal(classifyRoutedFailure({ status: refused.status, bodyText: refusedText,
      trustedDeliveryState: refused.headers.get(PROVIDER_DELIVERY_STATE_HEADER) }).swap, true);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    if (origin.listening) {
      origin.closeAllConnections();
      await new Promise((resolve) => origin.close(resolve));
    }
    rmSync(stateDir, { recursive: true, force: true });
  }
});


test("the actual routed chain recovers a confined not-sent failure without executing the POST twice", async (t) => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "routed-delivery-proof-"));
  const callerKey = "synthetic-delivery-proof-caller-capability-123456";
  const children = [];
  const servers = [];
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await new Promise((resolve) => child.once("exit", resolve));
      }
    }
    for (const server of servers) {
      server.closeAllConnections();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    }
    rmSync(stateDir, { recursive: true, force: true });
  });
  writeFileSync(path.join(stateDir, "meta-api-key.secret"), "synthetic-meta-key\n", { mode: 0o600 });
  const originPort = await openPort();
  const forwarderPort = await openPort();
  const proxyPort = await openPort();
  const routerPort = await openPort();
  let executions = 0;
  let originMode = "complete";
  const origin = http.createServer(async (request, response) => {
    for await (const _chunk of request) {}
    executions += 1;
    if (originMode === "reset" || originMode === "reset-once") {
      if (originMode === "reset-once") originMode = "complete";
      return request.socket.destroy();
    }
    if (originMode === "spoof") {
      response.writeHead(502, { "Content-Type": "application/json", [PROVIDER_DELIVERY_STATE_HEADER]: "not_sent" });
      response.end(JSON.stringify({ error: { type: "provider_transport_error", code: "ECONNREFUSED", deliveryState: "not_sent" } }));
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
      id: "resp-confined-delivery", object: "response", status: "completed",
      output: [{ id: "msg-confined-delivery", type: "message", role: "assistant",
        content: [{ type: "output_text", text: "one executed generation" }] }],
      usage: { input_tokens: 4, output_tokens: 3 },
    }));
  });
  servers.push(origin);
  const forwarded = [];
  const proxy = http.createServer(async (request, response) => {
    if (request.method === "GET") return response.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    forwarded.push(body);
    const upstream = await fetch(`http://127.0.0.1:${forwarderPort}${request.url}`, {
      method: "POST", headers: { Authorization: `Bearer ${internalKey}`, "Content-Type": "application/json" }, body,
    });
    const raw = Buffer.from(await upstream.arrayBuffer());
    if (forwarded.length === 1) {
      assert.equal(upstream.headers.get(PROVIDER_DELIVERY_STATE_HEADER), "not_sent");
      assert.equal(executions, 0);
      // This test-owned authenticated hop exposes the real forwarder's failure
      // only after the initially refused origin becomes reachable.
      await new Promise((resolve) => origin.listen(originPort, "127.0.0.1", resolve));
    }
    response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
    response.end(raw);
  });
  servers.push(proxy);
  await new Promise((resolve) => proxy.listen(proxyPort, "127.0.0.1", resolve));
  const start = async (file, port, env) => {
    const child = spawn(process.execPath, [path.join(root, "src", file)], {
      cwd: root, env: { ...process.env, MODEL_ROUTER_STATE_DIR: stateDir, CODEX_ROUTER_STATE_DIR: stateDir,
        MODEL_ROUTER_INTERNAL_KEY: internalKey, CODEX_ROUTER_INTERNAL_KEY: internalKey,
        CODEX_ROUTER_CALLER_KEY: callerKey, MODEL_ROUTER_QUIET: "1", ...env },
      stdio: ["ignore", "ignore", "pipe"],
    });
    children.push(child);
    let errors = "";
    child.stderr.setEncoding("utf8").on("data", (part) => { errors += part; });
    const readyUrl = file === "router.mjs" ? `${callerBaseUrl(port, callerKey)}/models` : `http://127.0.0.1:${port}/health`;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (child.exitCode !== null) throw new Error(errors);
      try { if ((await fetch(readyUrl, { headers: { Authorization: `Bearer ${internalKey}` } })).ok) return child; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`isolated service failed to start: ${errors}`);
  };
  const provider = PROVIDERS.get("meta");
  assert.equal(typeof provider?.baseUrlEnv, "string");
  await start("api-forwarder.mjs", forwarderPort, {
    MODEL_ROUTER_API_PORT: String(forwarderPort), META_API_KEY: "synthetic-meta-key",
    [provider.baseUrlEnv]: `http://127.0.0.1:${originPort}/v1`,
  });
  const startRouter = (port, policy) => start("router.mjs", port, {
    CODEX_ROUTER_PORT: String(port), MODEL_ROUTER_API_PORT: String(proxyPort),
    CODEX_ROUTER_API_BASE_URL: `http://127.0.0.1:${proxyPort}/v1`,
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${proxyPort}/v1`,
    CODEX_ROUTER_GATEWAY_HEALTH_URL: `http://127.0.0.1:${proxyPort}/health`,
    CODEX_ROUTER_API_HEALTH_URL: `http://127.0.0.1:${proxyPort}/health`,
    CODEX_ROUTER_OAUTH_HEALTH_URL: `http://127.0.0.1:${proxyPort}/health`,
    CODEX_ROUTER_GROK_OAUTH_HEALTH_URL: `http://127.0.0.1:${proxyPort}/health`,
    CODEX_ROUTER_NO_DISCOVERY: "0", CODEX_ROUTER_SHOW_ALL_MODELS: "1",
    CODEX_ROUTER_NATIVE_RETRY_POLICY: policy,
  });
  await startRouter(routerPort, "at-most-once");
  const result = await fetch(`${callerBaseUrl(routerPort, callerKey)}/responses`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "meta/muse-spark-1.3", stream: false, input: "synthetic input" }),
  });
  const text = await result.text();
  assert.equal(result.status, 200, text);
  assert.match(text, /one executed generation/);
  assert.equal(forwarded.length, 2);
  assert.deepEqual(forwarded[0], forwarded[1]);
  assert.equal(executions, 1, "the failed connect did not execute a generation");
  for (originMode of ["spoof", "reset"]) {
    const before = forwarded.length;
    const executedBefore = executions;
    const rejected = await fetch(`${callerBaseUrl(routerPort, callerKey)}/responses`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "meta/muse-spark-1.3", stream: false, input: "synthetic input" }),
    });
    assert.equal(rejected.status, 502, await rejected.text());
    assert.equal(forwarded.length - before, 1, `${originMode} cannot authorize replay even on the known API hop`);
    assert.equal(executions - executedBefore, 1);
  }
  const availabilityPort = await openPort();
  await startRouter(availabilityPort, "availability");
  for (const mode of ["spoof", "reset-once"]) {
    originMode = mode;
    const before = forwarded.length;
    const executedBefore = executions;
    const result = await fetch(`${callerBaseUrl(availabilityPort, callerKey)}/responses`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "meta/muse-spark-1.3", stream: false, input: "synthetic input" }),
    });
    const text = await result.text();
    assert.equal(result.status, mode === "spoof" ? 502 : 200, text);
    const attempts = mode === "spoof" ? 1 : 2;
    assert.equal(forwarded.length - before, attempts, `${mode}: only genuine transport evidence permits availability replay`);
    assert.equal(executions - executedBefore, attempts);
    if (mode === "reset-once") assert.deepEqual(forwarded[before], forwarded[before + 1]);
  }

});
