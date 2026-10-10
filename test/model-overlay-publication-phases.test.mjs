import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { applyModelOverlayPublication, prepareModelOverlayPublication, prepareModelOverlayFresh,
  publishModelOverlayTargets, publishModelOverlayTargetsFresh, transactModelOverlayMutation } from "../src/model-overlay-publication.mjs";
import { userModelEntry } from "../src/user-models.mjs";
import { verifyRouterExecutionPlanAdoption } from "../src/router-restart.mjs";

const CANDIDATE = "a".repeat(64);
const OLD = "b".repeat(64);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("routing preparation writes no client catalogs and returns its adoption identity", async () => {
  const events = [];
  const result = await prepareModelOverlayPublication({
    executionPlan: () => { events.push("plan"); return { fingerprint: CANDIDATE }; },
    writeGateway: () => { events.push("gateway"); return "/synthetic/litellm.yaml"; },
  });
  assert.deepEqual(events, ["plan", "gateway"]);
  assert.deepEqual(result, { gatewayPath: "/synthetic/litellm.yaml", expectedFingerprint: CANDIDATE });
});

test("publication follows dependency preparation, gateway preparation, adoption, and verification", async () => {
  const events = [];
  const deadlines = {};
  const result = await applyModelOverlayPublication({ restart: true,
    prepareDependencies: async ({ deadline }) => { events.push("dependencies"); deadlines.dependencies = deadline; },
    prepare: async ({ deadline }) => { events.push("prepare"); deadlines.prepare = deadline; return { expectedFingerprint: CANDIDATE }; },
    restartService: async ({ deadline, expectedFingerprint }) => {
      assert.equal(expectedFingerprint, CANDIDATE); events.push("adopt"); deadlines.adopt = deadline; return true;
    },
    verifyAdoption: async ({ expectedFingerprint, allowOffline }) => {
      assert.equal(expectedFingerprint, CANDIDATE); assert.equal(allowOffline, false); events.push("verify");
    },
    publish: async ({ deadline, expectedFingerprint }) => {
      assert.equal(expectedFingerprint, CANDIDATE); events.push("clients"); deadlines.publish = deadline;
    },
  });
  assert.deepEqual(result, {});
  assert.deepEqual(events, ["dependencies", "prepare", "adopt", "verify", "clients"]);
  assert.equal(deadlines.prepare - deadlines.dependencies, 30_000);
  assert.equal(deadlines.adopt - deadlines.prepare, 340_000);
  assert.equal(deadlines.publish - deadlines.adopt, 300_000);
});

test("a prepared registry change cannot advertise routes after a stale or failed adoption", async () => {
  for (const phase of ["restart", "verify"]) {
    const events = [];
    await assert.rejects(applyModelOverlayPublication({ restart: true,
      prepareDependencies: async () => {},
      prepare: async () => ({ expectedFingerprint: CANDIDATE }),
      restartService: async () => { events.push("restart"); if (phase === "restart") throw new Error("restart failed"); },
      verifyAdoption: async () => { events.push("verify"); throw new Error("old registry still serving"); },
      publish: async () => assert.fail("unadopted model must never reach a client picker"),
    }), phase === "restart" ? /restart failed/ : /old registry still serving/);
    assert.deepEqual(events, phase === "restart" ? ["restart"] : ["restart", "verify"]);
  }
});

test("fresh registry mismatch fails before touching the first installed client", async () => {
  await assert.rejects(publishModelOverlayTargets({ expectedFingerprint: CANDIDATE,
    executionPlan: () => ({ fingerprint: OLD }),
    refreshTargets: () => assert.fail("drifting registry must not publish clients"),
  }), { code: "model_overlay_adoption_failed" });
  const result = await publishModelOverlayTargets({ expectedFingerprint: CANDIDATE,
    executionPlan: () => ({ fingerprint: CANDIDATE }), refreshTargets: () => true });
  assert.deepEqual(result, { targetsRefreshed: true });
});

test("dependency failure is a truthful completed-operation warning and blocks every later phase", async () => {
  const result = await applyModelOverlayPublication({ restart: true, warningOnly: true,
    prepareDependencies: async () => { throw new Error("gateway dependency preparation failed"); },
    prepare: async () => assert.fail("failed dependencies cannot prepare routes"),
    restartService: async () => assert.fail("failed dependencies cannot restart"),
    publish: async () => assert.fail("failed dependencies cannot publish"),
  });
  assert.deepEqual(result, { catalogError: "gateway dependency preparation failed" });
});

test("without a requested restart, prepared routes still require verified adoption or offline state", async () => {
  const events = [];
  await applyModelOverlayPublication({
    prepareDependencies: async () => {}, prepare: async () => ({ expectedFingerprint: CANDIDATE }),
    verifyAdoption: async ({ allowOffline }) => {
      assert.equal(allowOffline, true); events.push("verify"); return { adopted: false, offline: true };
    },
    publish: async () => events.push("clients"),
    restartService: async () => assert.fail("explicitly offline publication cannot request a restart"),
  });
  assert.deepEqual(events, ["verify", "clients"]);
});

test("a managed router dying after restart cannot become an offline publication", async () => {
  await assert.rejects(applyModelOverlayPublication({ restart: true,
    prepareDependencies: async () => {}, prepare: async () => ({ expectedFingerprint: CANDIDATE }),
    restartService: async () => true,
    verifyAdoption: (options) => verifyRouterExecutionPlanAdoption({ ...options,
      waitForHealth: async () => ({ ok: false, connectionRefused: true }),
      serviceStatus: async () => assert.fail("managed restart cannot fall back to offline ownership"),
    }),
    publish: async () => assert.fail("dead managed service cannot advertise clients"),
  }), { code: "model_overlay_adoption_failed" });
  const events = [];
  await applyModelOverlayPublication({ restart: true,
    prepareDependencies: async () => {}, prepare: async () => ({ expectedFingerprint: CANDIDATE }),
    restartService: async () => false,
    verifyAdoption: (options) => verifyRouterExecutionPlanAdoption({ ...options,
      waitForHealth: async () => ({ ok: false, connectionRefused: true }),
      serviceStatus: async () => ({ installed: false, loaded: false }),
    }),
    publish: async () => events.push("clients:offline"),
  });
  assert.deepEqual(events, ["clients:offline"]);
});

test("failed partial client publication restores exact files, adopts old routes, then republishes", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "overlay-adoption-rollback-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const statePath = path.join(directory, "models.json");
  const createdPath = path.join(directory, "created.json");
  const previous = Buffer.from([0, 255, 13, 10, 77]);
  writeFileSync(statePath, previous);
  const caller = new AbortController();
  const events = [];
  let state = "old";
  let running = "old";
  let client = "old";
  await assert.rejects(transactModelOverlayMutation({ files: [statePath, createdPath], lock: false,
    signal: caller.signal, restart: true,
    mutate: () => { state = "new"; writeFileSync(statePath, "new"); writeFileSync(createdPath, "created"); events.push("mutate:new"); },
    restore: async (snapshots) => {
      const { restoreModelOverlayFiles } = await import("../src/model-overlay-publication.mjs");
      restoreModelOverlayFiles(snapshots); state = "old"; events.push("restore:old");
    },
    applyPublication: (options) => applyModelOverlayPublication({ ...options,
      prepareDependencies: async ({ signal }) => { if (state === "old") assert.equal(signal, undefined); events.push(`dependencies:${state}`); },
      prepare: async () => { events.push(`prepare:${state}`); return { expectedFingerprint: state === "new" ? CANDIDATE : OLD }; },
      restartService: async () => { running = state; events.push(`adopt:${state}`); return true; },
      verifyAdoption: async ({ expectedFingerprint }) => assert.equal(expectedFingerprint, running === "new" ? CANDIDATE : OLD),
      publish: async () => {
        assert.equal(running, state); client = state; events.push(`clients:${state}`);
        if (state === "new") { caller.abort(new Error("caller cancelled")); throw new Error("second client publication failed"); }
      },
    }),
  }), /second client publication failed/);
  assert.deepEqual(readFileSync(statePath), previous);
  assert.equal(existsSync(createdPath), false);
  assert.equal(running, "old");
  assert.equal(client, "old");
  assert.deepEqual(events, ["mutate:new", "dependencies:new", "prepare:new", "adopt:new", "clients:new",
    "restore:old", "dependencies:old", "prepare:old", "adopt:old", "clients:old"]);
});

test("prepare and targets use separate bounded fresh children with the expected identity", async () => {
  const invocations = [];
  const run = async (command, args, options) => {
    invocations.push({ command, args, options });
    return { status: 0, stdout: args[1] === "--prepare-in-fresh-process"
      ? JSON.stringify({ expectedFingerprint: CANDIDATE, gatewayPath: "/synthetic/litellm.yaml" })
      : JSON.stringify({ targetsRefreshed: true }) };
  };
  const prepared = await prepareModelOverlayFresh({ executable: "/runtime/node", sourceRoot: "/synthetic/router", environment: {}, run });
  await publishModelOverlayTargetsFresh({ executable: "/runtime/node", sourceRoot: "/synthetic/router", environment: {}, run,
    expectedFingerprint: prepared.expectedFingerprint });
  assert.deepEqual(invocations.map((call) => call.args[1]), ["--prepare-in-fresh-process", "--publish-targets-in-fresh-process"]);
  assert.equal(invocations[1].args[2], CANDIDATE);
  for (const call of invocations) {
    assert.equal(call.options.windowsHide, true);
    assert.equal(call.options.env.MODEL_ROUTER_TARGET, "codex");
    assert.equal(Number(call.options.env.CODEX_ROUTER_OPERATION_DEADLINE_MS), call.options.deadline - 10_000);
  }
});

test("real fresh children reject a changed endpoint before creating any client catalog", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "overlay-fresh-registry-"));
  const home = path.join(directory, "codex");
  const state = path.join(directory, "state");
  // The executable's filesystem effects are limited to this synthetic root.
  for (const target of [home, state]) {
    assert.equal(path.relative(directory, target).startsWith(".."), false);
    mkdirSync(target, { recursive: true });
  }
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const registryPath = path.join(directory, "registry.json");
  const userPath = path.join(directory, "user-models.json");
  const genericPath = path.join(directory, "generic-providers.json");
  const provider = { id: "custom", displayName: "Custom", kind: "openai-compatible",
    ownedBy: "custom", authMode: "per-model", perModelEndpoint: true };
  const entry = { ...userModelEntry({ providerId: "custom", upstreamId: "fresh-proof", priority: 100 }),
    listed: false,
    endpoint: { baseUrl: "http://127.0.0.1:9999/v1", keyless: true, protocol: "openai-responses" } };
  const writeRegistry = (baseUrl) => writeFileSync(registryPath, JSON.stringify({
    version: 1, providers: [provider], models: [{ ...entry, endpoint: { ...entry.endpoint, baseUrl } }],
  }));
  writeRegistry(entry.endpoint.baseUrl);
  writeFileSync(userPath, JSON.stringify({ version: 1, models: [] }));
  writeFileSync(genericPath, JSON.stringify({ version: 1, providers: [] }));
  writeFileSync(path.join(state, "enabled-providers.json"), JSON.stringify({ version: 1, providers: ["custom"] }));
  const environment = { ...process.env, CODEX_HOME: home, HOME: directory, USERPROFILE: directory,
    MODEL_ROUTER_STATE_DIR: state, CODEX_ROUTER_STATE_DIR: state, CODEX_ROUTER_SOURCE_ROOT: ROOT,
    MODEL_ROUTER_REGISTRY: registryPath, MODEL_ROUTER_USER_MODELS: userPath,
    MODEL_ROUTER_GENERIC_PROVIDERS: genericPath, CODEX_ROUTER_NO_DISCOVERY: "1" };
  const prepared = await prepareModelOverlayFresh({ sourceRoot: ROOT, executable: process.execPath, environment });
  assert.match(prepared.expectedFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(prepared.gatewayPath, path.join(state, "litellm.yaml"));
  assert.equal(existsSync(prepared.gatewayPath), true);
  assert.equal(existsSync(path.join(home, "config.toml")), false);
  writeRegistry("http://127.0.0.1:9998/v1");
  await assert.rejects(publishModelOverlayTargetsFresh({ sourceRoot: ROOT, executable: process.execPath,
    environment, expectedFingerprint: prepared.expectedFingerprint }), /changed after preparation/);
  for (const catalog of ["merged-models.json", "dsh-models.json", "gemini-models.json", "cursor-models.json"]) {
    assert.equal(existsSync(path.join(state, catalog)), false);
  }
  assert.equal(existsSync(path.join(home, "config.toml")), false);
});
