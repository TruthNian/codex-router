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
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
const [repository, kind, race] = process.argv.slice(1);
const load = (name) => import(pathToFileURL(path.join(repository, "src", name)).href);
const security = await load("file-security.mjs");
const { atomicPrivateCopy } = await load("chatgpt-profile-switch.mjs");
const root = process.env.MODEL_ROUTER_STATE_DIR;
const parent = path.join(root, "parent");
const moved = path.join(root, "moved");
const foreign = path.join(root, "foreign");
fs.mkdirSync(parent, { recursive: true });
fs.mkdirSync(foreign);
const source = path.join(root, "source.json");
const target = path.join(parent, "auth.json");
const oldBytes = Buffer.from("SYNTHETIC_OLD");
const newBytes = Buffer.from([0, 255, 13, 10, 65]);
fs.writeFileSync(source, newBytes);
fs.writeFileSync(target, oldBytes);
const rename = fs.renameSync;
let unrelatedTemporary;
let retainedTemporary;
let parentRedirected = false;
const originalError = new Error("injected replacement boundary failure");
function redirect(temporary) {
  if (race === "parent") {
    unrelatedTemporary = path.join(foreign, path.basename(temporary));
    fs.writeFileSync(unrelatedTemporary, "UNRELATED_OBJECT");
    fs.writeFileSync(path.join(foreign, "auth.json"), "UNRELATED_DESTINATION");
    rename(parent, moved);
    retainedTemporary = path.join(moved, path.basename(temporary));
    fs.symlinkSync(foreign, parent, process.platform === "win32" ? "junction" : "dir");
    parentRedirected = true;
  } else {
    const foreignSource = path.join(foreign, "unrelated.json");
    fs.writeFileSync(foreignSource, "UNRELATED_OBJECT");
    retainedTemporary = temporary + ".retained";
    rename(temporary, retainedTemporary);
    rename(foreignSource, temporary);
    unrelatedTemporary = temporary;
  }
  throw originalError;
}
let error;
try {
  if (kind === "async") {
    fs.renameSync = (temporary, destination) => {
      if (destination === target) redirect(temporary);
      return rename(temporary, destination);
    };
    syncBuiltinESMExports();
    try { await security.writePrivateFileAsync(target, newBytes); } catch (cause) { error = cause; }
  } else {
    const protect = (temporary) => {
      security.protectPrivateFile(temporary);
      redirect(temporary);
    };
    try {
      if (kind === "copy") atomicPrivateCopy(source, target, { protect });
      else security.writePrivateFile(target, newBytes, { protect });
    } catch (cause) { error = cause; }
  }
  assert.equal(error, originalError, "cleanup must retain the operation's original error");
  assert.equal(fs.existsSync(unrelatedTemporary), true, "cleanup must never unlink an unrelated object reached through a raced path");
  assert.equal(fs.readFileSync(unrelatedTemporary, "utf8"), "UNRELATED_OBJECT");
  assert.deepEqual(fs.readFileSync(retainedTemporary), newBytes, "retain displaced owned evidence when its original name is unsafe");
  assert.equal(security.privateFileIsProtected(retainedTemporary), true);
  assert.equal(error.cleanupError?.code, "ESTALE", "make incomplete cleanup explicit");
  if (parentRedirected) {
    assert.deepEqual(fs.readFileSync(path.join(moved, "auth.json")), oldBytes);
    assert.equal(fs.readFileSync(target, "utf8"), "UNRELATED_DESTINATION");
  } else assert.deepEqual(fs.readFileSync(target), oldBytes);
  process.stdout.write(JSON.stringify({ preserved: true }) + "\n");
} finally {
  if (parentRedirected) fs.rmSync(parent);
}
`;

for (const kind of ["sync", "copy", "async"]) {
  for (const race of ["parent", "leaf"]) {
    test(`${kind} cleanup preserves unrelated files after a ${race} path replacement`, () => {
      const scratch = mkdtempSync(path.join(os.tmpdir(), "private-cleanup-identity-"));
      assert.equal(path.dirname(scratch), path.resolve(os.tmpdir()));
      assert.ok(path.basename(scratch).startsWith("private-cleanup-identity-"));
      const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => (
        !/^(MODEL_ROUTER_|CODEX_ROUTER_|CODEX_HOME$)/i.test(name)
        && !/(?:KEY|TOKEN|SECRET|PROXY)/i.test(name)
      )));
      Object.assign(env, {
        CODEX_HOME: path.join(scratch, "codex"),
        MODEL_ROUTER_STATE_DIR: path.join(scratch, "state"),
        CODEX_ROUTER_STATE_DIR: path.join(scratch, "state"),
        CODEX_ROUTER_NO_DISCOVERY: "1",
        MODEL_ROUTER_USER_MODELS: path.join(scratch, "models.json"),
      });
      try {
        const output = execFileSync(process.execPath, ["--input-type=module", "-e", driver, repository, kind, race], {
          cwd: repository, env, encoding: "utf8", timeout: 120_000,
          stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
        });
        assert.equal(JSON.parse(output).preserved, true);
      } finally { rmSync(scratch, { recursive: true, force: true }); }
    });
  }
}
