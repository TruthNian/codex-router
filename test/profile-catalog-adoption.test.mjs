import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { runProcessTree } from "../src/process-tree.mjs";
import { withModelOverlayLock } from "../src/model-overlay-lock.mjs";
import { publishAdoptedModelOverlayFresh, publishAdoptedModelOverlayPublication,
  verifyAdoptedModelOverlayFresh, verifyAdoptedModelOverlayPublication } from "../src/model-overlay-publication.mjs";
import { verifyRouterExecutionPlanAdoption } from "../src/router-restart.mjs";
import { userModelEntry } from "../src/user-models.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FINGERPRINT = "a".repeat(64);

test("only an explicit verify-only caller may accept confirmed offline ownership", async () => {
  const absent = async (options) => verifyRouterExecutionPlanAdoption({ ...options,
    serviceStatus: async () => ({ installed: false, loaded: false }),
    waitForHealth: async () => ({ ok: false, connectionRefused: true }) });
  const options = { executionPlan: () => ({ fingerprint: FINGERPRINT }), verifyAdoption: absent };
  await assert.rejects(verifyAdoptedModelOverlayPublication(options), { code: "model_overlay_adoption_failed" });
  assert.deepEqual(await verifyAdoptedModelOverlayPublication({ ...options, allowOffline: true }), { expectedFingerprint: FINGERPRINT });
  await assert.rejects(verifyAdoptedModelOverlayPublication({ ...options, allowOffline: "true" }), { code: "model_overlay_adoption_failed" });
  await assert.rejects(publishAdoptedModelOverlayPublication({ ...options, allowOffline: true,
    refreshTargets: () => assert.fail("events cannot publish an offline candidate") }), { code: "model_overlay_adoption_failed" });
});

test("fresh offline permission reaches only the verify child while holding the model lock", async (t) => {
  const state = mkdtempSync(path.join(os.tmpdir(), "profile-adoption-lock-"));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const seen = [];
  const options = { executable: process.execPath, environment: { ...process.env,
    MODEL_ROUTER_STATE_DIR: state, CODEX_ROUTER_STATE_DIR: state }, allowOffline: true,
    run: async (_command, args) => {
      seen.push(args);
      return { status: 0, stdout: JSON.stringify({ expectedFingerprint: FINGERPRINT }) };
    } };
  await withModelOverlayLock(() => verifyAdoptedModelOverlayFresh(options), { stateDir: state });
  assert.deepEqual(seen[0].slice(1), ["--verify-adopted-in-fresh-process", "--allow-confirmed-offline"]);
  await publishAdoptedModelOverlayFresh(options);
  assert.deepEqual(seen[1].slice(1), ["--publish-adopted-in-fresh-process"]);
  assert.equal(existsSync(path.join(state, "merged-models.json")), false);
  assert.equal(existsSync(path.join(state, "litellm.yaml")), false);
});

// The actual profile implementation and fresh verifier both run in a child.
// Only service-manager reads and the synthetic Codex executable are replaced;
// native auth, snapshots, locks, private writes, rollback and publication are
// the real implementation. The hook is inherited by the fresh verification
// child so no fixture can query the host scheduler or run the installed Codex.
const PRELOADER = String.raw`
import { createRequire, syncBuiltinESMExports } from "node:module";
import { appendFileSync } from "node:fs";
import path from "node:path";
const cp = createRequire(import.meta.url)("node:child_process");
const originalSync = cp.execFileSync, originalAsync = cp.execFile;
const record = (kind) => appendFileSync(process.env.FIXTURE_CALLS, kind + "\n");
const managerScript = (args) => String(args?.at(-1) || "").includes("Get-ScheduledTask");
function managerAnswer(args) {
  record("service-read");
  if (process.env.FIXTURE_SERVICE === "unknown") throw Object.assign(new Error("fixture scheduler denied"), { code: "EACCES" });
  if (String(args.at(-1)).includes("Get-ScheduledTask -ErrorAction Stop")) {
    return process.env.FIXTURE_SERVICE === "installed" ? "present" : "absent";
  }
  return "Ready";
}
cp.execFileSync = (command, args, options) => {
  if (path.resolve(String(command)) === path.resolve(process.env.CODEX_BIN)) {
    record("codex-read");
    if (args[0] === "--version") return "codex-cli 0.150.0";
    if (args[0] === "login" && args[1] === "status") return "";
    if (args[0] === "debug" && args[1] === "models") return JSON.stringify({ models: [] });
    throw new Error("unexpected synthetic Codex command");
  }
  if (path.basename(String(command)).toLowerCase() === "schtasks.exe") {
    record("service-read");
    if (args[0] !== "/Query") throw new Error("fixture forbids service mutations");
    if (process.env.FIXTURE_SERVICE === "installed") return "fixture task";
    throw Object.assign(new Error("fixture named task query failed"), { status: 1 });
  }
  if (managerScript(args)) return managerAnswer(args);
  // Canonical file-security ACL operations remain real, on fixture paths.
  return originalSync(command, args, options);
};
cp.execFile = (command, args, options, callback) => {
  if (managerScript(args)) {
    record("service-read");
    queueMicrotask(() => callback(undefined, "0|0|0", ""));
    return undefined;
  }
  return originalAsync(command, args, options, callback);
};
syncBuiltinESMExports();
`;

const PROFILE_CHILD = String.raw`
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { writePrivateFile } from "./src/file-security.mjs";
import { CODEX_HOME, STATE_DIR, NATIVE_CATALOG_PATH, MERGED_CATALOG_PATH, NATIVE_ALIAS_PATH,
  ANNOUNCED_MODELS_PATH, MODELS_CACHE_PATH } from "./src/paths.mjs";
import { createChatGPTSubscriptionAccount, chatGPTSubscriptionAccountAuthPath,
  chatGPTSubscriptionAccountCatalogDir } from "./src/chatgpt-account-pool.mjs";
import { requestChatGPTProfileSwitch, readChatGPTProfileSwitchState } from "./src/chatgpt-profile-switch.mjs";
const first = createChatGPTSubscriptionAccount(), second = createChatGPTSubscriptionAccount();
const auth = (name) => JSON.stringify({ tokens: { access_token: name + "_synthetic_token", account_id: name } });
const firstAuth = auth("first_fixture"), secondAuth = auth("second_fixture");
const primary = path.join(CODEX_HOME, "auth.json");
writePrivateFile(primary, firstAuth);
writePrivateFile(chatGPTSubscriptionAccountAuthPath(first.id), firstAuth);
writePrivateFile(chatGPTSubscriptionAccountAuthPath(second.id), secondAuth);
const native = (slug) => ({ models: [{ slug, display_name: slug, description: "Fixture model",
  visibility: "list", context_window: 131072, auto_compact_token_limit: 110000,
  default_reasoning_level: "medium", supported_reasoning_levels: [{ effort: "medium", description: "Medium" }] }] });
const paths = [MODELS_CACHE_PATH, NATIVE_CATALOG_PATH, MERGED_CATALOG_PATH, NATIVE_ALIAS_PATH, ANNOUNCED_MODELS_PATH];
for (const file of paths) writePrivateFile(file, JSON.stringify(native("gpt-old-fixture")));
const secondCatalog = chatGPTSubscriptionAccountCatalogDir(second.id);
mkdirSync(secondCatalog, { recursive: true });
for (const name of ["models_cache.json", "native-models.json", "merged-models.json"]) {
  writePrivateFile(path.join(secondCatalog, name), JSON.stringify(native("gpt-new-fixture")));
}
if (process.env.FIXTURE_STALE === "1") {
  await import("./src/model-registry.mjs");
  const file = process.env.MODEL_ROUTER_REGISTRY;
  const registry = JSON.parse(readFileSync(file, "utf8"));
  registry.models[0].endpoint.baseUrl = "http://127.0.0.1:9998/v1";
  writeFileSync(file, JSON.stringify(registry));
}
const before = paths.map((file) => readFileSync(file));
let result, error;
try { result = await requestChatGPTProfileSwitch(second.id, { platform: "darwin", processList: "" }); }
catch (caught) { error = caught.message; }
const switched = readFileSync(primary, "utf8") === secondAuth;
const restored = readFileSync(primary, "utf8") === firstAuth;
const catalogsRestored = paths.every((file, index) => existsSync(file) && readFileSync(file).equals(before[index]));
const profile = readChatGPTProfileSwitchState();
const slugs = JSON.parse(readFileSync(NATIVE_CATALOG_PATH, "utf8")).models.map((model) => model.slug);
assert.equal(existsSync(path.join(STATE_DIR, "litellm.yaml")), false);
process.stdout.write(JSON.stringify({ switched, restored, catalogsRestored, error,
  pending: profile.pending, settled: result?.active === second.id && !result.pending, slugs }) + "\n");
`;

async function profileFixture(t, { service = "absent", health, staleRegistry = false } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "profile-adoption-real-"));
  const home = path.join(directory, "codex"), state = path.join(directory, "state"), user = path.join(directory, "user");
  for (const folder of [home, state, user]) mkdirSync(folder, { recursive: true });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const preloader = path.join(directory, "fixture-hook.mjs"), fakeCodex = path.join(directory, "codex.exe");
  const calls = path.join(directory, "fixture-calls.txt"), registry = path.join(directory, "registry.json");
  writeFileSync(preloader, PRELOADER); writeFileSync(fakeCodex, "synthetic binary placeholder");
  writeFileSync(registry, JSON.stringify({ version: 1, providers: [{ id: "custom", displayName: "Fixture custom",
    kind: "openai-compatible", ownedBy: "fixture", authMode: "per-model", perModelEndpoint: true }],
    models: [{ ...userModelEntry({ providerId: "custom", upstreamId: "fixture", priority: 100 }),
      endpoint: { baseUrl: "http://127.0.0.1:9999/v1", keyless: true, protocol: "openai-responses" } }] }));
  writeFileSync(path.join(state, "enabled-providers.json"), JSON.stringify({ version: 1, providers: ["custom"] }));
  writeFileSync(path.join(state, "user-models.json"), JSON.stringify({ version: 1, models: [] }));
  writeFileSync(path.join(state, "generic-providers.json"), JSON.stringify({ version: 1, providers: [] }));
  const server = http.createServer((request, response) => {
    assert.equal(request.url, "/health", "only fixture readiness requests are authorized");
    response.writeHead(health?.status || 200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(health?.payload || {}));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  if (!health) await new Promise((resolve) => server.close(resolve));
  else t.after(() => new Promise((resolve) => server.close(resolve)));
  const environment = { ...process.env, HOME: user, USERPROFILE: user, CODEX_HOME: home,
    APPDATA: path.join(user, "AppData", "Roaming"), LOCALAPPDATA: path.join(user, "AppData", "Local"),
    KIMI_CODE_HOME: path.join(directory, "kimi"), DSH_HOME: path.join(directory, "dsh"),
    GEMINI_CLI_HOME: path.join(directory, "gemini"), CURSOR_HOME: path.join(directory, "cursor"),
    XDG_CONFIG_HOME: path.join(directory, "xdg"), CODEX_BIN: fakeCodex,
    CODEX_ROUTER_SOURCE_ROOT: ROOT, MODEL_ROUTER_STATE_DIR: state, CODEX_ROUTER_STATE_DIR: state,
    MODEL_ROUTER_TARGET: "codex", CODEX_ROUTER_SERVICE_PLATFORM: "win32",
    MODEL_ROUTER_REGISTRY: registry, MODEL_ROUTER_USER_MODELS: path.join(state, "user-models.json"),
    MODEL_ROUTER_GENERIC_PROVIDERS: path.join(state, "generic-providers.json"),
    MODEL_ROUTER_PORT: String(port), CODEX_ROUTER_PORT: String(port), CODEX_ROUTER_NO_DISCOVERY: "0",
    FIXTURE_CALLS: calls, FIXTURE_SERVICE: service, FIXTURE_STALE: staleRegistry ? "1" : "0",
    NODE_OPTIONS: `--import=${pathToFileURL(preloader).href}` };
  for (const key of ["HOME", "USERPROFILE", "CODEX_HOME", "APPDATA", "LOCALAPPDATA", "KIMI_CODE_HOME", "DSH_HOME",
    "GEMINI_CLI_HOME", "CURSOR_HOME", "XDG_CONFIG_HOME", "CODEX_BIN", "MODEL_ROUTER_STATE_DIR", "CODEX_ROUTER_STATE_DIR",
    "MODEL_ROUTER_REGISTRY", "MODEL_ROUTER_USER_MODELS", "MODEL_ROUTER_GENERIC_PROVIDERS"]) {
    const relative = path.relative(directory, environment[key]);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), `${key} escaped fixture`);
  }
  const child = await runProcessTree(process.execPath, ["--input-type=module", "--eval", PROFILE_CHILD], {
    cwd: ROOT, env: environment, deadline: Date.now() + 60_000, windowsHide: true,
  });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1));
  const reads = existsSync(calls) ? readFileSync(calls, "utf8").trim().split(/\r?\n/) : [];
  return { ...result, reads };
}

test("default native profile switch completes with no installed or running Router", async (t) => {
  const result = await profileFixture(t);
  assert.equal(result.error, undefined);
  assert.equal(result.switched, true);
  assert.equal(result.settled, true);
  assert.equal(result.pending, false);
  assert.ok(result.slugs.includes("gpt-new-fixture"));
  assert.equal(result.slugs.includes("gpt-old-fixture"), false);
  assert.ok(result.reads.filter((read) => read === "service-read").length >= 4,
    "both fresh and in-process validators must verify offline ownership");
});

for (const options of [
  { service: "unknown" },
  { service: "installed" },
  { health: { status: 503, payload: { service: "codex-router", degraded: ["api"], executionPlan: { fingerprint: FINGERPRINT } } } },
  { health: { status: 200, payload: { service: "foreign-service", executionPlan: { fingerprint: FINGERPRINT } } } },
  { health: { status: 200, payload: { service: "codex-router", executionPlan: { fingerprint: FINGERPRINT } } } },
  { staleRegistry: true },
]) {
  const name = options.staleRegistry ? "stale publishing process" : options.health
    ? `${options.health.status} ${options.health.payload.service} with unadopted routes` : `${options.service} service ownership`;
  test(`default profile switch refuses ${name} and restores exact auth/catalog bytes`, async (t) => {
    const result = await profileFixture(t, options);
    assert.ok(result.error);
    if (options.staleRegistry) assert.match(result.error, /stale routing generation/);
    else if (options.health?.status === 200 && options.health.payload.service === "codex-router") assert.match(result.error, /not adopted/);
    else assert.match(result.error, /healthy router/);
    assert.equal(result.switched, false);
    assert.equal(result.restored, true);
    assert.equal(result.catalogsRestored, true);
    assert.equal(result.pending, true);
  });
}
