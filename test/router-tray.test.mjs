import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { transactModelOverlayMutation } from "../src/model-overlay-publication.mjs";
import { contractOperationDeadline, operationDeadlineFromEnvironment } from "../src/process-tree.mjs";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
// A read-only override lets the same oracle prove that the prior tray source
// fails against the current runtime contract, without replacing tracked files.
const swift = process.env.CODEX_ROUTER_TEST_TRAY_SOURCE_PATH
  ? readFileSync(process.env.CODEX_ROUTER_TEST_TRAY_SOURCE_PATH, "utf8")
  : read("apps/macos/ModelRouterTray/Sources/ModelRouterTrayApp.swift");
const control = read("src/control.mjs");
const ipc = read("apps/control-center/electron/ipc.mjs");
const runner = read("apps/control-center/electron/command-runner.mjs");
const processTree = read("src/process-tree.mjs");
const overlay = read("src/model-overlay-publication.mjs");
const constants = [ipc, runner, processTree, overlay,
  read("src/runtime-dependency-preparation.mjs"), read("src/router-restart.mjs")];

function arithmetic(expression) {
  const numeric = expression.replace(/\b[A-Z][A-Z0-9_]*\b/g, (name) => String(jsConstant(name)));
  assert.match(numeric, /^[\d_\s+*()]+$/, "only literal budget arithmetic is evaluated");
  return runInNewContext(numeric.replaceAll("_", ""), {}, { timeout: 100 });
}

function jsConstant(name, source) {
  const definition = (source ? [source] : constants).map((text) =>
    text.match(new RegExp(`\\bconst ${name}\\s*=\\s*([^;]+);`))?.[1]).find(Boolean);
  assert.ok(definition, `${name} must remain an explicit finite runtime constant`);
  return arithmetic(definition);
}

function swiftSeconds(name) {
  const value = swift.match(new RegExp(`static let ${name}: TimeInterval = ([\\d_]+)`))?.[1];
  assert.ok(value, `${name} must remain a finite tray budget`);
  return Number(value.replaceAll("_", ""));
}

function controlCatalogMs() {
  const value = control.match(/const maximumControlOperationMs[\s\S]*?: restartBearingOverlayOperation\s*\? ([^:\n]+)/)?.[1];
  assert.ok(value, "control must expose a distinct catalog operation budget");
  return arithmetic(value);
}

test("the tray catalog watchdog mirrors actual Electron and backend transaction ceilings", () => {
  const outer = swiftSeconds("catalogMutationTimeout") * 1_000;
  const publication = swiftSeconds("catalogPublicationOperationTimeout") * 1_000;
  const controlOperation = swiftSeconds("catalogControlOperationTimeout") * 1_000;
  const cleanup = swiftSeconds("processTreeCleanupReserve") * 1_000;
  assert.equal(outer, jsConstant("CATALOG_MUTATION_TIMEOUT_MS", ipc));
  assert.equal(publication, jsConstant("DEFAULT_OVERLAY_TRANSACTION_MS", overlay));
  assert.equal(controlOperation + cleanup, controlCatalogMs());
  assert.equal(cleanup, jsConstant("DEFAULT_CHILD_CLEANUP_RESERVE_MS", processTree));
  assert.ok(outer >= controlCatalogMs() + cleanup,
    "the tray must leave the Node owner and its nested tree time to retire");
  assert.ok(outer >= publication + cleanup,
    "direct curation must expire before the UI watchdog");
  assert.ok(outer <= jsConstant("MAX_TIMEOUT_MS", runner));
});

test("the tray publication budget fits six private restorations and complete semantic rollback", () => {
  const forward = jsConstant("OVERLAY_MUTATION_OPERATION_MS")
    + jsConstant("OVERLAY_RESTARTING_PUBLICATION_MINIMUM_MS");
  const restore = jsConstant("OVERLAY_RESTORE_OVERHEAD_MS") + 6 * 15_000;
  const rollback = jsConstant("OVERLAY_RESTARTING_PUBLICATION_MS") + restore;
  const minimum = forward + rollback;
  assert.equal(minimum, 2_690_000, "readiness, dependency and publication budgets compose sequentially");
  assert.ok(swiftSeconds("catalogPublicationOperationTimeout") * 1_000
    >= minimum + jsConstant("DEFAULT_CHILD_CLEANUP_RESERVE_MS"));
  assert.ok(rollback + jsConstant("OVERLAY_OWNER_CLEANUP_RESERVE_MS")
    <= jsConstant("OVERLAY_ROLLBACK_OWNER_MAX_MS"));
  assert.equal(jsConstant("MAX_OWNER_SIGNAL_BARRIER_MS", runner),
    jsConstant("OVERLAY_ROLLBACK_OWNER_MAX_MS"));
});

test("the parsed tray curation and control deadlines permit the actual six-file transaction", async (t) => {
  const directory = mkdtempSync(path.join(process.env.MODEL_ROUTER_STATE_DIR || os.tmpdir(), "tray-budget-"));
  mkdirSync(directory, { recursive: true });
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const files = Array.from({ length: 6 }, (_, index) => path.join(directory, `private-${index}.json`));
  for (const file of files) writeFileSync(file, "old\n");
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  for (const launch of ["curation", "control"]) {
    const ownerMs = (swiftSeconds("catalogControlOperationTimeout")
      + swiftSeconds("processTreeCleanupReserve")) * 1_000;
    const deadline = launch === "curation"
      ? now + swiftSeconds("catalogPublicationOperationTimeout") * 1_000
      : contractOperationDeadline(operationDeadlineFromEnvironment({
        CODEX_ROUTER_OPERATION_DEADLINE_MS: String(now + ownerMs),
      }, { timeoutMs: controlCatalogMs(), maximumMs: controlCatalogMs() }));
    // Launch/import overhead cannot consume the last millisecond needed to
    // admit the full six-file transaction before it has changed any state.
    now += 50;
    let published = false;
    await transactModelOverlayMutation({ files, restart: true, lock: false, deadline,
      mutate: () => { now += 30_000; for (const file of files) writeFileSync(file, "new\n"); },
      applyPublication: ({ deadline: publicationDeadline }) => {
        assert.ok(publicationDeadline - now >= jsConstant("OVERLAY_RESTARTING_PUBLICATION_MINIMUM_MS"));
        published = true;
      },
    });
    assert.equal(published, true, launch);
    for (const file of files) assert.equal(readFileSync(file, "utf8"), "new\n");
  }
});

test("the tray catalog command classifier includes key pools and generic providers exactly like control", () => {
  const tray = swift.match(/static func isCatalogMutation\([\s\S]*?return \[([\s\S]*?)\]\.contains\(command\)/)?.[1];
  const runtime = control.match(/const restartBearingOverlayOperation = new Set\(\[([\s\S]*?)\]\)/)?.[1];
  assert.ok(tray && runtime);
  const names = (body) => [...body.matchAll(/"([a-z-]+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual(names(tray), names(runtime));
  for (const command of ["key-pool", "generic-providers"]) assert.ok(names(tray).includes(command));
  for (const command of ["providers", "login", "probe-provider", "key-pool-unrelated"]) {
    assert.equal(names(tray).includes(command), false);
  }
  assert.match(swift, /static func controlTimeout\([\s\S]*?isCatalogMutation\(arguments: arguments\)\s*\? catalogMutationTimeout\s*: defaultControlTimeout/);
  assert.match(swift, /static func operationTimeout\([\s\S]*?isCatalogMutation\(arguments: arguments\)\s*\? catalogControlOperationTimeout\s*: ordinaryOperationTimeout/);
});

test("ordinary, discovery and interactive OAuth budgets retain their existing boundaries", () => {
  assert.equal(swiftSeconds("discoveryTimeout"), 45);
  assert.equal(swiftSeconds("ordinaryOperationTimeout"), 840);
  assert.equal(swiftSeconds("defaultControlTimeout"), 900);
  assert.equal(swiftSeconds("antigravityOperationTimeout") * 1_000,
    jsConstant("ANTIGRAVITY_PROBE_ACTIVATION_TIMEOUT_MS", ipc));
  assert.equal(swiftSeconds("antigravityRunnerTimeout") * 1_000,
    jsConstant("ROUTER_BROWSER_OAUTH_TIMEOUT_MS", ipc));
  assert.match(swift, /static func isBoundedAntigravityOperation\([\s\S]*?arguments\[0\] == "login"[\s\S]*?arguments\[1\] == "antigravity-oauth"[\s\S]*?arguments\[0\] == "probe-provider"/);
});

test("both tray launch paths export the finite inner deadline before arming the outer watchdog", () => {
  const operation = swift.slice(swift.indexOf("let controlTimeout = RouterScriptWatchdog.controlTimeout"));
  assert.match(operation, /let operationTimeout = RouterScriptWatchdog\.operationTimeout\(arguments: arguments\)/);
  assert.match(operation, /let ownerTimeout = RouterScriptWatchdog\.operationOwnerTimeout\(arguments: arguments\)/);
  assert.match(operation, /Date\(\)\.timeIntervalSince1970 \+ ownerTimeout/);
  assert.match(operation, /environment\["CODEX_ROUTER_OPERATION_TIMEOUT_MS"\][\s\S]*?Int\(operationTimeout \* 1_000\)/);
  assert.match(operation, /watchdog\.arm\(after: controlTimeout\)/);
  const publicationStart = swift.search(/if script == "curate-models\.mjs" \{\s*let operationTimeout/);
  assert.ok(publicationStart >= 0, "curation must export its own transaction deadline");
  const publication = swift.slice(publicationStart);
  assert.match(publication, /let operationTimeout = RouterScriptWatchdog\.catalogPublicationOperationTimeout/);
  assert.match(publication, /environment\["CODEX_ROUTER_OPERATION_DEADLINE_MS"\][\s\S]*?Date\(\)\.timeIntervalSince1970 \+ operationTimeout/);
  assert.match(publication, /watchdog\.arm\(after: timeout\)/);
});
