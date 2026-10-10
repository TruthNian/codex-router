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
const testTimeout = process.platform === "win32" ? 120_000 : 30_000;

async function fixture(t) {
  const directory = mkdtempSync(path.join(fixtureParent, "provider-publication-"));
  const state = path.join(directory, "state");
  const codex = path.join(directory, "codex");
  mkdirSync(state, { recursive: true });
  mkdirSync(codex, { recursive: true });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const port = await freePort();
  const environment = {
    ...process.env,
    HOME: directory,
    USERPROFILE: directory,
    APPDATA: path.join(directory, "appdata"),
    LOCALAPPDATA: path.join(directory, "localappdata"),
    CODEX_HOME: codex,
    MODEL_ROUTER_STATE_DIR: state,
    CODEX_ROUTER_STATE_DIR: state,
    MODEL_ROUTER_TARGET: "codex",
    MODEL_ROUTER_PORT: String(port),
    CODEX_ROUTER_PORT: String(port),
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
  const control = (arguments_, overrides = {}, input = "") => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repoRoot, "src", "control.mjs"), ...arguments_], {
      cwd: repoRoot, env: { ...environment, ...overrides }, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (status, signal) => resolve({ status, signal, stdout, stderr }));
    child.stdin.end(input);
  });
  return { directory, state, codex, port, environment, selection, cache, events, control };
}

function seedState(f, provider) {
  writeFileSync(f.selection, `{"version":1,"providers":["${provider}"],"mode":"selected"}\n`);
  writeFileSync(f.cache, '{"version":2,"providers":{},"fixture":"exact original whitespace"}\n');
}

function snapshot(files) {
  return files.map((file) => existsSync(file) ? readFileSync(file) : null);
}

function assertSnapshot(files, before) {
  assert.deepEqual(snapshot(files), before);
}

test("failed credential preparation restores exact key, selection and catalog state before republishing", { timeout: testTimeout }, async (t) => {
  const f = await fixture(t);
  const key = path.join(f.state, "xai-api-key.secret");
  seedState(f, "custom");
  writeFileSync(key, "TEST_ORIGINAL_API_KEY\n");
  const files = [key, f.selection, f.cache];
  const before = snapshot(files);
  const result = await f.control(["credential", "grok-api"], { FIXTURE_PROVIDER_FAIL_PHASE: "prepare" }, "TEST_REPLACEMENT_API_KEY\n");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Synthetic prepare failure/);
  assertSnapshot(files, before);
  assert.deepEqual(f.events().filter(({ phase }) => ["dependencies", "prepare", "publish"].includes(phase)).map(({ phase }) => phase),
    ["dependencies", "prepare", "dependencies", "prepare", "publish"]);
  assert.doesNotMatch(result.stdout + result.stderr, /TEST_ORIGINAL_API_KEY|TEST_REPLACEMENT_API_KEY/);
});

test("failed new credential creation removes the newly written key and selection", { timeout: testTimeout }, async (t) => {
  const f = await fixture(t);
  const key = path.join(f.state, "xai-api-key.secret");
  const files = [key, f.selection, f.cache];
  const before = snapshot(files);
  const result = await f.control(["credential", "grok-api"], { FIXTURE_PROVIDER_FAIL_PHASE: "dependencies" }, "TEST_NEW_API_KEY\n");
  assert.notEqual(result.status, 0);
  assertSnapshot(files, before);
  assert.equal(f.events().filter(({ phase }) => phase === "publish").length, 1, "only restored state reaches client publication");
});

test("failed credential removal restores all primary and legacy files plus exact selection and cache", { timeout: testTimeout }, async (t) => {
  const f = await fixture(t);
  seedState(f, "kimi-api");
  const primary = path.join(f.state, "kimi-api-key.secret");
  const legacyName = path.join(f.state, "api-key.secret");
  const legacyHome = path.join(f.codex, "kimi-router", "kimi-api-key.secret");
  const prototypeHome = path.join(f.codex, "kimi-proxy", "api-key.secret");
  for (const [index, file] of [primary, legacyName, legacyHome, prototypeHome].entries()) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `TEST_LEGACY_API_KEY_${index}\n`);
  }
  const files = [primary, legacyName, legacyHome, prototypeHome, f.selection, f.cache];
  const before = snapshot(files);
  const result = await f.control(["credential", "kimi-api", "--remove"], { FIXTURE_PROVIDER_FAIL_PHASE: "publish" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Synthetic publish failure/);
  assertSnapshot(files, before);
  assert.equal(f.events().filter(({ phase }) => phase === "publish").length, 2, "candidate failure must be followed by restored publication");
  assert.doesNotMatch(result.stdout + result.stderr, /TEST_LEGACY_API_KEY/);
});

test("absent credential removal does not prepare, restart or publish any model state", { timeout: testTimeout }, async (t) => {
  const f = await fixture(t);
  seedState(f, "custom");
  const files = [f.selection, f.cache];
  const before = snapshot(files);
  const result = await f.control(["credential", "grok-api", "--remove"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).removal.removedFiles, 0);
  assertSnapshot(files, before);
  assert.deepEqual(f.events().filter(({ phase }) => phase !== "control"), []);
});

test("a live foreground router blocks credential client publication and rolls back its key", { timeout: testTimeout }, async (t) => {
  const f = await fixture(t);
  seedState(f, "custom");
  const key = path.join(f.state, "xai-api-key.secret");
  const files = [key, f.selection, f.cache];
  const before = snapshot(files);
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, service: "codex-router", degraded: [] }));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(f.port, "127.0.0.1", resolve); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const result = await f.control(["credential", "grok-api"], {}, "TEST_FOREGROUND_BLOCKED_KEY\n");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /foreground router.*cannot be reloaded/);
  assertSnapshot(files, before);
  assert.equal(f.events().some(({ phase }) => phase === "publish"), false);
});

for (const phase of ["prepare", "publish"]) {
test(`failed Antigravity ${phase} retains irreversible disconnect fence and withdrawn selection`, { timeout: testTimeout }, async (t) => {
  const f = await fixture(t);
  seedState(f, "antigravity-oauth");
  const token = path.join(f.state, "antigravity-oauth.json");
  const fence = `${token}.disconnect-fence.json`;
  // An exact empty directory is intentionally incompatible, and can be removed
  // without opening a token document or preserving stale OAuth bytes.
  mkdirSync(token);
  writeFileSync(fence, '{"version":1,"generation":"old-disconnect-generation"}\n');
  const result = await f.control(["credential", "antigravity-oauth", "--remove"], { FIXTURE_PROVIDER_FAIL_PHASE: phase });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Antigravity remains disconnected/);
  assert.equal(existsSync(token), false);
  const disconnected = JSON.parse(readFileSync(fence, "utf8"));
  assert.notEqual(disconnected.generation, "old-disconnect-generation");
  assert.equal(JSON.parse(readFileSync(f.selection, "utf8")).providers.includes("antigravity-oauth"), false);
  assert.equal(f.events().filter((entry) => entry.phase === "publish").length, phase === "publish" ? 1 : 0);
  assert.ok(JSON.parse(result.stdout).publicationWarnings.catalogError);
  assert.doesNotMatch(result.stdout + result.stderr, /connect revival|old-disconnect-generation/);
});
}


test("an incompatible API credential entry is rejected before snapshot reads or publication", { timeout: testTimeout }, async (t) => {
  const f = await fixture(t);
  seedState(f, "custom");
  const key = path.join(f.state, "xai-api-key.secret");
  mkdirSync(key);
  const selection = readFileSync(f.selection);
  for (const args of [["credential", "grok-api"], ["credential", "grok-api", "--remove"]]) {
    const result = await f.control(args, {}, "TEST_INCOMPATIBLE_ENTRY_KEY\n");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /incompatible file entry/);
    assert.equal(existsSync(key), true);
    assert.deepEqual(readFileSync(f.selection), selection);
  }
  assert.equal(f.events().some(({ phase }) => phase === "dependencies" || phase === "publish"), false);
});


test("credential mutation refuses a short inherited epoch before changing managed files", { timeout: testTimeout }, async (t) => {
  const f = await fixture(t);
  seedState(f, "custom");
  const key = path.join(f.state, "xai-api-key.secret");
  const files = [key, f.selection, f.cache];
  const before = snapshot(files);
  const result = await f.control(["credential", "grok-api"], {
    CODEX_ROUTER_OPERATION_DEADLINE_MS: String(Date.now() + 60_000),
  }, "TEST_SHORT_EPOCH_KEY\n");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /deadline|epoch|allowance/i);
  assertSnapshot(files, before);
  assert.equal(f.events().some(({ phase }) => phase === "dependencies" || phase === "publish"), false);
});

test("cache invalidation failure after physical OAuth removal reports the retained disconnect", { timeout: testTimeout }, async (t) => {
  const f = await fixture(t);
  seedState(f, "antigravity-oauth");
  const token = path.join(f.state, "antigravity-oauth.json");
  const fence = `${token}.disconnect-fence.json`;
  mkdirSync(token);
  rmSync(f.cache);
  mkdirSync(f.cache);
  const result = await f.control(["credential", "antigravity-oauth", "--remove"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Antigravity remains disconnected/);
  assert.equal(existsSync(token), false);
  assert.equal(existsSync(fence), true);
  assert.equal(JSON.parse(readFileSync(f.selection, "utf8")).providers.includes("antigravity-oauth"), false);
  assert.match(JSON.parse(result.stdout).publicationWarnings.catalogError, /could not be invalidated/);
});
