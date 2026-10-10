import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const driver = String.raw`
import assert from "node:assert/strict";
import cp from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [repository, kind, mode] = process.argv.slice(1);
const load = (name) => import(pathToFileURL(path.join(repository, "src", name)).href);
const security = await load("file-security.mjs");
const state = process.env.MODEL_ROUTER_STATE_DIR;
fs.mkdirSync(state, { recursive: true });
let target = path.join(state, "fixture.json");
let expected = Buffer.from([0, 255, 13, 10, 65]);
let previous = Buffer.from("OLD_SYNTHETIC_BYTES\n");
let write;
let backup;

if (kind === "kimi") {
  target = path.join(process.env.KIMI_CODE_HOME, "credentials", "kimi-code.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(path.join(process.env.KIMI_CODE_HOME, "device_id"), "synthetic-device\n");
  previous = Buffer.from(JSON.stringify({ access_token: "synthetic-old-access", refresh_token: "synthetic-old-refresh", expires_at: 1, expires_in: 3600, scope: "kimi-code", token_type: "Bearer" }) + "\n");
  globalThis.fetch = async () => new Response(JSON.stringify({ access_token: "synthetic-new-access", refresh_token: "synthetic-new-refresh", expires_in: 3600 }), { status: 200, headers: { "Content-Type": "application/json" } });
  const module = await load("kimi-oauth-session.mjs");
  write = () => module.ensureFreshKimiOAuthToken({ force: true });
} else if (kind === "store") {
  const module = await load("provider-credential-store.mjs");
  target = path.join(state, "references.json");
  const value = { schemaVersion: 2, credentials: [] };
  expected = Buffer.from(JSON.stringify(value, null, 2) + "\n");
  write = () => module.writeProviderCredentialStore(value, target);
} else if (kind === "copy") {
  const module = await load("chatgpt-profile-switch.mjs");
  const source = path.join(state, "source-auth.json");
  fs.writeFileSync(source, expected);
  write = () => module.atomicPrivateCopy(source, target, mode.startsWith("custom") ? {
    protect(file) {
      events.push(file === target ? "custom-final" : "custom-temporary");
      security.protectPrivateFile(file);
      if (mode === "custom-final-failure" && file === target) throw new Error("injected final protection failure");
    },
  } : {});
} else if (kind === "rotation") {
  const module = await load("caller-key-rotation.mjs");
  target = path.join(state, "caller-secret");
  const operationId = "a".repeat(32);
  previous = Buffer.from("o".repeat(48) + "\n");
  expected = Buffer.from("n".repeat(48) + "\n");
  backup = module.callerCapabilityBackupPath(target, operationId);
  write = () => module.swapCallerCapability({ secretPath: target, operationId, generateSecret: () => expected.toString().trim() });
} else if (kind === "async") {
  write = () => security.writePrivateFileAsync(target, expected);
} else if (kind === "durable") {
  write = () => security.writePrivateFile(target, expected, { fsync: true });
} else throw new Error("unknown synthetic writer");

fs.writeFileSync(target, previous, { mode: 0o644 });
assert.equal(security.privateFileIsProtected(target), false, "permission detector needs a public positive control");
const original = { open: fs.openSync, write: fs.writeFileSync, close: fs.closeSync, fsync: fs.fsyncSync, rename: fs.renameSync, unlink: fs.unlinkSync, copy: fs.copyFileSync, exec: cp.execFileSync, spawn: cp.spawn };
const temporaries = new Set();
const descriptors = new Set();
const activeDescriptors = new Set();
const closed = new Set();
const events = [];
let helperCalls = 0;
let injected = false;
let collision;
const focused = (file) => String(file).startsWith(target + ".tmp") || String(file).startsWith(target + ".rotate-new.");
const fault = (phase) => Object.assign(new Error("injected " + phase + " failure"), { code: "EACCES" });

fs.openSync = (file, flags, permission) => {
  if (!focused(file)) return original.open(file, flags, permission);
  assert.equal(flags, "wx");
  assert.equal(permission, 0o600);
  if (mode === "collision") {
    collision = file;
    original.write(file, "UNOWNED_COLLISION\n");
  }
  const descriptor = original.open(file, flags, permission);
  temporaries.add(file);
  descriptors.add(descriptor);
  activeDescriptors.add(descriptor);
  events.push("open");
  return descriptor;
};
fs.writeFileSync = (file, contents, options) => {
  if (activeDescriptors.has(file)) {
    events.push("write");
    if (mode === "write-failure") { injected = true; original.write(file, Buffer.from("PARTIAL")); throw fault("write"); }
  }
  return original.write(file, contents, options);
};
fs.fsyncSync = (descriptor) => {
  if (activeDescriptors.has(descriptor)) {
    events.push("fsync");
    if (mode === "falsy-fsync-close-failure") { injected = true; throw 0; }
    if (["fsync-failure", "fsync-close-failure"].includes(mode)) { injected = true; throw fault("fsync"); }
  }
  return original.fsync(descriptor);
};
fs.closeSync = (descriptor) => {
  const focusedDescriptor = activeDescriptors.has(descriptor);
  const result = original.close(descriptor);
  if (focusedDescriptor) {
    activeDescriptors.delete(descriptor);
    closed.add(descriptor);
    events.push("close");
    if (["close-failure", "fsync-close-failure", "falsy-fsync-close-failure"].includes(mode)) { injected = true; throw fault("close"); }
  }
  return result;
};
fs.copyFileSync = (source, temporary, flags) => {
  if (focused(temporary)) {
    assert.equal(flags, fs.constants.COPYFILE_EXCL);
    if (mode === "collision") { collision = temporary; original.write(temporary, "UNOWNED_COLLISION\n"); }
  }
  const result = original.copy(source, temporary, flags);
  if (focused(temporary)) temporaries.add(temporary);
  return result;
};
cp.execFileSync = (command, args, options = {}) => {
  if (options.env?.CODEX_ROUTER_PRIVATE_FILES) {
    const files = JSON.parse(options.env.CODEX_ROUTER_PRIVATE_FILES);
    if (files.some((file) => focused(file) || file === target || file === backup)) {
      helperCalls += 1;
      events.push("protect");
      for (const descriptor of descriptors) assert.ok(closed.has(descriptor), "close the completed write before hardening");
      if ((mode === "harden-failure" && files.some(focused)) || (mode === "backup-failure" && files.includes(backup))) { injected = true; throw fault("ACL"); }
    }
  }
  return original.exec(command, args, options);
};
cp.spawn = (command, args, options = {}) => {
  if (options.env?.CODEX_ROUTER_PRIVATE_FILES) { helperCalls += 1; events.push("protect"); }
  return original.spawn(command, args, options);
};
fs.renameSync = (temporary, destination) => {
  if (destination === target && focused(temporary)) {
    events.push("rename");
    assert.equal(path.dirname(temporary), path.dirname(destination));
    assert.equal(security.privateFileIsProtected(temporary), true, "temporary ACL must be private before replacement");
    if (["rename-failure", "cleanup-failure"].includes(mode)) { injected = true; throw fault("rename"); }
  }
  return original.rename(temporary, destination);
};
fs.unlinkSync = (file) => {
  if (mode === "cleanup-failure" && temporaries.has(file)) throw fault("cleanup");
  return original.unlink(file);
};
syncBuiltinESMExports();

let error;
try { await write(); } catch (cause) { error = cause; }
if (mode === "collision") {
  assert.equal(error?.code, "EEXIST");
  assert.equal(temporaries.size, 0);
  assert.equal(fs.readFileSync(collision, "utf8"), "UNOWNED_COLLISION\n");
  assert.deepEqual(fs.readFileSync(target), previous);
} else if (mode === "custom-final-failure") {
  assert.match(error?.message || "", /injected final/);
  assert.deepEqual(fs.readFileSync(target), expected);
  assert.equal(security.privateFileIsProtected(target), true);
} else if (mode === "falsy-fsync-close-failure") {
  assert.equal(error, 0, "a secondary close error must never replace the original thrown value");
  assert.equal(injected, true);
  assert.deepEqual(fs.readFileSync(target), previous);
} else if (mode.endsWith("failure")) {
  assert.ok(error);
  assert.equal(injected, true);
  assert.deepEqual(fs.readFileSync(target), previous, "failure must preserve the exact old generation");
  if (mode === "cleanup-failure") assert.equal(error.cleanupError?.code, "EACCES");
  if (mode === "fsync-close-failure") {
    assert.match(error.message, /fsync/);
    assert.match(error.closeError?.message || "", /close/);
  }
  if (backup) assert.equal(fs.existsSync(backup), false, "failed rotation restores its old generation");
} else {
  assert.equal(error, undefined);
  if (kind === "kimi") {
    const value = JSON.parse(fs.readFileSync(target, "utf8"));
    assert.equal(value.access_token, "synthetic-new-access");
    assert.equal(value.refresh_token, "synthetic-new-refresh");
    assert.ok(value.expires_at > Math.floor(Date.now() / 1000));
    assert.equal(fs.readFileSync(target, "utf8"), JSON.stringify(value, null, 2) + "\n");
  } else assert.deepEqual(fs.readFileSync(target), expected);
  assert.equal(security.privateFileIsProtected(target), true);
  if (["kimi", "durable"].includes(kind)) {
    assert.equal(events.filter((event) => event === "fsync").length, 1);
    assert.ok(events.indexOf("write") < events.indexOf("fsync"));
    assert.ok(events.indexOf("fsync") < events.indexOf("close"));
    assert.ok(events.indexOf("close") < events.indexOf("rename"));
  }
  if (backup) {
    assert.deepEqual(fs.readFileSync(backup), previous);
    assert.equal(security.privateFileIsProtected(backup), true);
  }
  if (mode === "custom-success") assert.deepEqual(events.filter((event) => event.startsWith("custom")), ["custom-temporary", "custom-final"]);
  else if (process.platform === "win32") assert.equal(helperCalls, backup ? 2 : 1, "retain backup hardening, remove only redundant final Windows hardening");
}
for (const temporary of temporaries) {
  if (mode === "cleanup-failure") assert.equal(security.privateFileIsProtected(temporary), true);
  else assert.equal(fs.existsSync(temporary), false);
}
process.stdout.write(JSON.stringify({ kind, mode, helperCalls }) + "\n");
`;

function exercise(kind, mode) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "private-specialized-"));
  assert.equal(path.dirname(scratch), path.resolve(os.tmpdir()));
  assert.ok(path.basename(scratch).startsWith("private-specialized-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => (
    !/^(MODEL_ROUTER_|CODEX_ROUTER_|CODEX_HOME$|KIMI_|GROK_)/i.test(name)
    && !/(?:KEY|TOKEN|SECRET|PROXY)/i.test(name)
  )));
  Object.assign(env, {
    CODEX_HOME: path.join(scratch, "codex"),
    MODEL_ROUTER_STATE_DIR: path.join(scratch, "state"),
    CODEX_ROUTER_STATE_DIR: path.join(scratch, "state"),
    CODEX_ROUTER_NO_DISCOVERY: "1",
    KIMI_CODE_HOME: path.join(scratch, "kimi"),
    KIMI_CODE_OAUTH_HOST: "http://127.0.0.1:1",
    MODEL_ROUTER_USER_MODELS: path.join(scratch, "models.json"),
  });
  try {
    return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", driver, repository, kind, mode], {
      cwd: repository, env, encoding: "utf8", timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    }));
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

for (const kind of ["durable", "kimi", "store", "copy", "rotation", "async"]) {
  test(`${kind} publication retains bytes, privacy and required transaction steps`, () => exercise(kind, "success"));
  test(`${kind} replacement failure preserves the old generation and removes the owned temporary`, () => exercise(kind, "rename-failure"));
}
for (const kind of ["durable", "kimi", "store", "async"]) {
  for (const mode of ["write-failure", "close-failure", "collision"]) {
    test(`${kind} ${mode} preserves the destination and respects temporary ownership`, () => exercise(kind, mode));
  }
}
for (const kind of ["durable", "kimi"]) {
  for (const mode of ["fsync-failure", "fsync-close-failure"]) {
    test(`${kind} ${mode} fails before publication and retains the primary error`, () => exercise(kind, mode));
  }
}
test("exclusive profile copy collisions preserve the unowned temporary", () => exercise("copy", "collision"));
test("credential metadata preserves cleanup failure diagnostics", () => exercise("store", "cleanup-failure"));
test("durable writes preserve even a falsy primary error when close also fails", () => exercise("durable", "falsy-fsync-close-failure"));
test("custom profile protection still runs before and after replacement", () => exercise("copy", "custom-success"));
test("custom profile final protection failure retains its established publication semantics", () => exercise("copy", "custom-final-failure"));
for (const kind of ["kimi", "store", "copy", "rotation"]) {
  test(`${kind} ACL failure preserves the prior destination`, { skip: process.platform !== "win32" }, () => exercise(kind, "harden-failure"));
}
test("rotation backup hardening failure restores and protects the prior generation", { skip: process.platform !== "win32" }, () => exercise("rotation", "backup-failure"));
