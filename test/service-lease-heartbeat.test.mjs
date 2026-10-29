import "./helpers/isolated-runtime-environment.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { readManagedClientStatuses, readRouterServiceStatus } from "../src/caller-key.mjs";
import { withServiceOperationLock } from "../src/service-operation-lock.mjs";

test("platform command waiting keeps the service lease alive past its stale period", { timeout: 8_000 }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "service-heartbeat-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = readFileSync(new URL("../src/service.mjs", import.meta.url), "utf8");
  const start = source.indexOf("export async function runServiceCommandUnlocked(");
  const end = source.indexOf("export async function runServiceCli(", start);
  assert.ok(start >= 0 && end > start);
  let releaseCommand;
  const command = new Promise((resolve) => { releaseCommand = () => resolve({ status: 0 }); });
  const calls = [];
  const run = vm.runInNewContext(source.slice(start, end).replace("export ", "") + "\nrunServiceCommandUnlocked", {
    process: { execPath: "synthetic-node", env: {} }, path, SOURCE_ROOT: "/synthetic", script: "service-linux.mjs",
    environmentProxyOptedIn: () => false, remainingOperationMs: () => undefined,
    operationDeadline: undefined, PLATFORM_COMMAND_RESERVE_MS: 10_000, READINESS_TIMEOUT_MS: 300_000,
    readinessCommands: new Set(["start", "install", "restart"]), shutdownCommands: new Set(["stop", "uninstall"]),
    runProcessTree: (...args) => { calls.push(args); return command; },
  });
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const first = withServiceOperationLock(async () => { entered(); return run("status"); }, { stateDir: root, staleMs: 2_000 });
  try {
    await started;
    const lock = path.join(root, "service-operation.lock");
    const initial = statSync(lock).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 3_200));
    assert.ok(statSync(lock).mtimeMs > initial, "the live owner must renew its lease during the child wait");
    await assert.rejects(withServiceOperationLock(async () => "overlap", { stateDir: root, staleMs: 2_000, waitMs: 1 }), /still running/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][2].stdio, "inherit");
    assert.equal(calls[0][2].childMayOwnProcessTrees, undefined);
  } finally {
    releaseCommand();
    assert.equal(await first, 0);
  }
});

test("caller-key status readers await asynchronous controlled child output", async () => {
  const runNode = async (script, args) => {
    await new Promise((resolve) => setImmediate(resolve));
    return JSON.stringify({ script, args });
  };
  const statuses = await readManagedClientStatuses({ runNode });
  assert.equal(statuses.codex.script, "src/config-manager.mjs");
  assert.ok(Object.values(statuses).every((status) => Array.isArray(status.args)));
  assert.equal((await readRouterServiceStatus({ runNode })).script, "src/service.mjs");
  await assert.rejects(readRouterServiceStatus({ runNode: async () => "invalid" }), /invalid status JSON/);
});
