import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { freePort } from "./port-pool.mjs";
import { userModelEntry } from "../src/user-models.mjs";
import { callerBaseUrl } from "../src/caller-auth.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTERNAL_KEY = "devin-gate-internal-key-with-sufficient-length";
const CALLER_KEY = "devin-gate-caller-key-with-sufficient-length";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Drive the real supervisor and selected forwarders. Node deliberately fails
// LiteLLM's command line on selected Devin routes. The Router must still serve
// an independent native turn, while /health reports the missing dependencies.
// A native-only generation needs no gateway process at all.

async function squat(port) {
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return { server, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function eventually(read, accepts, child, errors) {
  const deadline = Date.now() + 10_000;
  let value;
  while (Date.now() < deadline) {
    assert.equal(child.exitCode, null, `owned supervisor exited early: ${errors()}`);
    try {
      value = await read();
      if (accepts(value)) return value;
    } catch { /* The owned listener may still be starting. */ }
    await delay(25);
  }
  throw new Error(`owned stack did not settle: ${JSON.stringify(value)} ${errors()}`);
}

async function controlledStop(child, exited) {
  if (child.exitCode !== null || child.signalCode !== null) return exited;
  child.send({ type: "model-router:shutdown" });
  let timer;
  try {
    return await Promise.race([
      exited,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("owned supervisor did not drain after IPC shutdown")), 5_000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function runStartup({ curatedDevinModel = false, occupyDevinPort = false } = {}) {
  const ports = await Promise.all(Array.from({ length: 7 }, () => freePort()));
  assert.equal(new Set(ports).size, ports.length);
  const [routerPort, gatewayPort, oauthPort, apiPort, grokOauthPort, devinPort, antigravityPort] = ports;
  const directory = mkdtempSync(path.join(os.tmpdir(), "model-router-devin-gate-"));
  const stateDir = path.join(directory, "state");
  const codexHome = path.join(directory, "codex");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(stateDir, "internal-secret"), `${INTERNAL_KEY}\n`, { mode: 0o600 });
  writeFileSync(path.join(stateDir, "caller-secret"), `${CALLER_KEY}\n`, { mode: 0o600 });
  writeFileSync(path.join(stateDir, "enabled-providers.json"), JSON.stringify({ version: 1,
    providers: curatedDevinModel ? ["devin-cli"] : [] }), { mode: 0o600 });
  writeFileSync(path.join(stateDir, "user-models.json"), JSON.stringify({ version: 1,
    models: curatedDevinModel ? [userModelEntry({ providerId: "devin-cli", upstreamId: "gate-test-model", priority: 900 })] : [] }), { mode: 0o600 });

  const nativeRequests = [];
  const native = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    nativeRequests.push({ url: request.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "resp_independent_native", object: "response", status: "completed",
      model: "gpt-6.1-sol", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "INDEPENDENT_NATIVE_OK" }] }] }));
  });
  await new Promise((resolve) => native.listen(0, "127.0.0.1", resolve));
  const nativePort = native.address().port;
  const squatter = occupyDevinPort ? await squat(devinPort) : undefined;
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(MODEL_ROUTER_|CODEX_ROUTER_|ROUTER_PLANE_)/.test(name) || /(?:API_KEY|TOKEN|SECRET)$/i.test(name)) delete env[name];
  }
  Object.assign(env, {
    CODEX_HOME: codexHome, HOME: directory, USERPROFILE: directory,
    APPDATA: path.join(directory, "AppData", "Roaming"), LOCALAPPDATA: path.join(directory, "AppData", "Local"),
    MODEL_ROUTER_TARGET: "codex", MODEL_ROUTER_STATE_DIR: stateDir, CODEX_ROUTER_STATE_DIR: stateDir,
    MODEL_ROUTER_PORT: String(routerPort), MODEL_ROUTER_GATEWAY_PORT: String(gatewayPort),
    MODEL_ROUTER_OAUTH_PORT: String(oauthPort), MODEL_ROUTER_API_PORT: String(apiPort),
    MODEL_ROUTER_GROK_OAUTH_PORT: String(grokOauthPort), MODEL_ROUTER_DEVIN_CLI_PORT: String(devinPort),
    MODEL_ROUTER_ANTIGRAVITY_OAUTH_PORT: String(antigravityPort), MODEL_ROUTER_LOCAL_BASE_URL: "http://127.0.0.1:9/v1",
    // Native forwarding is deliberately disabled by --no-discovery, even for
    // an explicit local base. Enable it only inside these synthetic homes;
    // all transport/health ports and the sole upstream are fixture-owned.
    CODEX_ROUTER_SHOW_ALL_MODELS: "0", CODEX_ROUTER_NO_DISCOVERY: "0", CODEX_ROUTER_SERVICE_PLATFORM: "test-fixture",
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${nativePort}/native`, MODEL_ROUTER_NATIVE_TRANSPORT: "http",
    MODEL_ROUTER_LITELLM_BIN: process.execPath, CODEX_ROUTER_GATEWAY_RESTARTS: "0",
    MODEL_ROUTER_SHUTDOWN_DRAIN_MS: "100", MODEL_ROUTER_SHUTDOWN_FLUSH_MS: "100", NODE_USE_ENV_PROXY: "0",
  });
  const child = spawn(process.execPath, [path.join(root, "src", "start.mjs")], {
    cwd: root, env, stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true,
  });
  let errors = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { errors += chunk; });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  try {
    const health = await eventually(async () => {
      const response = await fetch(`${callerBaseUrl(routerPort, CALLER_KEY)}/health`, { signal: AbortSignal.timeout(500) });
      return { status: response.status, body: await response.json() };
    }, (value) => value.body.executionPlan && (curatedDevinModel
      ? value.status === 503 && value.body.degraded.includes("gateway") && value.body.devinCli.reachable === !occupyDevinPort
      : value.status === 200), child, () => errors);
    await eventually(async () => errors, (value) => curatedDevinModel
      ? value.includes("serving independent routes") : value.includes("ready (authenticated loopback endpoint)"), child, () => errors);
    let devinHealth;
    if (curatedDevinModel && !occupyDevinPort) {
      const response = await fetch(`http://127.0.0.1:${devinPort}/health`, {
        headers: { Authorization: `Bearer ${INTERNAL_KEY}` }, signal: AbortSignal.timeout(500),
      });
      assert.equal(response.status, 200);
      devinHealth = await response.json();
      assert.equal(devinHealth.service, "codex-router-devin-cli-forwarder");
    }
    const independent = await fetch(`${callerBaseUrl(routerPort, CALLER_KEY)}/responses`, {
      method: "POST", headers: { "content-type": "application/json", Authorization: "Bearer synthetic-native-credential" },
      body: JSON.stringify({ model: "gpt-6.1-sol", input: "show independent route availability", stream: false }),
      signal: AbortSignal.timeout(2_000),
    });
    assert.equal(independent.status, 200, errors);
    assert.match(await independent.text(), /INDEPENDENT_NATIVE_OK/);
    assert.equal(nativeRequests.length, 1);
    assert.equal(nativeRequests[0].url, "/native/responses");
    assert.equal(nativeRequests[0].body.model, "gpt-6.1-sol");
    assert.equal(child.exitCode, null, "degraded dependencies must leave the owned supervisor serving");
    const squatterHeldPort = squatter?.server.listening;
    const exit = await controlledStop(child, exited);
    assert.deepEqual(exit, { code: 0, signal: null }, errors);
    await assert.rejects(fetch(`http://127.0.0.1:${routerPort}/health/live`, { signal: AbortSignal.timeout(500) }), "owned Router must release its listener after shutdown");
    if (curatedDevinModel && !occupyDevinPort) {
      await assert.rejects(fetch(`http://127.0.0.1:${devinPort}/health`, { signal: AbortSignal.timeout(500) }), "owned Devin child must release its listener after shutdown");
    }
    return { exit, errors, health, devinHealth, squatterHeldPort };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      try { await controlledStop(child, exited); } catch { child.kill("SIGKILL"); await exited; }
    }
    if (squatter) await squatter.close();
    native.closeAllConnections();
    await new Promise((resolve) => native.close(resolve));
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) && path.basename(resolved).startsWith("model-router-devin-gate-"));
    rmSync(resolved, { recursive: true, force: true });
  }
}

test("an install with no curated Devin model spawns no forwarder and binds no port", { timeout: 20_000 }, async () => {
  const { health, errors, squatterHeldPort } = await runStartup({ occupyDevinPort: true });
  assert.deepEqual(health.body.executionPlan.services, []);
  assert.deepEqual(health.body.degraded, []);
  assert.equal(health.body.devinCli.enabled, false);
  assert.doesNotMatch(errors, /\[devin-cli\]|Devin CLI forwarder|LiteLLM gateway/);
  assert.equal(squatterHeldPort, true, "the unselected route must not take the held Devin port");
});

test("a curated Devin model spawns the forwarder and waits on its health", { timeout: 20_000 }, async () => {
  const { health, errors } = await runStartup({ curatedDevinModel: true });
  assert.deepEqual(health.body.executionPlan.services, ["devin", "gateway"]);
  assert.deepEqual(health.body.degraded, ["gateway"]);
  assert.equal(health.body.devinCli.reachable, true);
  assert.match(errors, /\[devin-cli\] listening/);
  assert.match(errors, /dependency unavailable: LiteLLM gateway exited before becoming healthy\./);
});

test("a selected Devin bind failure names its degraded dependency while native routes stay available", { timeout: 20_000 }, async () => {
  const { health, errors, squatterHeldPort } = await runStartup({ curatedDevinModel: true, occupyDevinPort: true });
  assert.deepEqual(health.body.executionPlan.services, ["devin", "gateway"]);
  assert.deepEqual(health.body.degraded, ["devinCli", "gateway"]);
  assert.equal(health.body.devinCli.reachable, false);
  assert.match(errors, /\[devin-cli\] cannot listen: .*already in use/);
  assert.match(errors, /dependency unavailable: Devin CLI forwarder exited before becoming healthy\./);
  assert.equal(squatterHeldPort, true);
});

test("neither secret is echoed while the gate is being decided", { timeout: 20_000 }, async () => {
  const { errors, health } = await runStartup({ curatedDevinModel: true });
  assert.doesNotMatch(errors, new RegExp(`${INTERNAL_KEY}|${CALLER_KEY}`));
  assert.doesNotMatch(JSON.stringify(health), new RegExp(`${INTERNAL_KEY}|${CALLER_KEY}`));
});
