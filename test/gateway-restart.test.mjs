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
  const home = path.join(directory, "codex");
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

async function stopSupervisor(child, errors) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  child.send({ type: "model-router:shutdown" });
  let timer;
  try {
    const result = await Promise.race([exited, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`supervisor did not finish IPC shutdown:\n${errors()}`)), 15_000);
    })]);
    assert.equal(result.signal, null, errors());
    assert.equal(result.code, 0, errors());
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.connected) child.disconnect();
  }
}

async function waitForClosedPort(port) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const closed = await new Promise((resolve) => {
      const socket = net.connect(port, "127.0.0.1");
      const finish = (result) => { socket.destroy(); resolve(result); };
      socket.setTimeout(2_000, () => finish(false));
      socket.once("connect", () => finish(false));
      socket.once("error", () => finish(true));
    });
    if (closed) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`owned fixture listener still owns port ${port} after supervisor shutdown`);
}

// Issue #261: LiteLLM's exception mapping raised out of the request handler on
// an upstream 429 and the proxy exited 1. start.mjs raced every child's exit,
// so that single bad response took the router and all three forwarders down and
// every client saw a bare "Connection error" from then on.
//
// The gateway here is a stand-in that answers the liveliness probe and exits 1
// when asked, which is the only part of LiteLLM's behaviour this has to
// reproduce -- the defect was never in what killed the gateway, it was in what
// the service did afterwards.
//
// It is reached through a launcher rather than directly because the real
// `MODEL_ROUTER_LITELLM_BIN` is a launcher: `.venv/bin/litellm` on POSIX and
// `.venv\Scripts\litellm.exe` on Windows. A `.cmd` is the closest a test can
// get to the second without shipping a PE binary, and Node refuses to spawn one
// without a shell (CVE-2024-27980) -- which is exactly the gap
// `spawnableCommand` closes in `start.mjs`, so exercising it here is the point
// rather than an accident.
function writeFakeGateway(directory, script) {
  const windows = process.platform === "win32";
  const target = path.join(directory, windows ? "fake-gateway.cmd" : "fake-gateway");
  writeFileSync(
    target,
    windows
      ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
      : `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    script,
    `import { createServer } from "node:http";
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
createServer((request, response) => {
  const url = request.url || "";
  if (url.startsWith("/crash") || url.startsWith("/quit")) {
    response.writeHead(200).end("stopping");
    // Exactly what LiteLLM did: the process ends, mid-request, with code 1.
    // /quit is the teardown door -- on Windows the launcher is a batch shim, so
    // the service holds the cmd.exe hop rather than this process, and a signal
    // to the hop would leave this one alive holding the port.
    setTimeout(() => process.exit(url.startsWith("/quit") ? 0 : 1), 10);
    return;
  }
  response.writeHead(200, { "content-type": "application/json" }).end('{"status":"healthy"}');
}).listen(port, "127.0.0.1");
`,
    { mode: 0o600 },
  );
  return target;
}

async function get(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    return { status: response.status, body: await response.text() };
  } catch (error) {
    return { status: 0, body: error instanceof Error ? error.message : String(error) };
  }
}

// Fails as soon as the service exits rather than waiting out the budget: a
// startup that died in the first second used to be reported sixty seconds later
// as "never saw ..." with no exit status, which is a mystery rather than a
// diagnosis. The exit status is what names the failure -- a Windows `spawn
// EINVAL` on the batch launcher reads nothing like a health-probe timeout.
function waitFor(readErrors, readExit, pattern, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = setInterval(() => {
      const errors = readErrors();
      if (pattern.test(errors)) {
        clearInterval(poll);
        resolve();
        return;
      }
      const exit = readExit();
      if (exit) {
        clearInterval(poll);
        reject(
          new Error(
            `the service exited (code=${String(exit.code)}, signal=${String(exit.signal)}) ` +
              `before ${pattern}; stderr:\n${errors || "(the service produced no output at all)"}`,
          ),
        );
        return;
      }
      if (Date.now() >= deadline) {
        clearInterval(poll);
        reject(
          new Error(
            `never saw ${pattern} in ${timeoutMs} ms; the service is still running; ` +
              `stderr:\n${errors || "(the service produced no output at all)"}`,
          ),
        );
      }
    }, 100);
  });
}

test("a ready stack activates its exact pending proof and survives a gateway restart", { timeout: 180_000 }, async () => {
  const ports = await Promise.all(Array.from({ length: 6 }, () => freePort()));
  assert.equal(new Set(ports).size, ports.length);
  const [routerPort, gatewayPort, oauthPort, apiPort, grokOauthPort, antigravityPort] = ports;
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "model-router-gateway-restart-"));
  const stateDir = path.join(rootDir, "state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const callerKey = "gateway-restart-caller-key-with-sufficient-length";
  writeFileSync(path.join(stateDir, "internal-secret"), "gateway-restart-internal-key-with-sufficient-length\n", { mode: 0o600 });
  writeFileSync(path.join(stateDir, "caller-secret"), `${callerKey}\n`, { mode: 0o600 });
  const activationGeneration = "88888888-8888-4888-8888-888888888888";
  const antigravityTokenPath = path.join(stateDir, "antigravity-oauth.json");
  writePrivateJson(antigravityTokenPath, {
    version: 3,
    managed_by: "codex-router",
    session_generation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    client_id: "gateway-restart.apps.googleusercontent.com",
    client_secret: "gateway-restart-antigravity-client-secret",
    access_token: "gateway-restart-antigravity-access-token",
    refresh_token: "gateway-restart-antigravity-refresh-token",
    expires_at: Math.floor(Date.now() / 1_000) + 3600,
    expires_in: 3600,
    project_id: "gateway-restart-managed-project",
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
  const gatewayBin = writeFakeGateway(rootDir, path.join(rootDir, "fake-gateway.mjs"));

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
      MODEL_ROUTER_LITELLM_BIN: gatewayBin,
      // Keep the backoff out of the run time; the sequencing is what matters.
      CODEX_ROUTER_GATEWAY_RESTART_BACKOFF_MS: "50",
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let errors = "";
  let exited;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  child.once("exit", (code, signal) => {
    exited = { code, signal };
  });

  const readExit = () => exited;
  try {
    await waitFor(() => errors, readExit, /\[codex-router\] ready \(authenticated loopback endpoint\)/);
    assert.equal((await get(`http://127.0.0.1:${routerPort}/health`)).status, 200, errors);
    assert.deepEqual(JSON.parse(readFileSync(antigravityTokenPath, "utf8")).probe_activation, {
      version: 1,
      state: "active",
      generation: activationGeneration,
    });

    // Kill the gateway the way a bad upstream response did.
    await get(`http://127.0.0.1:${gatewayPort}/crash`);

    await waitFor(
      () => errors,
      readExit,
      /\[codex-router\] LiteLLM gateway exited \(code=1, signal=null\); restarting in 50 ms \(restart 1 of 5\)/,
    );
    assert.match(errors, /The router stays up/);
    await waitFor(
      () => errors,
      readExit,
      /\[codex-router\] LiteLLM gateway is healthy again after 1 restart\(s\)\./,
    );

    assert.equal(exited, undefined, `the service exited when the gateway crashed:\n${errors}`);
    const health = await get(`http://127.0.0.1:${routerPort}/health`);
    assert.equal(health.status, 200, `the router stopped serving:\n${errors}`);
    assert.doesNotMatch(errors, /gateway-restart-internal-key-with-sufficient-length/);
    assert.doesNotMatch(errors, /gateway-restart-caller-key-with-sufficient-length/);
    assert.doesNotMatch(errors, /gateway-restart-antigravity-client-secret/);
    assert.doesNotMatch(errors, /gateway-restart-antigravity-access-token/);
    assert.doesNotMatch(errors, /gateway-restart-antigravity-refresh-token/);
  } finally {
    try {
      await stopSupervisor(child, () => errors);
    } finally {
      // The owned batch shim cannot forward Node IPC to its gateway child.
      // Stop only this fixture's known endpoint after supervisor restart has
      // ended, including when the bounded root-exit assertion failed.
      await get(`http://127.0.0.1:${gatewayPort}/quit`);
      await Promise.all([routerPort, gatewayPort, apiPort, antigravityPort].map(waitForClosedPort));
      rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
});

// The Windows half of the launch cannot be exercised on POSIX -- the batch shim
// is pass-through here -- so the wiring is asserted directly. Without it, a
// refactor that spawned the gateway straight from `spawn()` again would go green
// on ubuntu and macos and fail only on the Windows job, which is how this was
// found. `spawnableCommand`'s own conversion is covered by
// test/spawnable-command.test.mjs.
test("start.mjs launches every child through the Windows-safe spawn helper", () => {
  const source = readFileSync(path.join(root, "src", "start.mjs"), "utf8");
  assert.match(source, /import \{ spawnableCommand \} from "\.\/spawnable-command\.mjs";/);
  const runBody = /function run\([\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.match(runBody, /spawnableCommand\(command, args\)/);
  assert.match(runBody, /spawn\(spawnable\.command, spawnable\.args,/);
  assert.match(runBody, /\.\.\.spawnable\.options,/);
  // A bare `spawn(command, args` in the launcher is the exact shape that
  // answers a `.cmd` launcher with EINVAL and takes the service down.
  assert.doesNotMatch(runBody, /spawn\(command, args/);
});

// A failed startup must still hand its supervisor a real exit code (#370).
// Terminating synchronously with process.exit() races libuv's Windows
// async-handle close path and can abort with UV_HANDLE_CLOSING (0xC0000409),
// discarding the code an EADDRINUSE forwarder was trying to report. The
// launcher therefore records `process.exitCode` and lets Node drain its child
// bookkeeping; this pins that shape so the drain cannot be refactored away.
test("start.mjs ends by draining libuv, never by exiting mid-teardown", () => {
  const source = readFileSync(path.join(root, "src", "start.mjs"), "utf8");
  // Anchored to column zero: only a top-level exit call reintroduces the
  // abort race this contract exists to prevent.
  assert.doesNotMatch(source, /^process\.exit\(/m);
  assert.doesNotMatch(source, /return process\.exit\(/);
  assert.match(source, /process\.exitCode = exitCode;/);
});
