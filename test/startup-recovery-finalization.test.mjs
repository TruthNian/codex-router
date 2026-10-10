import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { userModelEntry } from "../src/user-models.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

// Load the real entry point, supervisor, child shutdown and exact-promotion
// helper in a fresh process. Replace OS spawn/identity/health and publication I/O:
// the real start() closures, recovery callbacks and finalization are exercised.
const entry = String.raw`
  import { registerHooks } from "node:module";
  import { EventEmitter } from "node:events";
  import { pathToFileURL } from "node:url";
  import path from "node:path";
  const mode = process.env.RECOVERY_FIXTURE_MODE;
  const root = process.cwd();
  const startUrl = pathToFileURL(path.join(root, "src/start.mjs")).href;
  const exact = await import(pathToFileURL(path.join(root, "src/antigravity-probe-activation.mjs")).href);
  const trace = { promotions: [], promoteWrites: 0, rollbackWrites: 0, watches: 0,
    backoffClears: 0, aggregateProbes: 0, activeProof: false, handles: [], maxConcurrent: 0 };
  const current = new Map();
  const counts = new Map();
  let concurrent = 0;
  let releaseHealth;
  let storedGeneration = "captured-proof-generation";
  class Child extends EventEmitter {
    constructor(service, index) {
      super(); this.service = service; this.index = index; this.exitCode = null; this.signalCode = null;
      this.connected = true; this.pid = 990000 + trace.handles.length;
      trace.handles.push(this); current.set(service, this);
    }
    exit(code, signal = null) {
      if (this.exitCode !== null || this.signalCode !== null) return;
      this.exitCode = signal ? null : code; this.signalCode = signal;
      this.connected = false; this.emit("exit", code, signal); this.emit("close", code, signal);
    }
    kill(signal) { this.exit(0, signal); return true; }
    send(message, callback) { queueMicrotask(() => { callback?.(); this.exit(0); }); return true; }
  }
  const fixture = {
    spawn(command, args, options) {
      const name = path.basename(args[0] || "");
      const service = args[0] === "--config" ? "gateway" : name === "router.mjs" ? "router"
        : name === "api-forwarder.mjs" ? "api" : name === "antigravity-oauth-forwarder.mjs" ? "antigravity" : name;
      const index = counts.get(service) || 0; counts.set(service, index + 1);
      const child = new Child(service, index);
      if (Object.keys(options.env).some((key) => /STARTUP_HEALTH_TIMEOUT_MS|GATEWAY_HEALTH_TIMEOUT_MS/.test(key))) {
        throw new Error("startup allowances leaked to a runtime child");
      }
      return child;
    },
    antigravityOAuthStartupState() {
      return { pendingActivationGeneration: "captured-proof-generation", pendingSessionGeneration: "captured-session-generation" };
    },
    async pollHealth({ child, url }) {
      if (new URL(url).pathname === "/health/live") return;
      if (child.service === "router") {
        trace.aggregateProbes += 1;
        if (mode === "shutdown" && trace.aggregateProbes === 1) {
          process.send({ phase: "shutdown-gate" });
          await new Promise((resolve) => { releaseHealth = resolve; });
        }
        // Deliberately stale aggregate success in the dead-required-child
        // negative control: individual current-child evidence must still win.
        if (["dead-required", "missing-gateway"].includes(mode)) queueMicrotask(() => process.send({ phase: "blocked" }));
        return;
      }
      const initiallyFails = child.service === "antigravity" && mode === "dead-required" || child.index === 0 && (
        child.service === "api" && mode !== "initial" && mode !== "gateway"
        || child.service === "antigravity" && ["concurrent", "dead-required"].includes(mode)
        || child.service === "gateway" && mode === "gateway"
      );
      if (initiallyFails) {
        child.exit(1); throw new Error(child.service + " exited before becoming healthy.");
      }
      if (mode === "superseded" && child.service === "api" && child.index === 1) storedGeneration = "newer-proof-generation";
      if (mode === "rollback-safe" && child.service === "api" && child.index === 2) {
        process.send({ phase: "safe-rollback-observed" });
        await new Promise((resolve) => { releaseHealth = resolve; });
      }
      return;
    },
    async promote(options) {
      concurrent += 1; trace.maxConcurrent = Math.max(trace.maxConcurrent, concurrent);
      trace.promotions.push({ generation: options.generation, sessionGeneration: options.sessionGeneration,
        bootstrap: process.env.CODEX_ROUTER_STARTUP_HEALTH_TIMEOUT_MS,
        children: options.children.map((child) => ({ service: child.service, index: child.index, code: child.exitCode })) });
      try {
        return await exact.attemptAntigravityProbePromotionAfterReadiness({ ...options,
          promote: async (generation, sessionGeneration) => {
            if (generation !== storedGeneration || sessionGeneration !== "captured-session-generation") return false;
            trace.promoteWrites += 1; trace.activeProof = true;
            await new Promise((resolve) => setTimeout(resolve, 20));
            if (["rollback-fatal", "rollback-safe"].includes(mode)) current.get("api").exit(1);
            return true;
          },
          rollback: async (generation, sessionGeneration) => {
            if (generation !== "captured-proof-generation" || sessionGeneration !== "captured-session-generation") throw new Error("wrong rollback generation");
            trace.rollbackWrites += 1;
            if (mode === "rollback-safe") { trace.activeProof = false; return true; }
            return false;
          },
        });
      } finally { concurrent -= 1; }
    },
    clearBackoff() {
      if (process.env.CODEX_ROUTER_STARTUP_HEALTH_TIMEOUT_MS !== undefined) throw new Error("bootstrap allowance remained during runtime publication");
      trace.backoffClears += 1;
    },
    watch() {
      if (process.env.CODEX_ROUTER_STARTUP_HEALTH_TIMEOUT_MS !== undefined) throw new Error("bootstrap allowance remained during runtime publication");
      trace.watches += 1; process.send({ phase: "finalized" }); return () => {};
    },
  };
  globalThis.recoveryFixture = fixture;
  process.on("message", (message) => {
    if (message.type === "model-router:shutdown") releaseHealth?.();
  });
  registerHooks({ load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url.endsWith("/native-catalog-drift.mjs")) {
      return { ...result, source: "export const watchNativeCatalog = () => globalThis.recoveryFixture.watch();" };
    }
    if (url.endsWith("/native-catalog-events.mjs")) {
      return { ...result, source: "export const subscribeNativeCatalogEvents = () => () => {};" };
    }
    if (url !== startUrl) return result;
    let source = Buffer.from(result.source).toString();
    for (const [before, after] of [
      ['import { spawn } from "node:child_process";', 'const { spawn } = globalThis.recoveryFixture;'],
      ['import { waitForHealth as pollHealth } from "./health-probe.mjs";', 'const { pollHealth } = globalThis.recoveryFixture;'],
      ['import { antigravityOAuthStartupState } from "./antigravity-oauth-status.mjs";', 'const { antigravityOAuthStartupState } = globalThis.recoveryFixture;'],
      ['import { attemptAntigravityProbePromotionAfterReadiness } from "./antigravity-probe-activation.mjs";', 'const attemptAntigravityProbePromotionAfterReadiness = globalThis.recoveryFixture.promote;'],
    ]) {
      if (!source.includes(before)) throw new Error("fixture source boundary disappeared: " + before);
      source = source.replace(before, after);
    }
    source = source.replaceAll("clearStartupAttempts();", "globalThis.recoveryFixture.clearBackoff();");
    // This controlled entry uses --eval, not the OS-managed start.mjs command
    // line. Process-record identity has separate real OS tests; no fabricated
    // managed PID record should be written by this lifecycle fixture.
    if (!source.includes("if (shouldRecordServiceProcess()) {")) throw new Error("fixture identity boundary disappeared");
    source = source.replace("if (shouldRecordServiceProcess()) {", "if (false) {");
    return { ...result, source };
  }});
  await import(startUrl);
  trace.bootstrapRetired = process.env.CODEX_ROUTER_STARTUP_HEALTH_TIMEOUT_MS === undefined;
  trace.handles = trace.handles.map(({ service, index, exitCode }) => ({ service, index, exitCode }));
  process.stdout.write(JSON.stringify(trace) + "\n");
`;

async function run(mode) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "startup-finalization-"));
  const state = path.join(directory, "state");
  const home = path.join(directory, "codex");
  mkdirSync(state, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(state, "internal-secret"), "synthetic-finalization-internal-secret-long\n");
  writeFileSync(path.join(state, "caller-secret"), "synthetic-finalization-caller-capability-long\n");
  writeFileSync(path.join(state, "enabled-providers.json"), JSON.stringify({ version: 1, providers: [] }));
  writeFileSync(path.join(state, "generic-providers.json"), JSON.stringify({ version: 1, providers: [{
    id: "recovery-api", displayName: "Synthetic recovery provider", baseUrl: "http://127.0.0.1:9/v1",
    adapter: ["gateway", "missing-gateway"].includes(mode) ? "openai-chat" : "openai-responses", headers: { "X-Tenant": "synthetic" }, allowPrivate: true, enabled: true,
  }] }));
  writeFileSync(path.join(state, "user-models.json"), JSON.stringify({ version: 1,
    models: [userModelEntry({ providerId: "recovery-api", upstreamId: "synthetic-model", priority: 100 })] }));
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(MODEL_ROUTER_|CODEX_ROUTER_|ROUTER_PLANE_)/.test(name) || /(?:API_KEY|TOKEN|SECRET)$/i.test(name)) delete env[name];
  }
  Object.assign(env, {
    CODEX_HOME: home, HOME: directory, USERPROFILE: directory, APPDATA: path.join(directory, "AppData", "Roaming"), LOCALAPPDATA: path.join(directory, "AppData", "Local"),
    MODEL_ROUTER_STATE_DIR: state, CODEX_ROUTER_STATE_DIR: state, MODEL_ROUTER_TARGET: "codex",
    CODEX_ROUTER_SHOW_ALL_MODELS: "0", CODEX_ROUTER_NO_DISCOVERY: "1", CODEX_ROUTER_SERVICE_PLATFORM: "test-fixture",
    MODEL_ROUTER_LITELLM_BIN: mode === "missing-gateway" ? path.join(directory, "absent-litellm") : process.execPath, CODEX_NATIVE_BASE_URL: "http://127.0.0.1:9/unused-native",
    CODEX_ROUTER_GATEWAY_RESTART_BACKOFF_MS: "1", CODEX_ROUTER_STARTUP_HEALTH_TIMEOUT_MS: "2000",
    MODEL_ROUTER_SHUTDOWN_DRAIN_MS: "10", MODEL_ROUTER_SHUTDOWN_FLUSH_MS: "10", RECOVERY_FIXTURE_MODE: mode,
    NODE_USE_ENV_PROXY: "0",
  });
  const child = spawn(process.execPath, ["--input-type=module", "--eval", entry], {
    cwd: root, env, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true,
  });
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { errors += chunk; });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  let shutdownSent = false;
  child.on("message", () => {
    if (child.connected && !shutdownSent) { shutdownSent = true; child.send({ type: "model-router:shutdown" }); }
  });
  let timer;
  try {
    const exit = await Promise.race([exited, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("owned finalization fixture stalled: " + errors)), 8_000);
    })]);
    const trace = JSON.parse(output.trim().split("\n").at(-1));
    return { ...exit, trace, errors };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) && path.basename(resolved).startsWith("startup-finalization-"));
    rmSync(resolved, { recursive: true, force: true });
  }
}

for (const mode of ["initial", "recovery", "concurrent", "gateway"]) {
  test(`${mode} readiness finalizes the captured proof with current dependency handles`, async () => {
    const result = await run(mode);
    assert.equal(result.code, 0, result.errors);
    assert.equal(result.trace.promotions.length, 1, result.errors);
    assert.equal(result.trace.promoteWrites, 1);
    assert.equal(result.trace.activeProof, true);
    assert.equal(result.trace.maxConcurrent, 1);
    assert.equal(result.trace.watches, 1);
    assert.equal(result.trace.bootstrapRetired, true);
    const promotion = result.trace.promotions[0];
    assert.equal(promotion.generation, "captured-proof-generation");
    assert.equal(promotion.sessionGeneration, "captured-session-generation");
    assert.ok(promotion.children.every((child) => child.code === null));
    if (mode !== "initial") assert.equal(promotion.bootstrap, undefined, "recovery must use the retired runtime environment");
    if (["recovery", "concurrent"].includes(mode)) assert.equal(promotion.children.find((child) => child.service === "api").index, 1);
    if (mode === "concurrent") assert.equal(promotion.children.find((child) => child.service === "antigravity").index, 1);
    if (mode === "gateway") assert.equal(promotion.children.find((child) => child.service === "gateway").index, 1);
    assert.ok(result.trace.handles.every((child) => child.exitCode !== null), "all historical/current handles remain owned for shutdown");
  });
}

test("an exited required child defeats stale aggregate health instead of being omitted", async () => {
  const result = await run("dead-required");
  assert.equal(result.code, 0, result.errors);
  assert.equal(result.trace.promotions.length, 0);
  assert.equal(result.trace.watches, 0);
  assert.equal(result.trace.bootstrapRetired, true);
  assert.match(result.errors, /dependency readiness lost its current child/);
});

test("a required gateway that was never spawned cannot be omitted during another service's recovery", async () => {
  const result = await run("missing-gateway");
  assert.equal(result.code, 0, result.errors);
  assert.equal(result.trace.promotions.length, 0);
  assert.equal(result.trace.watches, 0);
  assert.equal(result.trace.bootstrapRetired, true);
  assert.match(result.errors, /gateway unavailable: LiteLLM is not installed/);
  assert.match(result.errors, /dependency readiness lost its current child/);
});

test("a newer proof does not replace the captured activation generation during recovery", async () => {
  const result = await run("superseded");
  assert.equal(result.code, 0, result.errors);
  assert.equal(result.trace.promotions[0].generation, "captured-proof-generation");
  assert.equal(result.trace.promoteWrites, 0);
  assert.equal(result.trace.activeProof, false);
  assert.match(result.errors, /activation was superseded/);
});

test("a recovery promotion whose exact rollback remains unconfirmed terminates the service", async () => {
  const result = await run("rollback-fatal");
  assert.equal(result.code, 1, result.errors);
  assert.equal(result.trace.promoteWrites, 1);
  assert.equal(result.trace.rollbackWrites, 2, "the real promotion helper retains its one exact rollback retry");
  assert.equal(result.trace.watches, 0);
  assert.equal(result.trace.backoffClears, 0);
  assert.match(result.errors, /startup failed: Antigravity live-proof activation rollback was not confirmed/);
  assert.doesNotMatch(result.errors, /did not come back: Antigravity/);
});

test("a successful exact rollback after a child death cannot finalize stale readiness or publish", async () => {
  const result = await run("rollback-safe");
  assert.equal(result.code, 0, result.errors);
  assert.equal(result.trace.promoteWrites, 1);
  assert.equal(result.trace.rollbackWrites, 1);
  assert.equal(result.trace.activeProof, false);
  assert.equal(result.trace.watches, 0);
  assert.equal(result.trace.backoffClears, 0);
  assert.match(result.errors, /dependency changed during activation/);
});

test("shutdown during recovered aggregate readiness cannot promote, clear backoff, or publish", async () => {
  const result = await run("shutdown");
  assert.equal(result.code, 0, result.errors);
  assert.equal(result.trace.promotions.length, 0);
  assert.equal(result.trace.watches, 0);
  assert.equal(result.trace.backoffClears, 0);
  assert.equal(result.trace.bootstrapRetired, true);
});
