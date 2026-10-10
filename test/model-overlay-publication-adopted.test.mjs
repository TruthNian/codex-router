import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { withModelOverlayLock } from "../src/model-overlay-lock.mjs";
import { publishAdoptedModelOverlayFresh, publishAdoptedModelOverlayPublication,
  verifyAdoptedModelOverlayFresh, verifyAdoptedModelOverlayPublication } from "../src/model-overlay-publication.mjs";
import { runProcessTree } from "../src/process-tree.mjs";
import { userModelEntry } from "../src/user-models.mjs";

const FINGERPRINT = "a".repeat(64);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("an adopted catalog refresh verifies healthy current routes before writing clients", async () => {
  const events = [];
  const before = Date.now();
  const result = await publishAdoptedModelOverlayPublication({
    executionPlan: () => { events.push("plan"); return { fingerprint: FINGERPRINT }; },
    verifyAdoption: async ({ expectedFingerprint, allowOffline, deadline }) => {
      assert.equal(expectedFingerprint, FINGERPRINT);
      assert.equal(allowOffline, false, "catalog maintenance cannot adopt an offline candidate");
      assert.ok(deadline >= before && deadline <= Date.now() + 300_000);
      events.push("verify");
    },
    refreshTargets: async () => { events.push("clients"); return true; },
  });
  assert.deepEqual(events, ["plan", "verify", "plan", "clients"]);
  assert.deepEqual(result, { expectedFingerprint: FINGERPRINT, targetsRefreshed: true });
});

test("staged, offline, degraded or unknown adoption cannot refresh a client", async () => {
  for (const failure of ["staged routes", "offline", "degraded", "unknown ownership"]) {
    await assert.rejects(publishAdoptedModelOverlayPublication({
      executionPlan: () => ({ fingerprint: FINGERPRINT }),
      verifyAdoption: async ({ allowOffline }) => {
        assert.equal(allowOffline, false);
        throw new Error(failure);
      },
      refreshTargets: () => assert.fail("a catalog event must preserve every client on adoption failure"),
    }), new RegExp(failure));
  }
});

test("registry drift after verification still fails before any target write", async () => {
  let reads = 0;
  await assert.rejects(publishAdoptedModelOverlayPublication({
    executionPlan: () => ({ fingerprint: reads++ ? "b".repeat(64) : FINGERPRINT }),
    verifyAdoption: async () => {},
    refreshTargets: () => assert.fail("changed routes must remain unpublished"),
  }), { code: "model_overlay_adoption_failed" });
});

test("the fresh adopted stage owns the model lock and has one finite publication epoch", async (t) => {
  const state = mkdtempSync(path.join(process.env.MODEL_ROUTER_STATE_DIR, "adopted-lock-"));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  let release;
  let entered;
  const locked = new Promise((resolve) => { entered = resolve; });
  const held = withModelOverlayLock(async () => {
    entered();
    await new Promise((resolve) => { release = resolve; });
  }, { stateDir: state });
  await locked;
  let runs = 0;
  let admittedAt;
  const publication = publishAdoptedModelOverlayFresh({
    executable: "/synthetic/node", environment: { MODEL_ROUTER_STATE_DIR: state },
    run: async (_command, args, options) => {
      runs += 1;
      assert.equal(args[1], "--publish-adopted-in-fresh-process");
      assert.equal(options.windowsHide, true);
      assert.ok(options.deadline <= admittedAt + 300_000);
      assert.equal(Number(options.env.CODEX_ROUTER_OPERATION_DEADLINE_MS), options.deadline - 10_000);
      return { status: 0, stdout: JSON.stringify({ expectedFingerprint: FINGERPRINT, targetsRefreshed: true }) };
    },
  });
  admittedAt = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(runs, 0, "the child cannot import a staged registry while a mutation holds the lock");
  release();
  await held;
  assert.equal((await publication).expectedFingerprint, FINGERPRINT);
  assert.equal(runs, 1);
});

test("the read-only adopted guard validates identity without a target publisher", async () => {
  let verified = 0;
  const result = await verifyAdoptedModelOverlayPublication({
    executionPlan: () => ({ fingerprint: FINGERPRINT }),
    verifyAdoption: ({ expectedFingerprint, allowOffline }) => {
      assert.equal(expectedFingerprint, FINGERPRINT);
      assert.equal(allowOffline, false);
      verified += 1;
    },
  });
  assert.deepEqual(result, { expectedFingerprint: FINGERPRINT });
  assert.equal(verified, 1);
});

test("the fresh read-only guard defaults to no lock reentry and performs no publication", async (t) => {
  const state = mkdtempSync(path.join(process.env.MODEL_ROUTER_STATE_DIR, "adopted-verify-"));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  await withModelOverlayLock(() => verifyAdoptedModelOverlayFresh({
    executable: "/synthetic/node", environment: { MODEL_ROUTER_STATE_DIR: state },
    run: async (_command, args) => {
      assert.equal(args[1], "--verify-adopted-in-fresh-process");
      return { status: 0, stdout: JSON.stringify({ expectedFingerprint: FINGERPRINT }) };
    },
  }), { stateDir: state });
  assert.equal(existsSync(path.join(state, "merged-models.json")), false);
  assert.equal(existsSync(path.join(state, "litellm.yaml")), false);
});

test("a caller holding the model lock can explicitly avoid reentry", async (t) => {
  const state = mkdtempSync(path.join(process.env.MODEL_ROUTER_STATE_DIR, "adopted-held-"));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  let runs = 0;
  await withModelOverlayLock(() => publishAdoptedModelOverlayFresh({
    lock: false, executable: "/synthetic/node", environment: { MODEL_ROUTER_STATE_DIR: state },
    run: async () => { runs += 1; return { status: 0, stdout: JSON.stringify({ expectedFingerprint: FINGERPRINT, targetsRefreshed: false }) }; },
  }), { stateDir: state });
  assert.equal(runs, 1);
});

test("real fresh refreshes preserve catalogs for unadopted selection then publish adopted routes", async (t) => {
  const directory = mkdtempSync(path.join(process.env.MODEL_ROUTER_STATE_DIR, "adopted-real-"));
  const home = path.join(directory, "codex");
  const state = path.join(directory, "state");
  const dsh = path.join(directory, "dsh");
  for (const target of [home, state, dsh]) {
    assert.equal(path.relative(directory, target).startsWith(".."), false);
    mkdirSync(target, { recursive: true });
  }
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const registryPath = path.join(directory, "registry.json");
  const userPath = path.join(directory, "user-models.json");
  const genericPath = path.join(directory, "generic-providers.json");
  const provider = { id: "custom", displayName: "Custom", kind: "openai-compatible",
    ownedBy: "custom", authMode: "per-model", perModelEndpoint: true };
  const model = (providerId, id) => ({ ...userModelEntry({ providerId, upstreamId: id, priority: 100 }),
    endpoint: { baseUrl: "http://127.0.0.1:9999/v1", keyless: true, protocol: "openai-responses" } });
  writeFileSync(registryPath, JSON.stringify({ version: 1,
    providers: [provider, { ...provider, id: "staged" }],
    models: [model("custom", "existing"), model("staged", "addition")] }));
  writeFileSync(userPath, JSON.stringify({ version: 1, models: [] }));
  writeFileSync(genericPath, JSON.stringify({ version: 1, providers: [] }));
  const selectionPath = path.join(state, "enabled-providers.json");
  writeFileSync(selectionPath, JSON.stringify({ version: 1, providers: ["custom"] }));
  const catalogPath = path.join(state, "dsh-models.json");
  writeFileSync(catalogPath, JSON.stringify({ version: 1, models: [] }));
  writeFileSync(path.join(state, "caller-secret"), "synthetic_catalog_refresh_caller_secret_123456");
  let adoptedFingerprint;
  let healthStatus = 200;
  let healthReads = 0;
  const server = http.createServer((request, response) => {
    assert.equal(request.url, "/health", "only the synthetic readiness endpoint may be requested");
    healthReads += 1;
    response.writeHead(healthStatus, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ service: "codex-router", executionPlan: { fingerprint: adoptedFingerprint },
      degraded: healthStatus === 200 ? [] : ["api"] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const environment = { ...process.env, CODEX_HOME: home, HOME: directory, USERPROFILE: directory,
    DSH_HOME: dsh, MODEL_ROUTER_DSH_SETTINGS: path.join(dsh, "settings.yaml"),
    MODEL_ROUTER_DSH_CREDENTIALS: path.join(dsh, ".credentials.yaml"),
    MODEL_ROUTER_STATE_DIR: state, CODEX_ROUTER_STATE_DIR: state, CODEX_ROUTER_SOURCE_ROOT: ROOT,
    MODEL_ROUTER_REGISTRY: registryPath, MODEL_ROUTER_USER_MODELS: userPath,
    MODEL_ROUTER_GENERIC_PROVIDERS: genericPath, CODEX_ROUTER_NO_DISCOVERY: "0",
    MODEL_ROUTER_PORT: String(server.address().port), CODEX_ROUTER_PORT: String(server.address().port) };
  const readFreshPlan = async () => {
    const result = await runProcessTree(process.execPath, ["--input-type=module", "--eval",
      "const {runtimeDependencyRequirements}=await import('./src/runtime-dependency-requirements.mjs');process.stdout.write(JSON.stringify(runtimeDependencyRequirements()));"],
    { cwd: ROOT, env: environment, encoding: "utf8", windowsHide: true, deadline: Date.now() + 30_000 });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  adoptedFingerprint = (await readFreshPlan()).fingerprint;
  const refresh = () => publishAdoptedModelOverlayFresh({ sourceRoot: ROOT, executable: process.execPath, environment });
  const verifyOnly = () => verifyAdoptedModelOverlayFresh({ sourceRoot: ROOT, executable: process.execPath, environment });
  const driftRefresh = async () => {
    const result = await runProcessTree(process.execPath, ["--input-type=module", "--eval",
      "const {republishOnNativeDrift}=await import('./src/native-catalog-drift.mjs');const result=await republishOnNativeDrift({refreshAccountCatalog:async()=>({status:'unchanged'}),nativeDriftDetected:()=>true,routedAgentDriftDetected:()=>false});process.stdout.write(JSON.stringify(result));"],
    { cwd: ROOT, env: environment, encoding: "utf8", windowsHide: true, deadline: Date.now() + 30_000 });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const beforeVerification = readFileSync(catalogPath);
  assert.deepEqual(await verifyOnly(), { expectedFingerprint: adoptedFingerprint });
  assert.deepEqual(readFileSync(catalogPath), beforeVerification);
  assert.equal(existsSync(environment.MODEL_ROUTER_DSH_SETTINGS), false);
  assert.equal(existsSync(environment.MODEL_ROUTER_DSH_CREDENTIALS), false);
  assert.equal(existsSync(path.join(state, "litellm.yaml")), false);
  assert.equal((await refresh()).expectedFingerprint, adoptedFingerprint);
  assert.ok(JSON.parse(readFileSync(catalogPath, "utf8")).models.includes("custom/existing"));
  assert.equal(JSON.parse(readFileSync(catalogPath, "utf8")).models.includes("staged/addition"), false);
  const prior = readFileSync(catalogPath);
  const settingsPrior = readFileSync(environment.MODEL_ROUTER_DSH_SETTINGS);
  const credentialsPrior = readFileSync(environment.MODEL_ROUTER_DSH_CREDENTIALS);
  writeFileSync(selectionPath, JSON.stringify({ version: 1, providers: ["custom", "staged"] }));
  const stagedPlan = await readFreshPlan();
  assert.notEqual(stagedPlan.fingerprint, adoptedFingerprint);
  await assert.rejects(verifyOnly(), /not adopted/);
  await assert.rejects(refresh(), /not adopted/);
  assert.equal(await driftRefresh(), false, "the default catalog watcher also rejects staged selection");
  assert.deepEqual(readFileSync(catalogPath), prior);
  assert.deepEqual(readFileSync(environment.MODEL_ROUTER_DSH_SETTINGS), settingsPrior);
  assert.deepEqual(readFileSync(environment.MODEL_ROUTER_DSH_CREDENTIALS), credentialsPrior);
  assert.equal(existsSync(path.join(state, "litellm.yaml")), false, "catalog refresh never prepares gateway inputs");
  assert.equal(existsSync(path.join(home, "config.toml")), false, "an uninstalled client is untouched");
  adoptedFingerprint = stagedPlan.fingerprint;
  assert.equal((await refresh()).expectedFingerprint, adoptedFingerprint);
  assert.equal(await driftRefresh(), true, "the unchanged adopted route permits native catalog maintenance");
  assert.ok(JSON.parse(readFileSync(catalogPath, "utf8")).models.includes("custom/existing"));
  assert.ok(JSON.parse(readFileSync(catalogPath, "utf8")).models.includes("staged/addition"));
  const adopted = readFileSync(catalogPath);
  healthStatus = 503;
  await assert.rejects(verifyOnly(), /healthy router/);
  await assert.rejects(refresh(), /healthy router/);
  assert.deepEqual(readFileSync(catalogPath), adopted);
  assert.equal(healthReads, 9, "each maintenance or read-only pass verifies the actually running generation exactly once");
  assert.equal(existsSync(path.join(state, "litellm.yaml")), false);
});
