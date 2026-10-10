import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { freePort } from "./port-pool.mjs";
import { stageProviderControlRuntime } from "./fixtures/provider-control-runtime.mjs";
import { setupFixtureEnvironment } from "./fixtures/setup-environment.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureParent = process.env.CODEX_HOME || os.tmpdir();
mkdirSync(fixtureParent, { recursive: true });
const testTimeout = process.platform === "win32" ? 120_000 : 30_000;

async function fixture(t) {
  const directory = mkdtempSync(path.join(fixtureParent, "provider-key-publication-"));
  const state = path.join(directory, "state");
  const codex = path.join(directory, "codex");
  mkdirSync(state, { recursive: true });
  mkdirSync(codex, { recursive: true });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const port = await freePort();
  const environment = {
    ...process.env,
    HOME: directory, USERPROFILE: directory,
    APPDATA: path.join(directory, "appdata"),
    LOCALAPPDATA: path.join(directory, "localappdata"),
    CODEX_HOME: codex,
    MODEL_ROUTER_STATE_DIR: state, CODEX_ROUTER_STATE_DIR: state,
    MODEL_ROUTER_TARGET: "codex",
    MODEL_ROUTER_PORT: String(port), CODEX_ROUTER_PORT: String(port),
    MODEL_ROUTER_LAUNCH_AGENTS_DIR: path.join(directory, "launch-agents"),
    KIMI_CODE_HOME: path.join(directory, "kimi"),
    GROK_HOME: path.join(directory, "grok"),
    GROK_AUTH_PATH: path.join(directory, "grok", "auth.json"),
    CODEX_ROUTER_NO_DISCOVERY: "1",
    KIMI_API_KEY: "", MOONSHOT_API_KEY: "", XAI_API_KEY: "", GROK_API_KEY: "",
    ...stageProviderControlRuntime(directory),
  };
  for (const name of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "CODEX_HOME", "MODEL_ROUTER_STATE_DIR", "CODEX_ROUTER_STATE_DIR", "KIMI_CODE_HOME", "GROK_HOME", "GROK_AUTH_PATH"]) {
    assert.equal(path.isAbsolute(environment[name]), true);
    assert.equal(path.relative(directory, environment[name]).startsWith(".."), false);
  }
  const selection = path.join(state, "enabled-providers.json");
  const cache = path.join(state, "provider-catalog-cache.json");
  const events = () => {
    const file = path.join(directory, "runtime-events.jsonl");
    return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map(JSON.parse) : [];
  };
  const key = (arguments_, overrides = {}, input = "") => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "src", "provider-key.mjs"), ...arguments_], {
      cwd: root, env: { ...environment, ...overrides }, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
    // Invalid arguments can exit without opening stdin. The resulting EPIPE
    // is not a test failure; the exit status and unchanged state are the oracle.
    child.stdin.on("error", (error) => { if (error.code !== "EPIPE") reject(error); });
    child.stdin.end(input);
  });
  return { directory, state, codex, port, selection, cache, events, key };
}

function seedState(f, provider) {
  writeFileSync(f.selection, `{"version":1,"providers":["${provider}"],"mode":"selected"}\n`);
  writeFileSync(f.cache, '{"version":2,"providers":{"grok-api":{"fixture":"old account"},"kimi-api":{"fixture":"old account"},"deepseek":{"fixture":"retained account"}}}\n');
}

const snapshot = (files) => files.map((file) => existsSync(file) ? readFileSync(file) : null);
const assertSnapshot = (files, before) => assert.deepEqual(snapshot(files), before);

async function healthyRouter(t, f, { adopted = true } = {}) {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, service: "codex-router", degraded: [],
      ...(adopted ? { executionPlan: { fingerprint: "a".repeat(64) } } : {}),
    }));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(f.port, "127.0.0.1", resolve); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
}

test("bootstrap stages a key and account cache without dependency, service or client publication", { timeout: testTimeout }, async (t) => {
  const f = await fixture(t);
  seedState(f, "custom");
  const result = await f.key(["grok-api", "set", "--stdin", "--stage"], { FIXTURE_PROVIDER_FAIL_PHASE: "prepare" }, "TEST_STAGED_API_KEY\n");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Changes staged/);
  assert.equal(readFileSync(path.join(f.state, "xai-api-key.secret"), "utf8"), "TEST_STAGED_API_KEY\n");
  assert.equal(JSON.parse(readFileSync(f.selection, "utf8")).providers.includes("grok-api"), true);
  const cached = JSON.parse(readFileSync(f.cache, "utf8")).providers;
  assert.equal("grok-api" in cached, false);
  assert.equal(cached.deepseek.fixture, "retained account");
  assert.deepEqual(f.events(), []);
  assert.doesNotMatch(result.stdout + result.stderr, /TEST_STAGED_API_KEY/);
});

test("explicit staged removal withdraws a provider without publishing clients", { timeout: testTimeout }, async (t) => {
  const f = await fixture(t);
  seedState(f, "grok-api");
  const key = path.join(f.state, "xai-api-key.secret");
  writeFileSync(key, "TEST_STAGED_REMOVAL_KEY\n");
  const result = await f.key(["grok-api", "remove", "--stage"], { FIXTURE_PROVIDER_FAIL_PHASE: "prepare" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(key), false);
  assert.equal(JSON.parse(readFileSync(f.selection, "utf8")).providers.includes("grok-api"), false);
  assert.deepEqual(f.events(), []);
});

test("ordinary CLI set prepares dependencies and adopts the managed service before client publication", { timeout: testTimeout }, async (t) => {
  const f = await fixture(t);
  seedState(f, "custom");
  await healthyRouter(t, f);
  const result = await f.key(["grok-api", "set", "--stdin"], { FIXTURE_PROVIDER_MANAGED_SERVICE: "1" }, "TEST_ADOPTED_API_KEY\n");
  assert.equal(result.status, 0, result.stderr);
  const phases = f.events().map(({ phase }) => phase);
  assert.equal(phases.includes("dependencies"), true);
  assert.equal(phases.includes("prepare"), true);
  assert.equal(phases.includes("service-restart"), true);
  assert.equal(phases.includes("publish"), true);
  assert.equal(phases.indexOf("dependencies") < phases.indexOf("prepare"), true);
  assert.equal(phases.indexOf("prepare") < phases.indexOf("service-restart"), true);
  assert.equal(phases.indexOf("service-restart") < phases.indexOf("publish"), true);
  assert.doesNotMatch(result.stdout + result.stderr, /TEST_ADOPTED_API_KEY/);
});

test("ordinary CLI set failure restores exact key, selection and account cache", { timeout: testTimeout }, async (t) => {
  const f = await fixture(t);
  seedState(f, "custom");
  const key = path.join(f.state, "xai-api-key.secret");
  writeFileSync(key, "TEST_ORIGINAL_CLI_KEY\r\n");
  const files = [key, f.selection, f.cache];
  const before = snapshot(files);
  const result = await f.key(["grok-api", "set", "--stdin"], { FIXTURE_PROVIDER_FAIL_PHASE: "prepare" }, "TEST_REPLACEMENT_CLI_KEY\n");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Synthetic prepare failure/);
  assertSnapshot(files, before);
  assert.equal(f.events().filter(({ phase }) => phase === "publish").length, 1, "only restored state can reach clients");
  assert.doesNotMatch(result.stdout + result.stderr, /TEST_ORIGINAL_CLI_KEY|TEST_REPLACEMENT_CLI_KEY/);
});

test("ordinary removal publication failure restores primary and legacy credentials byte for byte", { timeout: testTimeout }, async (t) => {
  const f = await fixture(t);
  seedState(f, "kimi-api");
  const keys = [path.join(f.state, "kimi-api-key.secret"), path.join(f.state, "api-key.secret"),
    path.join(f.codex, "kimi-router", "kimi-api-key.secret"), path.join(f.codex, "kimi-proxy", "api-key.secret")];
  for (const [index, key] of keys.entries()) {
    mkdirSync(path.dirname(key), { recursive: true });
    writeFileSync(key, `TEST_LEGACY_CLI_KEY_${index}\r\n`);
  }
  const files = [...keys, f.selection, f.cache];
  const before = snapshot(files);
  const result = await f.key(["kimi-api", "remove"], { FIXTURE_PROVIDER_FAIL_PHASE: "publish" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Synthetic publish failure/);
  assertSnapshot(files, before);
  assert.equal(f.events().filter(({ phase }) => phase === "publish").length, 2, "failed candidate publication must be followed by restored publication");
  assert.doesNotMatch(result.stdout + result.stderr, /TEST_LEGACY_CLI_KEY/);
});

for (const command of ["set", "remove"]) {
  test(`foreground router blocks ordinary CLI ${command} and restores durable state`, { timeout: testTimeout }, async (t) => {
    const f = await fixture(t);
    seedState(f, "grok-api");
    const key = path.join(f.state, "xai-api-key.secret");
    writeFileSync(key, "TEST_FOREGROUND_ORIGINAL_KEY\n");
    const files = [key, f.selection, f.cache];
    const before = snapshot(files);
    await healthyRouter(t, f, { adopted: false });
    const result = await f.key(["grok-api", command, ...(command === "set" ? ["--stdin"] : [])], {}, "TEST_FOREGROUND_REPLACEMENT_KEY\n");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /foreground router.*cannot be reloaded/);
    assertSnapshot(files, before);
    assert.equal(f.events().some(({ phase }) => phase === "publish"), false);
    assert.doesNotMatch(result.stdout + result.stderr, /TEST_FOREGROUND_(ORIGINAL|REPLACEMENT)_KEY/);
  });
}

test("absent CLI removal preserves selection and cache and performs no runtime work", { timeout: testTimeout }, async (t) => {
  const f = await fixture(t);
  seedState(f, "custom");
  const files = [f.selection, f.cache];
  const before = snapshot(files);
  const result = await f.key(["grok-api", "remove"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No managed/);
  assertSnapshot(files, before);
  assert.deepEqual(f.events(), []);
});

test("oversized stdin and contradictory flags fail before any credential or selection write", { timeout: testTimeout }, async (t) => {
  const f = await fixture(t);
  seedState(f, "custom");
  const files = [path.join(f.state, "xai-api-key.secret"), f.selection, f.cache];
  const before = snapshot(files);
  const oversized = await f.key(["grok-api", "set", "--stdin"], {}, "X".repeat(16 * 1024 + 1));
  assert.notEqual(oversized.status, 0);
  assert.match(oversized.stderr, /credential is too large/);
  for (const args of [["grok-api", "remove", "--stdin"], ["grok-api", "status", "--stage"], ["grok-api", "set", "--unknown"]]) {
    const rejected = await f.key(args);
    assert.equal(rejected.status, 2);
    assert.match(rejected.stderr, /Usage/);
  }
  assertSnapshot(files, before);
  assert.deepEqual(f.events(), []);
});

test("both guided setup callers explicitly stage credentials before their installer finalization", () => {
  for (const file of ["setup.mjs", "setup-shared.mjs"]) {
    const source = readFileSync(path.join(root, "src", file), "utf8");
    const calls = source.match(/run\(process\.execPath, \[[^\n]*provider-key\.mjs[^\n]*\]\)/g) || [];
    assert.equal(calls.length, 1, `${file} must have a single auditable provider-key subprocess`);
    assert.match(calls[0], /"set", "--stage"/);
  }
});

test("setup fixture blocks global Keychain reads while ordinary subprocesses still execute", { timeout: testTimeout }, async (t) => {
  const f = await fixture(t);
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `
    import {execFileSync} from "node:child_process";
    let absent;
    try { execFileSync("/usr/bin/security", ["find-generic-password", "-s", "fixture", "-w"]); }
    catch (error) { absent = error.status; }
    const ordinary = execFileSync(process.execPath, ["-e", "process.stdout.write('synthetic-child')"], {encoding:"utf8"});
    process.stdout.write(JSON.stringify({absent, ordinary}));
  `], { cwd: root, encoding: "utf8", env: setupFixtureEnvironment(f.directory, f.state, f.codex) });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { absent: 44, ordinary: "synthetic-child" });
});
