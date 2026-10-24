import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeLifecycleState } from "../apps/control-center/electron/lifecycle-state.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
// Execute the actual CI observer, rather than a second implementation of it.
const observer = ci.match(/query_lifecycle\(\) \{([\s\S]*?)\n {10}\}/)?.[1];
assert.ok(observer, "The native lifecycle smoke must expose its observer");
const invocation = observer.match(/node(.*?) -e '([\s\S]*?)'(?: "\$embedded")?/);
const script = observer.match(/node (scripts\/query-control-center-lifecycle\.mjs)/)?.[1];
assert.ok(invocation || script, "The native lifecycle observer must run through Node");

const guardSource = `
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
for (const key of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  childProcess[key] = () => { throw new Error("Lifecycle observation attempted to start a subprocess"); };
}
syncBuiltinESMExports();
`;

function fixture(body) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "macos-lifecycle-observer-"));
  try {
    const guard = path.join(directory, "no-subprocess.mjs");
    writeFileSync(guard, guardSource);
    const options = {
      cwd: root,
      env: { ...process.env, MODEL_ROUTER_STATE_DIR: directory, MODEL_ROUTER_CONTROL_CENTER_STATE: path.join(directory, "control-center-lifecycle.json") },
      encoding: "utf8", timeout: 10_000, windowsHide: true,
    };
    const run = (args) => spawnSync(process.execPath, ["--import", pathToFileURL(guard).href, ...args], options);
    body({ directory, file: options.env.MODEL_ROUTER_CONTROL_CENTER_STATE, run });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function observe(run) {
  const args = script ? [script] : [
    ...invocation[1].trim().split(/\s+/).filter(Boolean), "-e", invocation[2], "unused-gui-executable",
  ];
  const result = run(args);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("the subprocess guard detects an observer that starts a GUI helper", () => {
  fixture(({ run }) => {
    const result = run(["-e", 'require("node:child_process").execFileSync(process.execPath, ["--query-lifecycle"])']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Lifecycle observation attempted to start a subprocess/);
  });
});

test("release and macOS rebuild observations use the same non-GUI entry point", () => {
  const release = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  assert.match(release, /state=\$\(node scripts\/query-control-center-lifecycle\.mjs/);
  assert.doesNotMatch(release, /--query-lifecycle/);
  const tray = readFileSync(new URL("../bin/model-router-tray", import.meta.url), "utf8");
  const rebuildObserver = tray.match(/query_embedded_lifecycle\(\) \{([\s\S]*?)\n {4}\}/)?.[1];
  assert.ok(rebuildObserver);
  assert.match(rebuildObserver, /node "\$repo_dir\/scripts\/query-control-center-lifecycle\.mjs"/);
  assert.doesNotMatch(rebuildObserver, /--query-lifecycle/);
});

test("CI observes an absent application without creating an application process", () => {
  fixture(({ run }) => {
    const state = observe(run);
    assert.equal(state.running, false);
    assert.equal(state.pid, null);
    assert.equal(state.ready, false);
    assert.equal(state.visible, false);
    assert.equal(state.updatedAt, null);
  });
});

test("CI observes the real live writer and its visibility without starting helpers", () => {
  fixture(({ file, run }) => {
    for (const visible of [true, false]) {
      const written = writeLifecycleState(file, { pid: process.pid, ready: true, visible });
      const state = observe(run);
      assert.equal(state.running, true);
      assert.equal(state.pid, process.pid);
      assert.equal(state.ready, true);
      assert.equal(state.visible, visible);
      assert.equal(state.updatedAt, written.updatedAt);
    }
  });
});

test("CI does not mistake a dead writer for a ready application", () => {
  fixture(({ file, run }) => {
    const child = spawnSync(process.execPath, ["-e", ""], { windowsHide: true, timeout: 10_000 });
    assert.equal(child.status, 0);
    assert.ok(child.pid > 0);
    const written = writeLifecycleState(file, { pid: child.pid, ready: true, visible: true });
    const state = observe(run);
    assert.equal(state.running, false);
    assert.equal(state.pid, null);
    assert.equal(state.ready, false);
    assert.equal(state.visible, false);
    assert.equal(state.updatedAt, written.updatedAt);
  });
});

test("CI rejects a corrupt lifecycle record without booting a replacement", () => {
  fixture(({ file, run }) => {
    writeFileSync(file, "not json");
    assert.equal(observe(run).running, false);
  });
});
