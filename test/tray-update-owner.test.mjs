import "./helpers/isolated-runtime-environment.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runTrayUpdate, withTrayUpdateOwner } from "../src/tray-update-owner.mjs";
import { launchDetached } from "../src/tray-detached-launch.mjs";
import { posixShell } from "./helpers/posix-shell.mjs";

test("one owner excludes recovery while the first complete native transaction is active", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tray-owner-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let held = false;
  const kernel = {
    root, waitMs: 0,
    start: async () => { if (held) throw Object.assign(new Error("busy"), { code: "EADDRINUSE" }); held = true; return {}; },
    close: async () => { held = false; },
  };
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const events = [];
  const first = withTrayUpdateOwner(async () => { events.push("A-prepared"); await barrier; events.push("A-committed"); }, kernel);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(withTrayUpdateOwner(() => events.push("B-recovered-A"), kernel), /no recovery was attempted/);
  assert.deepEqual(events, ["A-prepared"]);
  release();
  await first;
  await withTrayUpdateOwner(() => events.push("B-entered-after-commit"), kernel);
  assert.deepEqual(events, ["A-prepared", "A-committed", "B-entered-after-commit"]);
  await assert.rejects(withTrayUpdateOwner(async () => { throw new Error("native rollback failed"); }, kernel), /native rollback failed/);
  assert.equal(held, false, "the kernel handle is released after failure settles");
});

test("macOS checkouts and delayed recovery use the same installed-package owner identity", async () => {
  const endpoints = [];
  const options = { home: process.env.HOME, platform: "darwin", start: async (endpoint) => { endpoints.push(endpoint); return {}; }, close: async () => {} };
  await withTrayUpdateOwner(async () => {}, { ...options, root: "/synthetic/checkout-a" });
  await withTrayUpdateOwner(async () => {}, { ...options, root: "/synthetic/checkout-b" });
  assert.deepEqual(endpoints[0], endpoints[1]);
});

test("the native body executes inside the owner, preserving argv and status 75", async () => {
  const calls = [];
  let held = false;
  const execute = async (command, args, options) => { assert.equal(held, true); calls.push({ command, args, options }); return { status: 75 }; };
  for (const mode of ["posix", "windows"]) {
    const result = await runTrayUpdate([mode, "tray", "--preserve-window", "a b"], {
      withOwner: async (run) => { held = true; try { return await run(); } finally { held = false; } },
      run: execute, runOperation: execute,
    });
    assert.equal(result, 75);
    assert.equal(held, false);
  }
  assert.ok(calls[0].args[0].endsWith("tray-update-posix.sh"));
  assert.ok(calls[1].args.some((arg) => arg.endsWith("router-commands-windows.ps1")));
  for (const call of calls) assert.deepEqual(call.args.slice(-3), ["tray", "--preserve-window", "a b"]);
});

test("detached GUI launch keeps the exact pid under the existing readiness owner and clears inherited operation epochs", async () => {
  let options;
  let unrefs = 0;
  const child = new EventEmitter(); child.pid = 12345; child.unref = () => { unrefs += 1; };
  const environment = { CODEX_ROUTER_OPERATION_DEADLINE_MS: "1", CODEX_ROUTER_OPERATION_CHILD: "1", ELECTRON_RUN_AS_NODE: "1", HOME: "/synthetic/home" };
  const result = launchDetached("/synthetic/gui", ["--tray-only"], {
    environment, spawnImpl: (_command, _args, value) => { options = value; queueMicrotask(() => child.emit("spawn")); return child; },
  });
  assert.equal(await result, child.pid);
  assert.equal(unrefs, 1);
  assert.equal(options.detached, true);
  assert.equal(options.env.CODEX_ROUTER_OPERATION_DEADLINE_MS, undefined);
  assert.equal(options.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(options.env.HOME, environment.HOME);
  assert.equal(environment.ELECTRON_RUN_AS_NODE, "1");
  await assert.rejects(launchDetached("/synthetic/missing", [], {
    spawnImpl: () => { const failed = new EventEmitter(); queueMicrotask(() => failed.emit("error", new Error("synthetic spawn failure"))); return failed; },
  }), /synthetic spawn failure/);
});

test("public entrypoints delegate mutations while Windows status stays read-only", () => {
  const shell = readFileSync(new URL("../bin/model-router-tray", import.meta.url), "utf8");
  const windows = readFileSync(new URL("../codex-router.ps1", import.meta.url), "utf8");
  const privateWindows = readFileSync(new URL("../src/router-commands-windows.ps1", import.meta.url), "utf8");
  assert.match(shell, /exec node "\$repo_dir\/src\/tray-update-owner\.mjs" posix "\$@"/);
  assert.match(windows, /\$Action -ne "status"[\s\S]*tray-update-owner\.mjs/);
  assert.match(windows, /router-commands-windows\.ps1"\) @args/);
  assert.match(privateWindows, /\$Root = Split-Path -Parent \$PSScriptRoot/);
  const posix = readFileSync(new URL("../src/tray-update-posix.sh", import.meta.url), "utf8");
  assert.match(posix, /tray-detached-launch\.mjs" "\$start_binary"/);
  assert.match(posix, /control_center_pid=\$\(node[\s\S]*new_pid=\$control_center_pid[\s\S]*queried_pid" -eq "\$new_pid"[\s\S]*write_phase committed/);
  assert.match(posix, /write_phase replacement-starting[\s\S]*start_control_center[\s\S]*replacement_ready/);
  assert.match(posix, /start_embedded_control_center\(\)[\s\S]*CODEX_ROUTER_EMBEDDED_CONTROL_CENTER=1[\s\S]*tray-detached-launch\.mjs/);
  assert.match(posix, /start_embedded_control_center "\$embedded_binary" --tray-only[\s\S]*embedded_renderer_ready=0[\s\S]*write_macos_phase committed/);
  const recovery = readFileSync(new URL("../src/macos-tray-supervision-restore.sh", import.meta.url), "utf8");
  assert.match(recovery, /exec node .*tray-update-owner\.mjs" macos-restore/);
  assert.match(recovery, /settle\)[\s\S]*companions_stopped \|\| exit 0[\s\S]*macos-tray-transaction\.mjs/);
});

test("private and public shells parse without executing package or service commands", { skip: !posixShell() }, () => {
  for (const name of ["../bin/model-router-tray", "../src/tray-update-posix.sh", "../src/macos-tray-supervision-restore.sh"]) {
    const result = spawnSync(posixShell(), ["-n", fileURLToPath(new URL(name, import.meta.url))], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
});

test("Windows public wrapper preserves the private script's source root and exit code", { skip: process.platform !== "win32" }, (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tray-public-wrapper-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "src"));
  const publicPath = path.join(root, "codex-router.ps1");
  writeFileSync(publicPath, readFileSync(new URL("../codex-router.ps1", import.meta.url)));
  writeFileSync(path.join(root, "src/router-commands-windows.ps1"), "[Console]::Out.Write((Split-Path -Parent $PSScriptRoot)); exit 75\n");
  const result = spawnSync(path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoLogo", "-NoProfile", "-File", publicPath, "tray", "status"], { encoding: "utf8", timeout: 10_000, windowsHide: true });
  assert.equal(result.status, 75, result.stderr);
  assert.equal(result.stdout, root);
});
