import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { freePort } from "./port-pool.mjs";
import { stageProviderControlRuntime } from "./fixtures/provider-control-runtime.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureParent = process.env.CODEX_HOME || os.tmpdir();
mkdirSync(fixtureParent, { recursive: true });
const root = mkdtempSync(path.join(fixtureParent, "provider-key-control-"));
const stateDir = path.join(root, "state");
const credentialStorePath = path.join(stateDir, "provider-credentials.json");
const poolStatePath = path.join(stateDir, "provider-api-key-pools.json");
const launchAgentsDir = path.join(root, "launch-agents");
const inactiveRouterPort = await freePort();
const foregroundRouterPort = await freePort();
// These two cumulative mutation scenarios cross four or five sequential
// private-file writes, including exact-file rollback. Each Windows write keeps
// its own 15-second owner-only ACL bound, so the outer test must preserve all
// of those production epochs plus child-publication startup. POSIX does not
// launch the ACL helper and keeps the tighter regression bound.
const ACL_HEAVY_MUTATION_TEST_TIMEOUT_MS = process.platform === "win32" ? 120_000 : 30_000;
process.env.HOME = root;
process.env.USERPROFILE = root;
process.env.APPDATA = path.join(root, "appdata");
process.env.LOCALAPPDATA = path.join(root, "localappdata");
process.env.CODEX_HOME = path.join(root, "codex");
process.env.MODEL_ROUTER_STATE_DIR = stateDir;
process.env.CODEX_ROUTER_STATE_DIR = stateDir;
assert.ok(path.relative(root, process.env.CODEX_HOME).startsWith("codex"));
assert.equal(process.env.HOME, root);
assert.equal(process.env.USERPROFILE, root);
assert.equal(process.env.MODEL_ROUTER_STATE_DIR, process.env.CODEX_ROUTER_STATE_DIR);
// Pool readiness needs credential resolution; every discovery root is synthetic.
process.env.CODEX_ROUTER_NO_DISCOVERY = "0";
process.env.KIMI_CODE_HOME = path.join(root, "kimi");
process.env.GROK_HOME = path.join(root, "grok");
process.env.GROK_AUTH_PATH = path.join(root, "grok", "auth.json");
process.env.MODEL_ROUTER_PROVIDER_CREDENTIAL_STORE = credentialStorePath;
process.env.MODEL_ROUTER_PROVIDER_CREDENTIAL_MIGRATIONS = path.join(stateDir, "migrations", "provider-credentials");
process.env.MODEL_ROUTER_API_KEY_POOL_PATH = poolStatePath;

const { addCredentialReference, readProviderCredentialStore } = await import("../src/provider-credential-store.mjs");
const { upsertProviderApiKey } = await import("../src/provider-api-key-pool.mjs");
const { withModelOverlayLock } = await import("../src/model-overlay-lock.mjs");
const { withServiceOperationLock } = await import("../src/service-operation-lock.mjs");
const {
  addEnvironmentCredentialToPool,
  addStoredCredentialToPool,
  deleteStoredCredentialPool,
  removeStoredCredentialFromPool,
  setStoredCredentialPoolPolicy,
  setStoredCredentialPoolState,
  storedCredentialPoolUsesServiceEnvironment,
  storedCredentialRequiresServiceEnvironment,
  storedCredentialPoolStatus,
} = await import("../src/provider-api-key-control.mjs");

test.after(() => rmSync(root, { recursive: true, force: true }));

test("credential lifecycle control is provider-bound and never stores secret bytes", async () => {
  const credential = addCredentialReference({
    providerId: "opencode-go",
    kind: "api_key",
    secretRef: { type: "environment", name: "OPENCODE_GO_API_KEY" },
  }, credentialStorePath);
  assert.equal(
    storedCredentialRequiresServiceEnvironment("opencode-go", credential.id, { credentialStorePath }),
    true,
  );

  await assert.rejects(
    addStoredCredentialToPool("openrouter", credential.id, { credentialStorePath, poolStatePath }),
    /not an API key for openrouter/,
  );
  await addStoredCredentialToPool("opencode-go-messages", credential.id, { credentialStorePath, poolStatePath });
  await setStoredCredentialPoolPolicy("opencode-go", "round-robin", { poolStatePath });
  await setStoredCredentialPoolState("opencode-go", credential.id, true, { poolStatePath });
  const paused = storedCredentialPoolStatus("opencode-go", { poolStatePath }).credentials[0];
  assert.equal(paused.paused, true);
  await addStoredCredentialToPool("opencode-go", credential.id, { credentialStorePath, poolStatePath });
  assert.deepEqual(
    storedCredentialPoolStatus("opencode-go", { poolStatePath }).credentials[0],
    paused,
    "re-adding an existing stored reference must not resume or reset it",
  );
  await setStoredCredentialPoolState("opencode-go", credential.id, false, { poolStatePath });

  const status = storedCredentialPoolStatus("opencode-go-messages", { poolStatePath });
  assert.equal(status.policy.strategy, "round-robin");
  assert.equal(status.credentials[0].paused, false);
  assert.equal(status.credentials[0].id, credential.id);
  assert.deepEqual(status.readiness, {
    usable: false,
    reason: "unresolvable_credentials",
    credentialCount: 1,
    eligibleCredentialCount: 1,
    resolvableCredentialCount: 0,
  });
  assert.doesNotMatch(readFileSync(poolStatePath, "utf8"), /OPENCODE_GO_API_KEY|secretRef|Bearer/);
  assert.doesNotMatch(JSON.stringify(status), /OPENCODE_GO_API_KEY|Bearer/);
});

test("an allowed environment source can be registered and pooled in one operation", async () => {
  const options = {
    credentialStorePath,
    poolStatePath,
  };
  const result = await addEnvironmentCredentialToPool("opencode-go", "OPENCODE_API_KEY", options);
  await upsertProviderApiKey("opencode-go", {
    id: result.credential.id,
    priority: 73,
    quota: {
      limit: 1_000,
      remaining: 417,
      observedAt: "2026-08-27T12:00:00.000Z",
    },
    health: {
      state: "healthy",
      lastSuccessAt: "2026-08-27T12:00:00.000Z",
      lastStatus: 200,
    },
    requestCount: 29,
    tokenCount: 31_337,
  }, { filePath: poolStatePath });
  await setStoredCredentialPoolState("opencode-go", result.credential.id, true, { poolStatePath });
  const beforeRepeat = storedCredentialPoolStatus("opencode-go", { poolStatePath }).credentials
    .find((entry) => entry.id === result.credential.id);
  const repeated = await addEnvironmentCredentialToPool("opencode-go", "OPENCODE_API_KEY", options);
  assert.match(result.credential.id, /^cred_/);
  assert.equal(result.credential.providerId, "opencode-go");
  assert.equal(repeated.credential.id, result.credential.id);
  assert.deepEqual(
    storedCredentialPoolStatus("opencode-go", { poolStatePath }).credentials
      .find((entry) => entry.id === result.credential.id),
    beforeRepeat,
    "idempotent add-env must preserve pause, health, quota, priority, and counters",
  );
  const matching = readProviderCredentialStore(credentialStorePath).credentials.filter(
    (entry) => entry.providerId === "opencode-go" && entry.secretRef.name === "OPENCODE_API_KEY",
  );
  assert.equal(matching.length, 1);
  assert.equal(
    storedCredentialPoolStatus("opencode-go", { poolStatePath }).credentials
      .filter((entry) => entry.id === result.credential.id).length,
    1,
  );
  process.env.OPENCODE_GO_API_KEY = "TEST_READY_POOL_KEY";
  try {
    assert.deepEqual(
      storedCredentialPoolStatus("opencode-go", options).readiness,
      {
        usable: true,
        reason: "ready",
        credentialCount: 2,
        eligibleCredentialCount: 1,
        resolvableCredentialCount: 1,
      },
    );
  } finally {
    delete process.env.OPENCODE_GO_API_KEY;
  }
  await assert.rejects(
    addEnvironmentCredentialToPool("opencode-go", "UNDECLARED_SECRET", {
      credentialStorePath,
      poolStatePath,
    }),
    /secretRef\.name is not configured for this provider/,
  );
  await removeStoredCredentialFromPool("opencode-go", result.credential.id, { poolStatePath });
  assert.equal(
    readProviderCredentialStore(credentialStorePath).credentials.some(
      (entry) => entry.id === result.credential.id,
    ),
    true,
    "removing a pool member must preserve its shared credential reference",
  );
  await deleteStoredCredentialPool("opencode-go", { poolStatePath });
  assert.equal(storedCredentialPoolStatus("opencode-go", { poolStatePath }).configured, false);
});

test("removal classification follows the exact pool members and fails closed on missing metadata", async () => {
  rmSync(poolStatePath, { force: true });
  const environment = await addEnvironmentCredentialToPool(
    "opencode-go",
    "OPENCODE_API_KEY",
    { credentialStorePath, poolStatePath },
  );
  const fileBacked = addCredentialReference({
    providerId: "opencode-go",
    kind: "api_key",
    secretRef: { type: "provider-file", providerId: "opencode-go", target: "codex" },
  }, credentialStorePath);
  await addStoredCredentialToPool("opencode-go", fileBacked.id, {
    credentialStorePath,
    poolStatePath,
  });

  assert.equal(storedCredentialPoolUsesServiceEnvironment("opencode-go", {
    credentialId: environment.credential.id,
    credentialStorePath,
    poolStatePath,
  }), true);
  assert.equal(storedCredentialPoolUsesServiceEnvironment("opencode-go", {
    credentialId: fileBacked.id,
    credentialStorePath,
    poolStatePath,
  }), false);
  assert.equal(storedCredentialPoolUsesServiceEnvironment("opencode-go", {
    credentialStorePath,
    poolStatePath,
  }), true);

  const missingStorePath = path.join(stateDir, "missing-credential-store.json");
  assert.equal(storedCredentialPoolUsesServiceEnvironment("opencode-go", {
    credentialId: environment.credential.id,
    credentialStorePath: missingStorePath,
    poolStatePath,
  }), true);
});

function runControl(arguments_, environment = {}) {
  const child = spawn(process.execPath, [path.join(repoRoot, "src", "control.mjs"), ...arguments_], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...stageProviderControlRuntime(root),
      MODEL_ROUTER_TARGET: "codex",
      CODEX_HOME: process.env.CODEX_HOME,
      CODEX_ROUTER_STATE_DIR: stateDir,
      MODEL_ROUTER_STATE_DIR: stateDir,
      MODEL_ROUTER_PROVIDER_CREDENTIAL_STORE: credentialStorePath,
      MODEL_ROUTER_PROVIDER_CREDENTIAL_MIGRATIONS: process.env.MODEL_ROUTER_PROVIDER_CREDENTIAL_MIGRATIONS,
      MODEL_ROUTER_API_KEY_POOL_PATH: poolStatePath,
      MODEL_ROUTER_LAUNCH_AGENTS_DIR: launchAgentsDir,
      CODEX_ROUTER_SERVICE_PLATFORM: "darwin",
      MODEL_ROUTER_PORT: String(inactiveRouterPort),
      CODEX_ROUTER_PORT: String(inactiveRouterPort),
      DSH_HOME: path.join(root, "dsh"),
      ...environment,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const completed = new Promise((resolve) => {
    child.once("exit", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
  return { child, completed };
}

test("a live foreground router blocks environment pool publication before metadata changes", { timeout: 30_000 }, async () => {
  rmSync(poolStatePath, { force: true });
  const beforeStore = readFileSync(credentialStorePath);
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      service: "codex-router",
      version: "foreground-lifecycle-test",
      degraded: [],
    }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(foregroundRouterPort, "127.0.0.1", resolve);
  });
  try {
    const result = await runControl(
      ["key-pool", "opencode-go", "add-env", "OPENCODE_API_KEY"],
      {
        MODEL_ROUTER_PORT: String(foregroundRouterPort),
        CODEX_ROUTER_PORT: String(foregroundRouterPort),
        OPENCODE_API_KEY: "secret-live-foreground-test",
      },
    ).completed;
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /live router process/i);
    assert.match(result.stderr, /stop the foreground router/i);
    assert.equal(existsSync(poolStatePath), false, "a live foreground owner must block before mutation");
    assert.deepEqual(readFileSync(credentialStorePath), beforeStore);
    assert.doesNotMatch(
      `${result.stdout}\n${result.stderr}`,
      /OPENCODE_API_KEY|secret-live-foreground-test/,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("key-pool status stays read-only while mutations wait for publication ownership", { timeout: 30_000 }, async () => {
  rmSync(poolStatePath, { force: true });
  let mutation;
  await withModelOverlayLock(async () => {
    const status = await runControl(["key-pool", "opencode-go", "status"]).completed;
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).readiness.reason, "pool_not_configured");
    assert.equal(existsSync(poolStatePath), false, "status must not create pool state");

    mutation = runControl(["key-pool", "opencode-go", "add-env", "OPENCODE_API_KEY"]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(mutation.child.exitCode, null, "the mutation must wait for the model publication lock");
    assert.equal(existsSync(poolStatePath), false, "pool state must not change before publication ownership");
  });

  const result = await mutation.completed;
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(poolStatePath), true);
});

test("an environment-backed mutation waits for service ownership before staging", { timeout: 30_000 }, async () => {
  rmSync(poolStatePath, { force: true });
  let mutation;
  await withServiceOperationLock(async () => {
    mutation = runControl(["key-pool", "opencode-go", "add-env", "OPENCODE_GO_API_KEY"]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(mutation.child.exitCode, null, "the mutation must wait for the service-operation lock");
    assert.equal(existsSync(poolStatePath), false, "pool state must not change before service ownership");
  }, { stateDir });

  const result = await mutation.completed;
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(poolStatePath), true);
});

test("remove and delete of environment pool entries name the installed-service cleanup", {
  timeout: ACL_HEAVY_MUTATION_TEST_TIMEOUT_MS,
}, async () => {
  rmSync(poolStatePath, { force: true });
  const first = await addEnvironmentCredentialToPool("opencode-go", "OPENCODE_API_KEY", {
    credentialStorePath,
    poolStatePath,
  });
  await addEnvironmentCredentialToPool("opencode-go", "OPENCODE_GO_API_KEY", {
    credentialStorePath,
    poolStatePath,
  });
  mkdirSync(launchAgentsDir, { recursive: true });
  const launchAgentPath = path.join(launchAgentsDir, "io.github.codex-router.plist");
  writeFileSync(launchAgentPath, "installed-service-fixture\n", { mode: 0o600 });
  const secretValues = ["secret-test-one", "secret-test-two"];
  const childEnvironment = {
    FIXTURE_PROVIDER_MANAGED_SERVICE: "1",
    OPENCODE_API_KEY: secretValues[0],
    OPENCODE_GO_API_KEY: secretValues[1],
  };
  try {
    const removed = await runControl(
      ["key-pool", "opencode-go", "remove", first.credential.id],
      childEnvironment,
    ).completed;
    assert.equal(removed.status, 0, removed.stderr);
    assert.match(removed.stderr, /rerun the installer/i);
    assert.match(removed.stderr, /remove the retired secret/i);
    assert.match(removed.stderr, /managed service definition/i);
    assert.match(removed.stderr, /restart alone/i);

    const deleted = await runControl(
      ["key-pool", "opencode-go", "delete"],
      childEnvironment,
    ).completed;
    assert.equal(deleted.status, 0, deleted.stderr);
    assert.match(deleted.stderr, /rerun the installer/i);
    assert.match(deleted.stderr, /remove the retired secret/i);
    assert.match(deleted.stderr, /managed service definition/i);
    assert.match(deleted.stderr, /restart alone/i);

    for (const output of [
      removed.stdout,
      removed.stderr,
      deleted.stdout,
      deleted.stderr,
    ]) {
      assert.doesNotMatch(
        output,
        /OPENCODE_API_KEY|OPENCODE_GO_API_KEY|secret-test-one|secret-test-two/,
      );
    }

    const fileBacked = addCredentialReference({
      providerId: "opencode-go",
      kind: "api_key",
      secretRef: { type: "provider-file", providerId: "opencode-go", target: "codex" },
    }, credentialStorePath);
    await addStoredCredentialToPool("opencode-go", fileBacked.id, {
      credentialStorePath,
      poolStatePath,
    });
    const ordinaryDelete = await runControl(
      ["key-pool", "opencode-go", "delete"],
      { ...childEnvironment, FIXTURE_PROVIDER_MANAGED_SERVICE: "0" },
    ).completed;
    assert.equal(ordinaryDelete.status, 0, ordinaryDelete.stderr);
    assert.doesNotMatch(ordinaryDelete.stderr, /environment-backed|rerun the installer/i);
  } finally {
    rmSync(launchAgentPath, { force: true });
  }
});

test("a failed client publication restores both pool metadata files", {
  timeout: ACL_HEAVY_MUTATION_TEST_TIMEOUT_MS,
}, async () => {
  rmSync(poolStatePath, { force: true });
  const credential = addCredentialReference({
    providerId: "opencode-go",
    kind: "api_key",
    secretRef: { type: "provider-file", providerId: "opencode-go", target: "codex" },
  }, credentialStorePath);
  await addStoredCredentialToPool("opencode-go", credential.id, {
    credentialStorePath, poolStatePath,
  });
  const beforePool = readFileSync(poolStatePath);
  const beforeStore = readFileSync(credentialStorePath);
  const result = await runControl([
    "key-pool", "opencode-go", "pause", credential.id,
  ], { FIXTURE_PROVIDER_FAIL_PHASE: "publish" }).completed;
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Synthetic publish failure/);
  assert.deepEqual(readFileSync(poolStatePath), beforePool);
  assert.deepEqual(readFileSync(credentialStorePath), beforeStore);
  const events = readFileSync(path.join(root, "runtime-events.jsonl"), "utf8")
    .trim().split("\n").map(JSON.parse);
  assert.equal(events.filter((entry) => entry.phase === "publish").length >= 2, true,
    "failed candidate publication and successful rollback publication must both run");
});


test("all environment pool changes stage metadata without publishing clients or restarting", {
  timeout: ACL_HEAVY_MUTATION_TEST_TIMEOUT_MS,
}, async () => {
  rmSync(poolStatePath, { force: true });
  const log = path.join(root, "runtime-events.jsonl");
  const beforeEvents = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").length : 0;
  const added = await runControl(["key-pool", "opencode-go", "add-env", "OPENCODE_API_KEY"], {
    OPENCODE_API_KEY: "TEST_STAGED_ENVIRONMENT_KEY",
    FIXTURE_PROVIDER_MANAGED_SERVICE: "1",
  }).completed;
  assert.equal(added.status, 0, added.stderr);
  assert.match(added.stderr, /staged.*rerun the installer/is);
  const id = JSON.parse(added.stdout).credential.id;
  for (const [action, value] of [["pause", id], ["resume", id], ["policy", "round-robin"], ["remove", id]]) {
    const result = await runControl(["key-pool", "opencode-go", action, value], {
      FIXTURE_PROVIDER_MANAGED_SERVICE: "1",
    }).completed;
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /rerun the installer/i);
    assert.doesNotMatch(result.stdout + result.stderr, /TEST_STAGED_ENVIRONMENT_KEY/);
  }
  const events = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse).slice(beforeEvents);
  assert.equal(events.some(({ phase }) => ["dependencies", "prepare", "publish", "service-restart"].includes(phase)), false);
  const controls = events.filter(({ phase }) => phase === "control");
  assert.equal(controls.length, 5);
  assert.ok(controls.every(({ time, deadline }) => deadline - time > 35 * 60_000),
    "the control owner must retain the transaction's complete preparation and rollback budget");
});

test("a staged environment addition rolls back a partial credential reference when the pool is invalid", {
  timeout: ACL_HEAVY_MUTATION_TEST_TIMEOUT_MS,
}, async () => {
  writeFileSync(poolStatePath, "INVALID_POOL_DOCUMENT_WITH_EXACT_BYTES\n");
  rmSync(credentialStorePath, { force: true });
  const beforePool = readFileSync(poolStatePath);
  const log = path.join(root, "runtime-events.jsonl");
  const beforeEvents = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").length : 0;
  const result = await runControl(["key-pool", "opencode-go", "add-env", "OPENCODE_API_KEY"], {
    OPENCODE_API_KEY: "TEST_INVALID_POOL_PARTIAL_KEY",
  }).completed;
  assert.notEqual(result.status, 0);
  assert.deepEqual(readFileSync(poolStatePath), beforePool);
  assert.equal(existsSync(credentialStorePath), false);
  const events = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse).slice(beforeEvents);
  assert.equal(events.some(({ phase }) => phase === "publish"), false);
  assert.doesNotMatch(result.stdout + result.stderr, /TEST_INVALID_POOL_PARTIAL_KEY/);
});


for (const healthy of [true, false]) {
  test(`ordinary pool change ${healthy ? "publishes after healthy adoption without restart" : "rejects degraded adoption and restores metadata"}`, {
    timeout: ACL_HEAVY_MUTATION_TEST_TIMEOUT_MS,
  }, async () => {
    rmSync(poolStatePath, { force: true });
    const credential = addCredentialReference({
      providerId: "opencode-go", kind: "api_key",
      secretRef: { type: "provider-file", providerId: "opencode-go", target: "codex" },
    }, credentialStorePath);
    await addStoredCredentialToPool("opencode-go", credential.id, { credentialStorePath, poolStatePath });
    const beforePool = readFileSync(poolStatePath);
    const beforeStore = readFileSync(credentialStorePath);
    const log = path.join(root, "runtime-events.jsonl");
    const beforeEvents = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").length : 0;
    const server = createServer((request, response) => {
      response.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ok: healthy, service: "codex-router",
        degraded: healthy ? [] : ["provider_api_key_pool_unavailable"],
        executionPlan: { fingerprint: "a".repeat(64) },
      }));
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(foregroundRouterPort, "127.0.0.1", resolve); });
    try {
      const result = await runControl(["key-pool", "opencode-go", "pause", credential.id], {
        MODEL_ROUTER_PORT: String(foregroundRouterPort), CODEX_ROUTER_PORT: String(foregroundRouterPort),
      }).completed;
      const events = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse).slice(beforeEvents);
      assert.equal(events.some(({ phase }) => phase === "service-restart"), false);
      if (healthy) {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(storedCredentialPoolStatus("opencode-go", { poolStatePath }).credentials[0].paused, true);
        assert.equal(events.filter(({ phase }) => phase === "publish").length, 1);
      } else {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /healthy router|adoption/i);
        assert.deepEqual(readFileSync(poolStatePath), beforePool);
        assert.deepEqual(readFileSync(credentialStorePath), beforeStore);
        assert.equal(events.some(({ phase }) => phase === "publish"), false);
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
}
