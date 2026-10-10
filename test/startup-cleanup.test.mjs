import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { writePrivateJson } from "../src/file-security.mjs";
import { freePort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function isolatedEnvironment(directory, stateDir) {
  const runtimeNames = new Set(["PATH", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "TEMP", "TMP",
    "PSModulePath", "SystemDrive", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"]
    .map((name) => name.toLowerCase()));
  const runtime = Object.fromEntries(Object.entries(process.env).filter(([name]) => runtimeNames.has(name.toLowerCase())));
  const user = path.join(directory, "user");
  const home = path.join(directory, "codex-home");
  for (const folder of [user, home, path.join(user, "AppData", "Roaming"), path.join(user, "AppData", "Local")]) {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
  }
  const registry = path.join(directory, "registry.json");
  writeFileSync(registry, JSON.stringify({ version: 1, providers: [{ id: "custom", displayName: "Fixture custom",
    kind: "openai-compatible", ownedBy: "fixture", perModelEndpoint: true, authMode: "per-model" }],
    models: [{ slug: "custom/gateway-fixture", gatewayModel: "gateway-fixture", upstreamModel: "gateway-fixture",
      provider: "custom", listed: false, endpoint: { protocol: "openai", keyless: true,
        baseUrl: "http://127.0.0.1:9999/v1" } }] }));
  writeFileSync(path.join(stateDir, "enabled-providers.json"), JSON.stringify({ version: 1, providers: ["custom"] }));
  return { ...runtime, HOME: user, USERPROFILE: user, CODEX_HOME: home,
    APPDATA: path.join(user, "AppData", "Roaming"), LOCALAPPDATA: path.join(user, "AppData", "Local"),
    KIMI_CODE_HOME: path.join(directory, "kimi"), MODEL_ROUTER_STATE_DIR: stateDir, CODEX_ROUTER_STATE_DIR: stateDir,
    MODEL_ROUTER_REGISTRY: registry, MODEL_ROUTER_USER_MODELS: path.join(stateDir, "user-models.json"),
    MODEL_ROUTER_GENERIC_PROVIDERS: path.join(stateDir, "generic-providers.json"),
    CODEX_ROUTER_SOURCE_ROOT: root, CODEX_ROUTER_NO_DISCOVERY: "0", NO_DISCOVERY: "0",
    MODEL_ROUTER_SHOW_ALL_MODELS: "0", CODEX_ROUTER_SHOW_ALL_MODELS: "0",
    CODEX_ROUTER_SERVICE_PLATFORM: "test-fixture", CODEX_ROUTER_NATIVE_SESSION_FALLBACK: "0" };
}

async function waitForDegraded(child, routerPort, readErrors) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    assert.equal(child.exitCode, null, readErrors());
    try {
      const health = await fetch(`http://127.0.0.1:${routerPort}/health`, { signal: AbortSignal.timeout(2_000) });
      const live = await fetch(`http://127.0.0.1:${routerPort}/health/live`, { signal: AbortSignal.timeout(2_000) });
      if (health.status === 503 && live.status === 200 && /serving independent routes/.test(readErrors())) {
        return health.json();
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`degraded service did not stay live:\n${readErrors()}`);
}

async function stopSupervisor(child, readErrors) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  child.send({ type: "model-router:shutdown" });
  let timer;
  try {
    const result = await Promise.race([exited, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`IPC shutdown did not finish:\n${readErrors()}`)), 15_000);
    })]);
    assert.equal(result.signal, null, readErrors());
    assert.equal(result.code, 0, readErrors());
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.connected) child.disconnect();
  }
}

// On loopback this settles either way in microseconds: a live listener accepts,
// and a closed port refuses. A socket that does neither is not a third answer
// this test can interpret, so bound it rather than letting it hang until the
// outer test timeout turns a clear result into a mystery.
const PORT_PROBE_TIMEOUT_MS = 2_000;

async function portIsClosed(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    const settle = (closed) => {
      socket.destroy();
      resolve(closed);
    };
    socket.setTimeout(PORT_PROBE_TIMEOUT_MS, () => settle(false));
    socket.once("connect", () => settle(false));
    socket.once("error", () => settle(true));
  });
}

test("a degraded gateway preserves independent routes and leaves its pending Antigravity proof inactive", { timeout: 120_000 }, async () => {
  const ports = await Promise.all(Array.from({ length: 6 }, () => freePort()));
  assert.equal(new Set(ports).size, ports.length);
  const [routerPort, gatewayPort, oauthPort, apiPort, grokOauthPort, antigravityPort] = ports;
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "model-router-startup-cleanup-"));
  const stateDir = path.join(rootDir, "state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(stateDir, "internal-secret"), "startup-internal-key-with-sufficient-length\n", { mode: 0o600 });
  writeFileSync(path.join(stateDir, "caller-secret"), "startup-caller-key-with-sufficient-length\n", { mode: 0o600 });
  const antigravityTokenPath = path.join(stateDir, "antigravity-oauth.json");
  const activationGeneration = "77777777-7777-4777-8777-777777777777";
  writePrivateJson(antigravityTokenPath, {
    version: 3,
    managed_by: "codex-router",
    session_generation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    client_id: "startup-test.apps.googleusercontent.com",
    client_secret: "startup-antigravity-client-secret",
    access_token: "startup-antigravity-access-token",
    refresh_token: "startup-antigravity-refresh-token",
    expires_at: Math.floor(Date.now() / 1_000) + 3600,
    expires_in: 3600,
    project_id: "startup-managed-project",
    project_source: "managed",
    probe_version: 1,
    probe_verified_at: Date.now(),
    probe_model: "gemini-3.1-pro",
    probe_activation: {
      version: 1,
      state: "pending_activation",
      generation: activationGeneration,
    },
  });

  const child = spawn(process.execPath, [path.join(root, "src", "start.mjs")], {
    cwd: root,
    env: {
      ...isolatedEnvironment(rootDir, stateDir),
      MODEL_ROUTER_TARGET: "codex",
      MODEL_ROUTER_STATE_DIR: stateDir,
      MODEL_ROUTER_PORT: String(routerPort),
      MODEL_ROUTER_GATEWAY_PORT: String(gatewayPort),
      MODEL_ROUTER_OAUTH_PORT: String(oauthPort),
      MODEL_ROUTER_API_PORT: String(apiPort),
      MODEL_ROUTER_GROK_OAUTH_PORT: String(grokOauthPort),
      MODEL_ROUTER_ANTIGRAVITY_OAUTH_PORT: String(antigravityPort),
      MODEL_ROUTER_LITELLM_BIN: process.execPath,
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let errors = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });

  try {
    const health = await waitForDegraded(child, routerPort, () => errors);
    assert.ok(health.degraded.includes("gateway"));
    assert.deepEqual(health.executionPlan.services, ["antigravity", "api", "gateway"]);
    assert.match(
      errors,
      /dependency unavailable: LiteLLM gateway exited before becoming healthy\./,
    );
    assert.match(errors, /\[antigravity-oauth\] listening/);
    assert.doesNotMatch(errors, /startup-internal-key-with-sufficient-length/);
    assert.doesNotMatch(errors, /startup-caller-key-with-sufficient-length/);
    assert.doesNotMatch(errors, /startup-antigravity-client-secret/);
    assert.doesNotMatch(errors, /startup-antigravity-access-token/);
    assert.doesNotMatch(errors, /startup-antigravity-refresh-token/);
    const stored = JSON.parse(readFileSync(antigravityTokenPath, "utf8"));
    assert.deepEqual(stored.probe_activation, {
      version: 1,
      state: "pending_activation",
      generation: activationGeneration,
    });
    await stopSupervisor(child, () => errors);
    for (const port of [routerPort, oauthPort, apiPort, grokOauthPort, antigravityPort]) {
      assert.equal(await portIsClosed(port), true, `orphaned child still owns port ${port}`);
    }
  } finally {
    try { await stopSupervisor(child, () => errors); }
    finally { rmSync(rootDir, { recursive: true, force: true }); }
  }
});

// `codex-router.ps1 start --foreground` and `bin/start --foreground` enter
// through src/foreground-start.mjs. On Windows that entry used to claim the
// managed service-process record, whose entrypoint check only accepts a command
// line naming src/start.mjs, so it died with "could not verify its own start.mjs
// process identity" before it spawned anything. Boot it the way the test above
// boots the service payload and require it to get as far as the gateway.
test("the foreground supervisor boots past the Windows service-process record", { timeout: 120_000 }, async () => {
  const ports = await Promise.all(Array.from({ length: 6 }, () => freePort()));
  assert.equal(new Set(ports).size, ports.length);
  const [routerPort, gatewayPort, oauthPort, apiPort, grokOauthPort, antigravityPort] = ports;
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "model-router-foreground-start-"));
  const stateDir = path.join(rootDir, "state");
  const codexHome = path.join(rootDir, "codex-home");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(stateDir, "internal-secret"), "foreground-internal-key-with-sufficient-length\n", { mode: 0o600 });
  writeFileSync(path.join(stateDir, "caller-secret"), "foreground-caller-key-with-sufficient-length\n", { mode: 0o600 });

  const child = spawn(process.execPath, [path.join(root, "src", "foreground-start.mjs")], {
    cwd: root,
    env: {
      ...isolatedEnvironment(rootDir, stateDir),
      MODEL_ROUTER_TARGET: "codex",
      MODEL_ROUTER_STATE_DIR: stateDir,
      MODEL_ROUTER_PORT: String(routerPort),
      MODEL_ROUTER_GATEWAY_PORT: String(gatewayPort),
      MODEL_ROUTER_OAUTH_PORT: String(oauthPort),
      MODEL_ROUTER_API_PORT: String(apiPort),
      MODEL_ROUTER_GROK_OAUTH_PORT: String(grokOauthPort),
      MODEL_ROUTER_ANTIGRAVITY_OAUTH_PORT: String(antigravityPort),
      MODEL_ROUTER_LITELLM_BIN: process.execPath,
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let errors = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });

  try {
    const health = await waitForDegraded(child, routerPort, () => errors);
    assert.ok(health.degraded.includes("gateway"));
    assert.doesNotMatch(errors, /could not verify its own start\.mjs process identity/);
    assert.match(errors, /dependency unavailable: LiteLLM gateway exited before becoming healthy\./);
  } finally {
    try { await stopSupervisor(child, () => errors); }
    finally { rmSync(rootDir, { recursive: true, force: true }); }
  }
});
