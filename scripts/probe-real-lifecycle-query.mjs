import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";

const [app, root] = process.argv.slice(2);
const directory = path.join(root, "real-query-parity");
mkdirSync(directory, { recursive: true });
const executable = path.join(app, "Contents/Resources/Control Center.app/Contents/MacOS/Codex Router");
const env = { ...process.env, MODEL_ROUTER_STATE_DIR: directory, CODEX_HOME: path.join(directory, "codex"), CODEX_ROUTER_EMBEDDED_CONTROL_CENTER: "1" };
delete env.ELECTRON_RUN_AS_NODE;
const options = { env, encoding: "utf8", timeout: 10_000 };
const observe = () => JSON.parse(execFileSync(process.execPath, ["scripts/query-control-center-lifecycle.mjs"], options));
const packaged = () => JSON.parse(execFileSync(executable, ["--query-lifecycle"], options));
const flags = ({ running, pid, ready, visible }) => ({ running, pid, ready, visible });
const before = observe();
assert.equal(before.running, false);
const processOwner = spawn(executable, ["--tray-only"], { env, stdio: "ignore" });
const result = { before, pid: processOwner.pid };
try {
  const deadline = performance.now() + 15_000;
  while (performance.now() < deadline) {
    result.live = observe();
    if (result.live.running && result.live.ready) break;
    await pause(100);
  }
  assert.equal(result.live.pid, processOwner.pid);
  assert.equal(result.live.ready, true);
  assert.equal(result.live.visible, false);
  result.packagedLive = packaged();
  assert.deepEqual(flags(result.packagedLive), flags(result.live));
  execFileSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", `ObjC.import("AppKit"); const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${processOwner.pid}); app.terminate;`], { timeout: 5000 });
  const quitDeadline = performance.now() + 10_000;
  while (performance.now() < quitDeadline) {
    result.after = observe();
    if (!result.after.running) break;
    await pause(100);
  }
  assert.equal(result.after.running, false);
  result.packagedAfter = packaged();
  assert.deepEqual(flags(result.packagedAfter), flags(result.after));
  const source = readFileSync("scripts/query-control-center-lifecycle.mjs");
  result.helperBlob = createHash("sha1").update(`blob ${source.length}\0`).update(source).digest("hex");
  writeFileSync(path.join(directory, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  if (processOwner.exitCode === null) processOwner.kill("SIGKILL");
}
