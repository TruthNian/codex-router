import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Exercise real callers and the real atomic writer in a fresh process. Only
// service-manager calls and checkout ACL changes are stubbed: the Windows
// private-file helper runs for real, against synthetic data in scratch state.
// Builtin instrumentation observes ordering and injects a failed operation;
// it does not replace the private writer with a test-shaped implementation.
const runner = String.raw`
import assert from "node:assert/strict";
import cp from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [root, kind, mode] = process.argv.slice(1);
const state = process.env.MODEL_ROUTER_STATE_DIR;
const url = (name) => pathToFileURL(path.join(root, "src", name)).href;
const security = await import(url("file-security.mjs"));
const originalExec = cp.execFileSync;
const originalRename = fs.renameSync;
const originalWrite = fs.writeFileSync;
const originalOpen = fs.openSync;
let helperCalls = 0;
let replacements = 0;
const temporaryPaths = new Set();

cp.execFileSync = (command, args, options = {}) => {
  if (options.env?.CODEX_ROUTER_CHECKOUT_PATH) return "";
  if (String(command).toLowerCase().includes("schtasks")) {
    throw Object.assign(new Error("synthetic task is absent"), { code: "ENOENT" });
  }
  if (options.env?.CODEX_ROUTER_PRIVATE_FILES) {
    helperCalls += 1;
    assert.equal(JSON.parse(options.env.CODEX_ROUTER_PRIVATE_FILES).length, 1);
    if (mode === "harden-failure") throw new Error("injected ACL failure");
  }
  return originalExec(command, args, options);
};
fs.openSync = (target, flags, mode) => {
  if (String(target).includes(".tmp.")) {
    assert.equal(flags, "wx", "temporary creation must be exclusive");
    assert.equal(temporaryPaths.has(target), false, "each write needs its own temporary");
    temporaryPaths.add(target);
  }
  return originalOpen(target, flags, mode);
};
fs.renameSync = (temporary, target) => {
  assert.equal(path.dirname(temporary), path.dirname(target), "replacement must remain on one volume");
  assert.equal(security.privateFileIsProtected(temporary), true, "unpublished bytes must be private before replacement");
  replacements += 1;
  if (mode === "rename-failure") throw Object.assign(new Error("injected replacement failure"), { code: "EACCES" });
  return originalRename(temporary, target);
};
syncBuiltinESMExports();

fs.mkdirSync(state, { recursive: true, mode: 0o755 });
const expected = new Map();
let write;
let captures = "";
const captureImport = async (command) => {
  const previous = process.stdout.write;
  process.argv[2] = command;
  captures = "";
  process.stdout.write = (value) => { captures += String(value); return true; };
  try { await import(url("service-windows.mjs") + "?" + command); }
  finally { process.stdout.write = previous; }
  return captures;
};

if (kind === "gateway") {
  const module = await import(url("litellm-config.mjs"));
  const target = path.join(state, "gateway", "litellm.yaml");
  for (const name of ["grok_service_tier_callback.py", "litellm_stream_cleanup_callback.py"]) {
    expected.set(path.join(path.dirname(target), name), fs.readFileSync(path.join(root, "src", name)));
  }
  expected.set(target, Buffer.from(module.renderLiteLlmConfig()));
  write = () => module.writeLiteLlmConfig(target);
} else if (kind === "selection") {
  const module = await import(url("provider-selection.mjs"));
  const { PROVIDER_SELECTION_PATH } = await import(url("paths.mjs"));
  expected.set(PROVIDER_SELECTION_PATH, Buffer.from(JSON.stringify({ version: 1, providers: ["deepseek"] }, null, 2) + "\n"));
  write = () => module.writeProviderSelection(["deepseek"]);
} else if (kind === "credential") {
  const module = await import(url("provider-credentials.mjs"));
  const provider = { id: "synthetic-writer", kind: "openai-compatible", credential: { file: "nested/fixture.key", label: "API key" } };
  expected.set(module.primaryCredentialPath(provider), Buffer.from("SYNTHETIC_KEY_ONLY\n"));
  write = () => module.writeProviderCredential(provider, " SYNTHETIC_KEY_ONLY ");
} else if (kind === "launcher") {
  const wrapper = await captureImport("render");
  const launcher = await captureImport("render-launcher");
  expected.set(path.join(state, "start-codex-router.cmd"), Buffer.from(wrapper));
  expected.set(path.join(state, "start-codex-router-hidden.vbs"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(launcher, "utf16le")]));
  write = () => captureImport("install");
} else {
  throw new Error("unknown synthetic writer");
}

// Replacement must repair a pre-existing public file, not only create a file
// in an already-private directory. These fixtures contain no real secrets.
const previous = Buffer.from("OLD_SYNTHETIC_BYTES\n");
for (const target of expected.keys()) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
  originalWrite(target, previous, { mode: 0o644 });
  assert.equal(security.privateFileIsProtected(target), false, "the ACL/mode detector needs a positive control");
}

let error;
try { await write(); } catch (cause) { error = cause; }
if (mode === "success") {
  assert.equal(error, undefined);
  assert.equal(process.exitCode || 0, 0);
  for (const [target, contents] of expected) {
    assert.deepEqual(fs.readFileSync(target), contents, "binary/text bytes must survive the shared writer");
    assert.equal(security.privateFileIsProtected(target), true);
  }
  assert.equal(replacements, expected.size);
  if (process.platform === "win32") assert.equal(helperCalls, expected.size, "one Windows ACL helper per file");
  if (process.platform !== "win32" && ["credential", "selection"].includes(kind)) {
    assert.equal(fs.statSync(state).mode & 0o777, 0o700, "these callers own their state directory's mode");
    if (kind === "credential") assert.equal(fs.statSync(path.join(state, "nested")).mode & 0o777, 0o700);
  } else if (process.platform !== "win32") {
    assert.equal(fs.statSync(state).mode & 0o777, 0o755, "other writers must preserve an existing parent's mode");
    if (kind === "gateway") assert.equal(fs.statSync(path.join(state, "gateway")).mode & 0o777, 0o755);
  }
} else {
  if (kind === "launcher") assert.equal(process.exitCode, 1, "installer must report its failed write");
  else assert.match(error?.message || "", /injected/);
  for (const target of expected.keys()) assert.deepEqual(fs.readFileSync(target), previous, "failed publication must leave previous bytes intact");
  if (process.platform === "win32") assert.equal(helperCalls, 1);
  assert.equal(replacements, mode === "rename-failure" ? 1 : 0);
  process.exitCode = 0;
}
for (const temporary of temporaryPaths) assert.equal(fs.existsSync(temporary), false, "no unpublished temporary should survive");
process.stdout.write(JSON.stringify({ files: expected.size, helperCalls, replacements }) + "\n");
`;

function exercise(kind, mode) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "router-private-callers-"));
  assert.equal(path.dirname(scratch), path.resolve(os.tmpdir()));
  assert.ok(path.basename(scratch).startsWith("router-private-callers-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => (
    !/^(MODEL_ROUTER_|CODEX_ROUTER_|CODEX_HOME$)/i.test(name)
    && !/(?:KEY|TOKEN|SECRET|PROXY)/i.test(name)
  )));
  Object.assign(env, {
    CODEX_HOME: path.join(scratch, "codex"),
    MODEL_ROUTER_STATE_DIR: path.join(scratch, "state-目录"),
    MODEL_ROUTER_USER_MODELS: path.join(scratch, "models.json"),
    CODEX_ROUTER_NO_DISCOVERY: "1",
    MODEL_ROUTER_SKIP_SERVICE_MANAGER: "1",
    CODEX_ROUTER_SERVICE_PLATFORM: "win32",
    NODE_TEST_CONTEXT: "private-writer-fixture",
  });
  try {
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", runner, root, kind, mode], {
      cwd: root, env, encoding: "utf8", timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    return JSON.parse(output.trim());
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

for (const kind of ["gateway", "selection", "credential", "launcher"]) {
  test(`${kind} publishes exact bytes privately with one Windows ACL operation per file`, () => {
    assert.ok(exercise(kind, "success").files >= 1);
  });
  test(`${kind} rejects failed hardening before replacing previous files`, {
    skip: process.platform !== "win32" ? "Windows ACL failure injection" : false,
  }, () => {
    assert.equal(exercise(kind, "harden-failure").replacements, 0);
  });
  test(`${kind} cleans an unpublished private temporary after replacement fails`, () => {
    assert.equal(exercise(kind, "rename-failure").replacements, 1);
  });
}
