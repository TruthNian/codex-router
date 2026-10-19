import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync } from "node:fs";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { queryLifecycleState } from "../apps/control-center/electron/lifecycle-state.mjs";
import { waitForMacosAppReady } from "./wait-macos-app-ready.mjs";

const root = path.join(process.env.RUNNER_TEMP, "macos-native-launch-evidence");
mkdirSync(root, { recursive: true });
const app = path.join(process.env.RUNNER_TEMP, "Codex Router.app");
const outer = path.join(app, "Contents/MacOS/ModelRouterTray");
const embedded = path.join(app, "Contents/Resources/Control Center.app/Contents/MacOS/Codex Router");
const results = [];
const appsJS = `ObjC.import("AppKit");
const ids = ["io.github.codex-router.tray", "io.github.codex-router.control-center"];
const rows = [];
for (const id of ids) {
  const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(id);
  for (let i = 0; i < apps.count; i++) {
    const app = apps.objectAtIndex(i);
    rows.push({id, pid: Number(app.processIdentifier), finishedLaunching: Boolean(app.isFinishedLaunching)});
  }
}
JSON.stringify(rows);`;
function running() {
  return JSON.parse(execFileSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", appsJS], { encoding: "utf8", timeout: 5000 }));
}
function terminate() {
  execFileSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", `ObjC.import("AppKit");
    for (const id of ["io.github.codex-router.control-center", "io.github.codex-router.tray"]) {
      const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(id);
      for (let i = 0; i < apps.count; i++) apps.objectAtIndex(i).terminate;
    }`], { timeout: 5000, stdio: "ignore" });
}
function events(file) { try { return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse); } catch { return []; } }
async function until(check, ms = 5000) {
  const end = performance.now() + ms;
  while (performance.now() < end) { if (check()) return true; await pause(50); }
  return false;
}
for (const [index, mode] of ["query", "direct", "query", "direct", "query", "direct", "held-query"].entries()) {
  const directory = path.join(root, `${index}-${mode}`);
  mkdirSync(directory);
  const trace = path.join(directory, "events.jsonl");
  writeFileSync(trace, "");
  const state = path.join(directory, "control-center-lifecycle.json");
  const logFD = openSync(path.join(directory, "outer.log"), "a");
  const environment = { ...process.env, CODEX_HOME: path.join(directory, "codex"), MODEL_ROUTER_STATE_DIR: directory, MODEL_ROUTER_DIAG_TRACE: trace };
  delete environment.ELECTRON_RUN_AS_NODE;
  const host = spawn(outer, ["--supervised"], { env: environment, stdio: ["ignore", logFD, logFD] });
  let query;
  const result = { index, mode, hostPID: host.pid, samples: [] };
  const start = performance.now();
  try {
    await waitForMacosAppReady({ pid: host.pid, appPath: app });
    if (mode === "held-query") {
      query = spawn(embedded, ["--query-lifecycle"], { env: { ...environment, MODEL_ROUTER_DIAG_QUERY_HOLD_MS: "3000" }, stdio: ["ignore", logFD, logFD] });
      result.queryPID = query.pid;
      if (!await until(() => events(trace).some(e => e.pid === query.pid && e.phase === "query.read"))) throw new Error("Held query did not enter");
      result.beforeOpen = running();
    }
    execFileSync("/usr/bin/open", [app], { env: environment, timeout: 10000 });
    for (let poll = 0; poll < 120; poll++) {
      let snapshot;
      if (mode === "query") {
        snapshot = JSON.parse(execFileSync(embedded, ["--query-lifecycle"], { env: environment, encoding: "utf8", timeout: 10000 }));
      } else snapshot = queryLifecycleState(state);
      result.samples.push({ elapsedMs: performance.now() - start, ...snapshot });
      if (snapshot.running && snapshot.ready && snapshot.visible) { result.ready = true; break; }
      await pause(250);
    }
    result.running = running();
    result.events = events(trace);
  } catch (error) { result.error = error.message; result.events = events(trace); }
  finally {
    if (query && query.exitCode === null) query.kill("SIGKILL");
    try { terminate(); } catch (error) { result.cleanupError = error.message; }
    await until(() => running().length === 0, 5000);
    if (host.exitCode === null) host.kill("SIGKILL");
    closeSync(logFD);
  }
  result.elapsedMs = performance.now() - start;
  writeFileSync(path.join(directory, "result.json"), JSON.stringify(result, null, 2));
  results.push(result);
  writeFileSync(path.join(root, "summary.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({index, mode, ready: result.ready === true, error: result.error, queryPID: result.queryPID, running: result.running, events: result.events}));
}
if (results.some(result => result.error)) process.exitCode = 1;
