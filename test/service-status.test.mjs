import "./helpers/isolated-runtime-environment.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { normalizeServiceStatus } from "../src/service-status.mjs";
import { managedServiceIsRunning, recoverPendingCallerKeyRotation, runCallerKeyRotation } from "../src/caller-key.mjs";
import { routerServiceStatus } from "../src/router-restart.mjs";
import { readServiceProcessState, serviceRecordSettled } from "../src/service-process.mjs";
import { windowsScheduledTaskState } from "../src/windows-task-state.mjs";

async function platformStatus(file, nextCommand, mocks) {
  const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
  const header = '} else if (command === "status") {';
  const start = source.indexOf(header);
  const end = source.indexOf(`} else if (command === "${nextCommand}")`, start + header.length);
  assert.ok(start >= 0 && end > start);
  let output = "";
  const context = {
    normalizeServiceStatus, existsSync: () => true,
    LAUNCH_AGENT_PATH: "/synthetic/agent", unitPath: "/synthetic/unit", unitName: "synthetic.service",
    TASK_STOP_TIMEOUT_MS: 15_000,
    readServiceProcessState: () => undefined, serviceRecordSettled,
    process: { env: {}, stdout: { write: (text) => { output += text; } } },
    ...mocks,
  };
  await vm.runInNewContext(`(async () => {${source.slice(start + header.length, end)}})()`, context);
  return JSON.parse(output);
}

test("all platforms preserve denied and inconclusive status instead of inventing stopped", async () => {
  const mac = await platformStatus("service-macos.mjs", "install", { probeLoaded: () => ({ state: "unknown" }) });
  const linux = await platformStatus("service-linux.mjs", "restart-count", { systemctl: () => { throw Object.assign(new Error("denied"), { status: 1 }); } });
  const windows = await platformStatus("service-windows.mjs", "stop", { taskExists: () => { throw new Error("denied"); } });
  for (const status of [mac, linux, windows]) {
    assert.equal(status.state, "unknown");
    assert.equal(status.statusUnknown, true);
    assert.throws(() => managedServiceIsRunning(status), /could not be verified/);
  }
});

test("a missing Windows task retains the existing managed process record's evidence", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "windows-record-status-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const recordPath = path.join(root, "service-process.json");
  const record = { version: 1, managed: true, pid: 525252, processIdentity: "synthetic-start",
    commandLine: "synthetic-node synthetic-start.mjs", sourceRoot: root, stateDir: root };
  writeFileSync(recordPath, JSON.stringify(record), { mode: 0o600 });
  for (const [ownership, portListening, expected] of [
    ["owned", undefined, "running"],
    ["unknown", false, "unknown"],
    ["foreign", true, "unknown"],
    ["foreign", undefined, "unknown"],
    ["foreign", false, "stopped"],
  ]) {
    let ownershipProbes = 0;
    let portProbes = 0;
    const status = await platformStatus("service-windows.mjs", "stop", {
      taskExists: () => false,
      readServiceProcessState: (_unused, options) => {
        assert.equal(options.strict, true);
        return readServiceProcessState(recordPath, options);
      },
      probeOwnership: (observed, deadline) => {
        assert.deepEqual(observed, record);
        assert.ok(Number.isFinite(deadline));
        ownershipProbes += 1;
        return ownership;
      },
      managedPortStillListening: (observed) => { assert.deepEqual(observed, record); portProbes += 1; return portListening; },
    });
    assert.equal(status.installed, false);
    assert.equal(status.loaded, ownership === "owned");
    assert.equal(status.state, expected);
    assert.equal(status.statusUnknown === true, expected === "unknown");
    assert.equal(ownershipProbes, 1);
    assert.equal(portProbes, ownership === "foreign" ? 1 : 0);
    if (expected === "unknown") assert.throws(() => managedServiceIsRunning(status), /could not be verified/);
    else assert.equal(managedServiceIsRunning(status), expected === "running");
  }
  writeFileSync(recordPath, "{malformed");
  const corrupt = await platformStatus("service-windows.mjs", "stop", {
    taskExists: () => false,
    readServiceProcessState: (_unused, options) => readServiceProcessState(recordPath, options),
  });
  assert.equal(corrupt.statusUnknown, true);
});

test("conclusive stopped and loaded observations remain distinct", async () => {
  const mac = await platformStatus("service-macos.mjs", "install", { probeLoaded: () => ({ state: "loaded", description: "state = waiting\n" }) });
  assert.equal(managedServiceIsRunning(mac), true);
  const linux = await platformStatus("service-linux.mjs", "restart-count", { systemctl: () => "LoadState=loaded\nActiveState=inactive\n" });
  assert.equal(managedServiceIsRunning(linux), false);
  assert.equal(linux.statusUnknown, undefined);
  const windows = await platformStatus("service-windows.mjs", "stop", { taskExists: () => false });
  assert.deepEqual(windows, { installed: false, loaded: false, state: "stopped" });
  const ambiguous = await platformStatus("service-windows.mjs", "stop", {
    taskExists: () => true, taskState: () => "ready", taskRunning: async () => undefined,
  });
  assert.equal(ambiguous.statusUnknown, true);
});

test("Windows Ready status needs a complete launcher observation and retains known stopped and running controls", async () => {
  const source = readFileSync(new URL("../src/service-windows.mjs", import.meta.url), "utf8");
  const start = source.indexOf("async function taskRunning(");
  const end = source.indexOf("\nif (", start);
  assert.ok(start >= 0 && end > start);
  for (const [name, output, state] of [
    ["incomplete", "1|267009", "unknown"],
    ["malformed", "not-task-state", "unknown"],
    ["denied", new Error("fixture query denied"), "unknown"],
    ["dead launcher with stale instance", "1|267014|0", "ready"],
    ["no instance or launcher", "0|0|0", "ready"],
    ["external launcher without task instance", "0|267009|1", "ready"],
    ["task instance and live managed launcher", "1|267009|1", "running"],
  ]) {
    let probes = 0;
    const taskRunning = vm.runInNewContext(`${source.slice(start, end)}\ntaskRunning`, {
      taskName: "synthetic-task", effectivePlatform: "win32", TASK_STATE_TIMEOUT_MS: 1_000,
      windowsScheduledTaskState: options => windowsScheduledTaskState({
        ...options,
        execFile: (_executable, _args, _options, callback) => {
          probes += 1;
          callback(output instanceof Error ? output : null, output instanceof Error ? "" : output);
        },
      }),
    });
    const status = await platformStatus("service-windows.mjs", "stop", {
      taskExists: () => true, taskState: () => "ready", taskRunning,
    });
    assert.deepEqual(status, { installed: true, loaded: state === "running", state,
      ...(state === "unknown" ? { statusUnknown: true } : {}) }, name);
    assert.equal(probes, 1, `${name} must execute the parser's Windows probe boundary on every host`);
    if (state === "unknown") assert.throws(() => managedServiceIsRunning(status), /could not be verified/, name);
    else assert.equal(managedServiceIsRunning(status), state === "running", name);
  }
});

test("service snapshot consumers retain unknown and keep a loaded job independent of its definition", async () => {
  assert.equal(managedServiceIsRunning({ installed: false, loaded: true, state: "running" }), true);
  for (const status of [
    { installed: true, loaded: false, state: "active" },
    { installed: false, loaded: false, state: "stopped", statusUnknown: true },
    {},
  ]) assert.equal(normalizeServiceStatus(status).statusUnknown, true);
  const status = await routerServiceStatus({
    spawn: async () => ({ status: 0, stdout: JSON.stringify({ installed: true, loaded: false, state: "stopped", statusUnknown: true }) }),
  });
  assert.equal(status.statusUnknown, true);
});

test("a malformed successful systemd query and an unverified Windows registration stay unknown", async () => {
  for (const answer of ["", "LoadState=loaded\nActiveState=inactive\nActiveState=active", "LoadState=not-found\nActiveState=active"]) {
    const status = await platformStatus("service-linux.mjs", "restart-count", { systemctl: () => answer });
    assert.equal(status.statusUnknown, true);
  }
  const source = readFileSync(new URL("../src/service-windows.mjs", import.meta.url), "utf8");
  const start = source.indexOf("function taskExists(");
  const end = source.indexOf("function setTaskEnabled(", start);
  assert.ok(start >= 0 && end > start);
  for (const answer of ["absent", "present", undefined]) {
    const taskExists = vm.runInNewContext(`${source.slice(start, end)}\ntaskExists`, {
      taskName: "synthetic-task", TASK_STOP_TIMEOUT_MS: 1_000, TASK_STATE_TIMEOUT_MS: 1_000,
      process: { env: {} }, UnverifiedServiceStopError: Error,
      schtasks: () => { throw new Error("named query denied"); },
      execFileSync: () => { if (answer === undefined) throw new Error("enumeration denied"); return answer; },
    });
    if (answer === undefined) assert.throws(() => taskExists({ strict: true }), /query did not answer/);
    else assert.equal(taskExists({ strict: true }), answer === "present");
  }
});

test("unknown status blocks rotation before a journal or secret is touched", async () => {
  const mutations = [];
  await assert.rejects(runCallerKeyRotation({
    secretPath: "/synthetic/not-read", assertOwnership() {},
    withLock: (run) => run(), withMutationLocks: (run) => run(), withServiceLock: (run) => run(),
    recoverPending: async () => {}, readClientStatuses: async () => ({}),
    readServiceStatus: async () => ({ installed: false, loaded: false, state: "unknown", statusUnknown: true }),
    beginJournal: () => mutations.push("journal"), rotateSecret: () => mutations.push("secret"),
  }), /could not be verified/);
  assert.deepEqual(mutations, []);
});

test("unknown status leaves a pending recovery generation and journal intact", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "caller-recovery-unknown-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const secretPath = path.join(root, "caller-secret");
  const secret = "s".repeat(48);
  writeFileSync(secretPath, secret);
  const mutations = [];
  await assert.rejects(recoverPendingCallerKeyRotation({
    secretPath, withServiceLock: (run) => run(), secretIsProtected: () => true,
    readJournal: async () => ({ operationId: "a".repeat(32), phase: "prepared", targets: [], previousSecretSha256: createHash("sha256").update(secret).digest("hex") }),
    readServiceStatus: async () => ({ installed: true, loaded: false, state: "unknown", statusUnknown: true }),
    runServiceMutation: () => mutations.push("service"), restoreSecret: () => mutations.push("secret"),
    runNode: () => mutations.push("client"), clearJournal: () => mutations.push("journal"),
  }), /could not be verified/);
  assert.equal(readFileSync(secretPath, "utf8"), secret);
  assert.deepEqual(mutations, []);
});
