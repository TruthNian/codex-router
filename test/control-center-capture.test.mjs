import "./helpers/isolated-runtime-environment.mjs";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../apps/control-center/electron/command-runner.mjs", import.meta.url), "utf8");
const entrypoint = source.slice(source.indexOf("function runEntrypoint("), source.indexOf("export function runControlDetached("));

function fakeRunner(stdout, stderr = Buffer.alloc(0)) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = () => queueMicrotask(() => {
    for (const byte of stdout) child.stdout.emit("data", Buffer.from([byte]));
    for (const byte of stderr) child.stderr.emit("data", Buffer.from([byte]));
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
  });
  const context = {
    Buffer, StringDecoder, setTimeout, clearTimeout,
    ownerSignalInProgress: undefined,
    process: { env: {}, versions: {}, platform: "win32", execPath: "synthetic-node", pid: 12345 },
    DEFAULT_TIMEOUT_MS: 1_000, MAX_TIMEOUT_MS: 2_000, MAX_OUTPUT_BYTES: 1_024,
    OWNER_SIGNAL_BUDGET_ENV: "BUDGET", OWNER_SIGNAL_BARRIER_DIR_ENV: "BARRIER",
    TREE_EXIT_WAIT_MS: 10, OWNER_SIGNAL_CLEANUP_MS: 100,
    OWNER_SIGNAL_GROUP_EXIT_WAIT_MS: 10, OWNER_SIGNAL_CLOSE_WAIT_MS: 10,
    discoverSourceRoot: () => "/synthetic", runtimeEnvironment: () => ({}),
    recordedInstallManifest: () => undefined, contractedOwnerSignalBudget: () => 50,
    createOwnerSignalCoordinator: () => ({ directory: "/synthetic/barrier", release() {} }),
    windowsJobProcessInvocation: () => ({ command: "synthetic-node", args: [] }),
    spawn: () => child, registerOwnedCommandTree: () => () => {},
    terminateProcessTree: async () => {}, ownerSignalBudget: () => undefined,
    safeFailure: (message) => message,
  };
  return vm.runInNewContext(`${entrypoint}\nrunEntrypoint`, context);
}

test("Electron capture preserves JSON paths and stderr split at every UTF-8 byte", async () => {
  const payload = { path: "ışık/模型/😀", message: "完成" };
  const diagnostic = "模型 😀 diagnostic";
  const result = await fakeRunner(Buffer.from(JSON.stringify(payload)), Buffer.from(diagnostic))("synthetic-entry");
  assert.deepEqual(JSON.parse(result.stdout), payload);
  assert.equal(result.stderr, diagnostic);
});

test("Electron capture flushes incomplete EOF and retains its stderr and raw-byte limits", async () => {
  const result = await fakeRunner(Buffer.from([0xe4, 0xb8]), Buffer.from([0xf0, 0x9f]))("synthetic-entry");
  assert.equal(result.stdout, "�");
  assert.equal(result.stderr, "�");
  const bounded = await fakeRunner(Buffer.from("ok"), Buffer.from("x".repeat(16_400)))("synthetic-entry");
  assert.equal(bounded.stderr.length, 16_384);
  await assert.rejects(
    fakeRunner(Buffer.from("模型"))("synthetic-entry", [], { maxOutputBytes: 5 }),
    /output exceeded its limit/,
  );
});
