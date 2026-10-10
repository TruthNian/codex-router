import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runner = String.raw`
import assert from "node:assert/strict";
import cp from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [root, kind, mode] = process.argv.slice(1);
const load = (name) => import(pathToFileURL(path.join(root, "src", name)).href);
const security = await load("file-security.mjs");
const paths = await load("paths.mjs");
const json = (value) => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const expected = new Map();
const previous = new Map();
let write;

if (kind === "default") {
  const module = await load("codex-default-model.mjs");
  const value = { version: 1, model: "custom/fixture", previousPresent: true, previousModel: "gpt-fixture" };
  expected.set(paths.CODEX_DEFAULT_MODEL_PATH, json(value));
  write = () => module.writeCodexRouterDefault(value);
} else if (kind === "vertex") {
  const module = await load("vertex-state.mjs");
  expected.set(module.VERTEX_STATE_PATH, json({ version: 1, projectId: "fixture-project", location: "us-central1" }));
  write = () => module.setVertexConfiguration({ projectId: "fixture-project", location: "us-central1" });
} else if (kind === "harness") {
  const module = await load("routed-harness-document.mjs");
  const target = path.join(paths.STATE_DIR, "client", "settings.yaml");
  const contents = "# caller-owned comment\nsetting: fixture\n";
  expected.set(target, Buffer.from(contents));
  write = () => assert.equal(module.writeHarnessDocument(target, contents), target);
} else if (kind === "picker") {
  const module = await load("model-picker-state.mjs");
  previous.set(module.MODEL_PICKER_STATE_PATH, json({ version: 1, hidden: [], visible: [], seeded: [] }));
  expected.set(module.MODEL_PICKER_STATE_PATH, json({ version: 1, hidden: [], visible: [], seeded: [], order: "routed-first" }));
  write = () => module.setPickerOrder("routed-first");
} else if (kind === "local") {
  const module = await load("local-models.mjs");
  previous.set(module.LOCAL_MODELS_STATE_PATH, json({ version: 1, enabled: [] }));
  expected.set(module.LOCAL_MODELS_STATE_PATH, json({ version: 1, enabled: ["fixture:latest"] }));
  write = () => module.setLocalModelEnabled("fixture:latest", true, { capabilitiesFor: () => ["completion", "tools"] });
} else if (kind === "agent") {
  const module = await load("codex-agent-catalog.mjs");
  const model = { slug: "custom/fixture", displayName: "Fixture" };
  const { subagentEffort } = await load("multi-agent-state.mjs");
  const definition = module.routedAgentDefinition(model, { effort: subagentEffort(model.slug) });
  expected.set(path.join(paths.CODEX_AGENTS_DIR, definition.fileName), Buffer.from(definition.contents));
  write = () => module.syncRoutedCodexAgents([model]);
} else if (kind === "native-source") {
  const module = await load("native-catalog-source.mjs");
  const sourcePath = path.join(paths.CODEX_HOME, "native-fixture.json");
  fs.mkdirSync(paths.CODEX_HOME, { recursive: true });
  fs.writeFileSync(sourcePath, json({ models: [{ slug: "gpt-fixture" }] }));
  previous.set(paths.NATIVE_CATALOG_SOURCE_PATH, json({ version: 1, path: sourcePath, status: "pending" }));
  expected.set(paths.NATIVE_CATALOG_SOURCE_PATH, json({ version: 1, path: sourcePath, status: "active" }));
  write = () => module.activateNativeCatalogSource();
} else if (kind === "secret") {
  for (const target of [paths.INTERNAL_SECRET_PATH, paths.CALLER_SECRET_PATH, paths.CURSOR_PUBLIC_SECRET_PATH]) {
    expected.set(target, null);
    if (["repair", "status"].includes(mode)) previous.set(target, Buffer.from("SYNTHETIC_" + "x".repeat(40) + "\n"));
  }
  write = async () => {
    process.argv[2] = mode === "status" ? "status" : "ensure";
    await load("secret.mjs");
  };
} else {
  throw new Error("unknown synthetic writer");
}

for (const target of expected.keys()) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
  const before = previous.get(target) || Buffer.from("OLD_SYNTHETIC_BYTES\n");
  previous.set(target, before);
  fs.writeFileSync(target, before, { mode: 0o644 });
  assert.equal(security.privateFileIsProtected(target), false, "permission detector must identify the public fixture");
}

const originalExec = cp.execFileSync;
const originalRename = fs.renameSync;
const originalOpen = fs.openSync;
const isFocusedTemporary = (temporary) => [...expected.keys()].some((target) => String(temporary).startsWith(target + ".tmp."));
let helperCalls = 0;
let replacements = 0;
let injected = false;
const temporaries = new Set();
cp.execFileSync = (command, args, options = {}) => {
  if (options.env?.CODEX_ROUTER_PRIVATE_FILES) {
    const focused = JSON.parse(options.env.CODEX_ROUTER_PRIVATE_FILES).some((target) => isFocusedTemporary(target) || expected.has(target));
    if (focused) {
      helperCalls += 1;
      if (mode === "harden-failure" && !injected) {
        injected = true;
        throw new Error("injected ACL failure");
      }
    }
  }
  return originalExec(command, args, options);
};
fs.openSync = (target, flags, mode) => {
  if (isFocusedTemporary(target)) {
    assert.equal(flags, "wx", "publication requires an exclusive temporary");
    assert.equal(temporaries.has(target), false);
    temporaries.add(target);
  }
  return originalOpen(target, flags, mode);
};
fs.renameSync = (temporary, target) => {
  if (expected.has(target)) {
    assert.equal(path.dirname(temporary), path.dirname(target));
    assert.equal(security.privateFileIsProtected(temporary), true, "harden before publishing");
    replacements += 1;
    if (mode === "rename-failure" && !injected) {
      injected = true;
      throw new Error("injected replacement failure");
    }
  }
  return originalRename(temporary, target);
};
syncBuiltinESMExports();

let output = "";
const originalStdout = process.stdout.write;
process.stdout.write = (value) => { output += String(value); return true; };
let error;
try { await write(); } catch (cause) { error = cause; }
finally { process.stdout.write = originalStdout; }

if (mode.endsWith("failure")) {
  assert.ok(error, "the failed operation must propagate");
  assert.equal(injected, true);
  for (const [target, before] of previous) assert.deepEqual(fs.readFileSync(target), before, "failed write preserves old bytes");
} else {
  assert.equal(error, undefined);
  for (const [target, contents] of expected) {
    const bytes = fs.readFileSync(target);
    if (kind === "secret") {
      assert.match(bytes.toString("utf8"), /^[A-Za-z0-9_-]{32,}\n$/);
      assert.equal(output.includes(bytes.toString("utf8").trim()), false, "secret status must remain redacted");
      if (["repair", "status"].includes(mode)) assert.deepEqual(bytes, previous.get(target), "repair never regenerates a valid secret");
    } else assert.deepEqual(bytes, contents);
    assert.equal(security.privateFileIsProtected(target), true);
  }
  if (process.platform === "win32") assert.equal(helperCalls, expected.size, "one ACL helper per file, including newly generated secret status");
  assert.equal(replacements, ["repair", "status"].includes(mode) ? 0 : expected.size);
  if (kind === "secret") assert.equal(JSON.parse(output).present, true);
}
for (const temporary of temporaries) assert.equal(fs.existsSync(temporary), false, "unpublished temporary must be removed");
process.stdout.write(JSON.stringify({ files: expected.size, helperCalls, replacements }) + "\n");
`;

function exercise(kind, mode) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "router-private-more-"));
  assert.equal(path.dirname(scratch), path.resolve(os.tmpdir()));
  assert.ok(path.basename(scratch).startsWith("router-private-more-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => (
    !/^(MODEL_ROUTER_|CODEX_ROUTER_|CODEX_HOME$)/i.test(name)
    && !/(?:KEY|TOKEN|SECRET|PROXY)/i.test(name)
  )));
  Object.assign(env, {
    CODEX_HOME: path.join(scratch, "codex"),
    MODEL_ROUTER_STATE_DIR: path.join(scratch, "state"),
    MODEL_ROUTER_USER_MODELS: path.join(scratch, "models.json"),
    CODEX_ROUTER_NO_DISCOVERY: "1",
    MODEL_ROUTER_SKIP_SERVICE_MANAGER: "1",
  });
  try {
    return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", runner, root, kind, mode], {
      cwd: root, env, encoding: "utf8", timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    }).trim());
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

for (const kind of ["default", "vertex", "harness", "picker", "local", "agent", "native-source"]) {
  test(`${kind} writer preserves content and publishes with one Windows ACL operation`, () => {
    assert.equal(exercise(kind, "success").files, 1);
  });
  test(`${kind} writer retains previous bytes when ACL hardening fails`, {
    skip: process.platform !== "win32" ? "Windows ACL failure injection" : false,
  }, () => exercise(kind, "harden-failure"));
  test(`${kind} writer retains previous bytes and cleans up after failed replacement`, () => exercise(kind, "rename-failure"));
}

for (const mode of ["success", "repair", "status"]) {
  test(`router secret ${mode} protects each file once without printing or replacing existing valid keys`, () => {
    assert.equal(exercise("secret", mode).files, 3);
  });
}
test("router secret creation fails closed and removes unpublished bytes when hardening fails", {
  skip: process.platform !== "win32" ? "Windows ACL failure injection" : false,
}, () => exercise("secret", "harden-failure"));
