import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { restartRouterServiceIfInstalled, routerServiceStatus, verifyRouterExecutionPlanAdoption } from "../src/router-restart.mjs";

// Execute the complete platform status dispatch with only OS/filesystem
// dependencies replaced. No host service manager or credential is queried.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const source = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
const stripped = (value) => value.replace(/^import\b[\s\S]*?;\s*\n/gm, "")
  .replace(/^export /gm, "").replaceAll("import.meta.url", JSON.stringify("file:///synthetic/service.mjs"));
const fingerprint = "a".repeat(64);

async function platformStatus(platform, mode, { installed = false, active = "inactive", registration = "absent", allowanceMs } = {}) {
  const calls = [], output = [];
  const sourceRoot = path.resolve("status-fixture-checkout");
  const stateDir = path.resolve("status-fixture-state");
  const processObject = {
    platform, argv: ["node", "status-fixture.mjs", "status"], execPath: process.execPath,
    getuid: () => 1000, env: { CODEX_ROUTER_SERVICE_PLATFORM: platform, MODEL_ROUTER_STATE_DIR: stateDir,
      ...(allowanceMs === undefined ? {} : { CODEX_ROUTER_OPERATION_DEADLINE_MS: String(1000 + allowanceMs) }) },
    stdout: { write: (value) => output.push(value) },
    exit: (code) => { throw new Error(`Unexpected platform exit ${code}`); },
  };
  const context = {
    path, process: processObject, os: { homedir: () => stateDir }, SOURCE_ROOT: sourceRoot,
    Date: class extends Date { static now() { return 1000; } },
    STATE_DIR: stateDir, CODEX_HOME: path.join(stateDir, "codex"), PORTS: { router: 4200 },
    TARGET: "codex", TARGET_DISPLAY_NAME: "Codex", SERVICE_LABEL: "fixture.router",
    LAUNCH_AGENT_PATH: path.join(stateDir, "fixture.plist"), existsSync: () => installed,
    windowsScheduledTaskState: async () => ({ instanceCount: 0, launcherAlive: false }),
    skipServiceManagerCall: () => false,
    execFileSync: (command, args, options) => {
      calls.push({ command, args, options });
      assert.ok(!args.some((arg) => ["/Run", "/Change", "/End", "start", "stop", "restart", "bootstrap", "bootout"].includes(arg)),
        "status must never mutate a service");
      if (["denied", "missing-command", "timeout"].includes(mode)) {
        throw Object.assign(new Error(mode), { code: { denied: "EACCES", "missing-command": "ENOENT", timeout: "ETIMEDOUT" }[mode], status: mode === "denied" ? 1 : undefined });
      }
      if (platform === "win32") {
        if (command === "schtasks.exe") {
          if (mode === "present") return "fixture task";
          throw Object.assign(new Error("named query failed"), { status: 1 });
        }
        assert.ok(["powershell.exe", "pwsh.exe"].includes(command));
        if (args.at(-1).includes("Get-ScheduledTask -ErrorAction Stop")) return mode === "malformed" ? "not a registration answer" : registration;
        return active === "active" ? "Running" : mode === "malformed-state" ? "broken-state" : "Ready";
      }
      if (platform === "darwin") {
        assert.equal(command, "/bin/launchctl");
        if (mode === "absent") throw Object.assign(new Error("service absent"), { status: 113 });
        return mode === "malformed" ? "not a launchd description" : `state = ${active === "active" ? "running" : "waiting"}\npath = fixture.plist`;
      }
      assert.equal(command, "systemctl");
      assert.deepEqual(args, ["--user", "show", "codex-router.service", "--property=LoadState", "--property=ActiveState"]);
      assert.equal(options.timeout, Math.min(10_000, allowanceMs ?? 10_000));
      if (mode === "malformed") return "LoadState=not-found\nActiveState=inactive\nbroken trailing output";
      if (mode === "duplicate") return "LoadState=not-found\nLoadState=loaded\nActiveState=inactive";
      return `LoadState=${mode === "absent" ? "not-found" : "loaded"}\nActiveState=${active}\n`;
    },
  };
  const moduleName = `service-${{ win32: "windows", darwin: "macos", linux: "linux" }[platform]}.mjs`;
  await new AsyncFunction("context", `const {${Object.keys(context).join(",")}}=context;\n${stripped(source(moduleName))}`)(context);
  return { snapshot: JSON.parse(output.join("")), calls };
}

async function parsedStatus(snapshot) {
  return routerServiceStatus({ env: {}, spawn: () => ({ status: 0, stdout: JSON.stringify(snapshot) }) });
}

async function offlineAdoption(snapshot) {
  return verifyRouterExecutionPlanAdoption({ expectedFingerprint: fingerprint,
    serviceStatus: () => parsedStatus(snapshot),
    waitForHealth: async () => ({ ok: false, connectionRefused: true }) });
}

for (const platform of ["win32", "darwin", "linux"]) {
  for (const mode of ["denied", "missing-command", "timeout", "malformed"]) {
    test(`${platform} ${mode} is unknown and cannot authorize offline publication`, async () => {
      const { snapshot } = await platformStatus(platform, mode);
      assert.equal(snapshot.statusUnknown, true);
      assert.equal((await parsedStatus(snapshot)).statusUnknown, true);
      await assert.rejects(offlineAdoption(snapshot), { code: "model_overlay_adoption_failed" });
    });
  }
  test(`${platform} confirmed absent registration allows offline validation`, async () => {
    const { snapshot } = await platformStatus(platform, "absent");
    assert.deepEqual(snapshot, { installed: false, loaded: false, state: "stopped" });
    assert.deepEqual(await offlineAdoption(snapshot), { adopted: false, offline: true });
  });
  test(`${platform} stopped installed service cannot become offline`, async () => {
    const { snapshot } = await platformStatus(platform, platform === "darwin" ? "absent" : "present", { installed: true, registration: "present" });
    assert.equal(snapshot.installed, true);
    assert.equal(snapshot.loaded, false);
    await assert.rejects(offlineAdoption(snapshot), { code: "model_overlay_adoption_failed" });
  });
  test(`${platform} status contracts a short inherited deadline and refuses an expired one`, async () => {
    const { snapshot, calls } = await platformStatus(platform, "absent", { allowanceMs: 5_000 });
    assert.equal(snapshot.statusUnknown, undefined);
    assert.ok(calls.length > 0);
    for (const { options } of calls) assert.ok(options.timeout > 0 && options.timeout <= 5_000);
    const expired = await platformStatus(platform, "absent", { allowanceMs: -1 });
    assert.equal(expired.snapshot.statusUnknown, true);
    assert.equal(expired.calls.length, 0);
  });
}

for (const platform of ["darwin", "linux"]) {
  test(`${platform} registered job without its definition is still owned`, async () => {
    const { snapshot } = await platformStatus(platform, "present");
    assert.equal(snapshot.installed, false);
    assert.equal(snapshot.loaded, true);
    await assert.rejects(offlineAdoption(snapshot), { code: "model_overlay_adoption_failed" });
  });
}

test("Windows damaged task state retains installed ownership and reports unknown", async () => {
  const { snapshot } = await platformStatus("win32", "malformed-state", { registration: "present" });
  assert.equal(snapshot.installed, true);
  assert.equal(snapshot.statusUnknown, true);
});

test("Linux contradictory and duplicated manager fields cannot prove absence", async () => {
  for (const [mode, options] of [["duplicate", {}], ["absent", { active: "active" }]]) {
    const { snapshot } = await platformStatus("linux", mode, options);
    assert.equal(snapshot.statusUnknown, true);
    await assert.rejects(offlineAdoption(snapshot), { code: "model_overlay_adoption_failed" });
  }
});

test("status JSON cannot turn malformed uncertainty metadata into known absence", async () => {
  for (const snapshot of [
    { installed: false, loaded: false, state: "stopped", statusUnknown: "false" },
    { installed: false, loaded: false, state: "garbage" },
  ]) {
    assert.equal((await parsedStatus(snapshot)).statusUnknown, true);
    await assert.rejects(offlineAdoption(snapshot), { code: "model_overlay_adoption_failed" });
  }
});

async function serviceWrapper(command, allowanceMs) {
  const calls = [];
  const processObject = { platform: "linux", argv: ["node", "/not-an-entry.mjs"], execPath: process.execPath,
    env: { CODEX_ROUTER_SERVICE_PLATFORM: "linux", CODEX_ROUTER_OPERATION_DEADLINE_MS: String(Date.now() + allowanceMs) } };
  const context = { process: processObject, path, SOURCE_ROOT: path.resolve("status-fixture-checkout"),
    fileURLToPath: () => path.resolve("other-entry.mjs"), environmentProxyOptedIn: () => false,
    resetStartupAttempts: () => true,
    spawnSync: (_binary, args) => { calls.push(args); return { status: 0 }; },
    waitForServiceReadiness: () => assert.fail("status cannot wait for startup readiness"),
  };
  const run = await new AsyncFunction("context", `const {${Object.keys(context).join(",")}}=context;\n${stripped(source("service.mjs"))}\nreturn runServiceCommandUnlocked;`)(context);
  await run(command, [command]);
  return calls;
}

test("status uses its short read budget while restart still requires full readiness", async () => {
  assert.equal((await serviceWrapper("status", 5_000)).length, 1);
  await assert.rejects(serviceWrapper("restart", 300_000), /cannot preserve its platform and 300-second readiness/);
  await assert.rejects(serviceWrapper("status", -1), /deadline expired/);
});

test("managed restart captures service progress and relays it only through diagnostics", async () => {
  const diagnostics = [], invocations = [];
  assert.equal(await restartRouterServiceIfInstalled({ env: {},
    writeDiagnostics: (value) => diagnostics.push(value),
    spawn: (_command, args, options) => {
      invocations.push({ args, options });
      return args.at(-1) === "status"
        ? { status: 0, stdout: JSON.stringify({ installed: true, loaded: true, state: "running" }) }
        : { status: 0, stdout: '{"state":"restarting"}\n', stderr: "fixture readiness notice" };
    },
  }), true);
  assert.deepEqual(diagnostics, ['{"state":"restarting"}\n', "fixture readiness notice\n"]);
  assert.equal(invocations[1].options.stdio, "capture");
  assert.ok(Number.isSafeInteger(invocations[1].options.deadline));
  assert.ok(Number(invocations[1].options.env.CODEX_ROUTER_OPERATION_DEADLINE_MS) < invocations[1].options.deadline);
});

test("restart failures remain visible and preserve their status and captured output", async () => {
  const diagnostics = [], cause = new Error("fixture failed platform query");
  await assert.rejects(restartRouterServiceIfInstalled({ env: {},
    writeDiagnostics: (value) => diagnostics.push(value),
    spawn: (_command, args) => args.at(-1) === "status"
      ? { status: 0, stdout: JSON.stringify({ installed: true, loaded: false, state: "stopped" }) }
      : { status: 75, stdout: '{"state":"starting"}', stderr: "fixture readiness timed out", error: cause },
  }), (error) => {
    assert.equal(error.status, 75);
    assert.equal(error.cause, cause);
    assert.deepEqual(error.output, [null, '{"state":"starting"}', "fixture readiness timed out"]);
    assert.equal(error.stdout, '{"state":"starting"}');
    assert.equal(error.stderr, "fixture readiness timed out");
    return /could not be restarted/.test(error.message);
  });
  assert.deepEqual(diagnostics, ['{"state":"starting"}\n', "fixture readiness timed out\n"]);
});
