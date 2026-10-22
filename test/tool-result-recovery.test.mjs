import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { privateFileIsProtected } from "../src/file-security.mjs";
import { acquireFileLock } from "../src/file-lock.mjs";
import { ageToolResultsWithRecovery, readRetainedToolResult, retainToolResult, hasLocalReadbackTool, hasVerifiedToolResultReadback, toolResultRecoveryScope, toolResultReadbackTools } from "../src/tool-result-recovery.mjs";
import { expireRetainedToolResults } from "../src/tool-result-retention.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tools = [{ type: "namespace", name: "functions", tools: [{ type: "function", name: "exec_command" }] }];
const full = `HEAD\r\n${"一行😀\r\n".repeat(6000)}hidden-evidence-2937\nTAIL`;
const hash = text => createHash("sha256").update(text).digest("hex");
const history = (text = full) => [
  { type: "function_call", name: "exec_command", call_id: "old", arguments: '{"cmd":"mutating-original-command"}' },
  { type: "function_call_output", call_id: "old", output: text },
  { type: "reasoning", summary: [] },
];

async function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "tool-result-recovery-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, scope: "thread-a", callId: "old", ttlMs: 10000 };
}

test("a real committed snapshot survives restart and reads exact Unicode/CRLF bytes in pages", async t => {
  const options = await fixture(t);
  const saved = await retainToolResult(full, options);
  assert.ok(privateFileIsProtected(path.join(options.directory, `${saved.handle}.result`)));
  assert.equal(saved.sha256, hash(full));
  let restored = "", offset = 0;
  while (true) {
    const page = readRetainedToolResult(saved.handle, { ...options, offset, limit: 997 });
    restored += page.text;
    offset = page.nextOffset;
    if (page.eof) break;
  }
  assert.equal(restored, full);
  const child = spawnSync(process.execPath, [path.join(root, "src/tool-result-read.mjs"), saved.handle,
    "--store", options.directory, "--find", "hidden-evidence-2937"], {
    encoding: "utf8", timeout: 20000,
  });
  assert.equal(child.status, 0, child.stderr);
  const answer = JSON.parse(child.stdout);
  assert.match(answer.text, /hidden-evidence-2937/u);
  assert.equal(answer.sha256, saved.sha256);
  assert.equal(readRetainedToolResult(saved.handle, { ...options, find: "absent" }).found, false);
  for (const range of [{offset: -1}, {limit: 0}, {limit: 16001}, {offset: Infinity}]) {
    assert.throws(() => readRetainedToolResult(saved.handle, {...options, ...range}), {code: "invalid_range"});
  }
  const cli = spawnSync(process.execPath, [path.join(root, "src/control.mjs"), "tool-result-aging", "read",
    saved.handle, "--store", options.directory, "--limit", "5"], {encoding: "utf8", timeout: 20000});
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).text, full.slice(0, 5));
});

test("aging and dense shaping publish only durable readback receipts, never rerun instructions", async t => {
  const options = await fixture(t);
  const input = history();
  const retain = (text, info) => retainToolResult(text, { ...options, ...info });
  const before = await ageToolResultsWithRecovery(input, {tools, frontier: 0, retain});
  assert.ok(before.input[1].output.startsWith(full), "an unproven client retains every original byte");
  assert.match(before.input[1].output, /readback pending/u);
  assert.equal(before.stats.toolResultsAged, 0);
  const [savedFile] = readdirSync(options.directory).filter(n => n.endsWith(".result"));
  const proof = readRetainedToolResult(savedFile.slice(0, -7), options);
  input.push({type: "function_call_output", call_id: "reader", output: JSON.stringify(proof)});
  const result = await ageToolResultsWithRecovery(input, {tools, frontier: 0, retain});
  assert.equal(result.stats.toolResultsAged, 1);
  assert.equal(input[1].output, full, "pristine input is not mutated");
  assert.equal(result.input[0], input[0]);
  assert.equal(result.input[2], input[2]);
  const receipt = result.input[1].output;
  assert.match(receipt, /tool-result-read.mjs/u);
  assert.doesNotMatch(receipt, /Repeat the preceding|mutating-original-command/u);
  const [name] = readdirSync(options.directory).filter(n => n.endsWith(".result"));
  assert.equal(readRetainedToolResult(name.slice(0, -7), options).text, full.slice(0, 2000));
  const shapeInput = history("repeated long line\n".repeat(1200));
  shapeInput.push({type: "function_call_output", call_id: "reader", output: JSON.stringify(proof)});
  const shaped = await ageToolResultsWithRecovery(shapeInput, {
    tools, denseShaping: true, retain: (text, info) => retainToolResult(text, { ...options, ...info }),
  });
  assert.equal(shaped.stats.toolResultsShaped, 1);
  assert.match(shaped.input[1].output, /Exact archived result/u);
});

test("without a local execution tool no output is rewritten or written to disk", async () => {
  for (const inventory of [undefined, [], [{ type: "function", name: "web_search" }]]) {
    const input = history();
    const result = await ageToolResultsWithRecovery(input, { tools: inventory, frontier: 0,
      retain() { assert.fail("unusable recovery must never persist"); } });
    assert.equal(result.input, input);
  }
  assert.equal(hasLocalReadbackTool(tools), true);
  assert.equal(toolResultReadbackTools({tools}), tools);
  assert.deepEqual(toolResultReadbackTools({tools, tool_choice: "none"}), []);
  assert.deepEqual(toolResultReadbackTools({tools, tool_choice: {type: "function", name: "other"}}), []);
  assert.equal(hasLocalReadbackTool([{type: "function", name: "functions__exec_command"}]), true);
  assert.equal(hasLocalReadbackTool([{type: "function", name: "exec", description: "await tools.exec_command(...)"}]), true);
  assert.equal(hasLocalReadbackTool([{type: "function", name: "exec", description: "Remote database query"}]), false);
});

test("a snapshot is reused without changing content and leased across history replay", async t => {
  const options = await fixture(t);
  const start = Date.now();
  const first = await retainToolResult(full, { ...options, now: start });
  const file = path.join(options.directory, `${first.handle}.result`);
  const bytes = readFileSync(file);
  const second = await retainToolResult(full, { ...options, now: start + 20000 });
  assert.equal(second.handle, first.handle);
  assert.deepEqual(readFileSync(file), bytes);
  assert.equal(readdirSync(options.directory).filter(n => n.endsWith(".result")).length, 1);
  assert.ok(readRetainedToolResult(first.handle, { ...options, now: start + 21000 }));
  const other = await retainToolResult(full, { ...options, scope: "thread-b" });
  assert.notEqual(other.handle, first.handle);
});

test("expired, swept and corrupt snapshots report unavailable evidence without executing anything", async t => {
  const options = await fixture(t);
  const start = Date.now();
  const saved = await retainToolResult(full, { ...options, now: start });
  assert.throws(() => readRetainedToolResult(saved.handle, { ...options, now: start + 11000 }), { code: "expired" });
  assert.ok(readRetainedToolResult(saved.handle, { ...options, ttlMs: 0, now: start + 11000 }));
  expireRetainedToolResults({ ...options, now: start + 11000 });
  assert.throws(() => readRetainedToolResult(saved.handle, options), { code: "missing_or_expired" });
  await retainToolResult(full, options);
  const file = path.join(options.directory, `${saved.handle}.result`);
  const record = JSON.parse(readFileSync(file)); record.text = "changed";
  writeFileSync(file, JSON.stringify(record));
  assert.throws(() => readRetainedToolResult(saved.handle, options), { code: "corrupt" });
  await assert.rejects(retainToolResult(full, options), { code: "corrupt" });
});

test("full capacity, failed disk writes and ACL failures preserve the full result and clean stages", async t => {
  const options = await fixture(t);
  const input = history();
  for (const fault of [
    { maxFiles: 0 }, { maxBytes: 1 },
    { writeEmpty() { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); } },
    { writeEmpty() { throw Object.assign(new Error("ACL denied"), { code: "EACCES" }); } },
  ]) {
    const result = await ageToolResultsWithRecovery(input, { tools, frontier: 0,
      retain: text => retainToolResult(text, { ...options, ...fault }),
    });
    assert.equal(result.input, input);
    assert.equal(readdirSync(options.directory).some(n => n.includes(".stage.")), false);
  }
  const tooLarge = "x".repeat(8 * 1024 * 1024 + 1);
  assert.equal(await retainToolResult(tooLarge, options), undefined);
});

test("concurrent store contention fails open, then succeeds after release", async t => {
  const options = await fixture(t);
  const saved = await retainToolResult(full, options);
  const release = await acquireFileLock(options.directory, { realpath: false, lockfilePath: `${options.directory}.lock` });
  try {
    const input = history();
    const result = await ageToolResultsWithRecovery(input, { tools, frontier: 0,
      retain: text => retainToolResult(text, options) });
    assert.equal(result.input, input);
    const purge = spawnSync(process.execPath, [path.join(root, "src/control.mjs"), "tool-result-aging", "purge", "--yes"], {
      encoding: "utf8", timeout: 20000,
      env: {...process.env, MODEL_ROUTER_STATE_DIR: options.directory, MODEL_ROUTER_TOOL_RESULT_RETENTION_DIR: options.directory},
    });
    assert.notEqual(purge.status, 0, "purge cannot invalidate a writer's key mid-commit");
    assert.ok(readRetainedToolResult(saved.handle, options));
  } finally { await release(); }
  assert.equal((await retainToolResult(full, options)).handle, saved.handle);
});

test("path traversal and symlinked stores/results are refused", async t => {
  const options = await fixture(t);
  for (const handle of ["../outside", "", "a".repeat(43) + "/extra"]) {
    assert.throws(() => readRetainedToolResult(handle, options), { code: "invalid_handle" });
  }
  const link = `${options.directory}-link`;
  symlinkSync(options.directory, link, process.platform === "win32" ? "junction" : "dir");
  t.after(() => rmSync(link, { recursive: true, force: true }));
  await assert.rejects(retainToolResult(full, { ...options, directory: link }), { code: "unsafe_store" });
});

test("unpublished content is never present while the private-file helper is pending", async t => {
  const options = await fixture(t);
  let inspected = false;
  const { writePrivateFileAsync } = await import("../src/file-security.mjs");
  await retainToolResult(full, { ...options, writeEmpty: async (file, contents, settings) => {
    assert.equal(contents, "");
    assert.equal(readdirSync(options.directory).some(n => n.endsWith(".result")), false);
    inspected = true;
    await writePrivateFileAsync(file, contents, settings);
  } });
  assert.equal(inspected, true);
  assert.equal(existsSync(`${options.directory}.lock`), false);
});


test("readback attestations reject forged, expired and cross-context proofs", async t => {
  const options = await fixture(t);
  const saved = await retainToolResult(full, options);
  const page = readRetainedToolResult(saved.handle, options);
  const input = [{type: "function_call_output", output: JSON.stringify(page)}];
  assert.equal(hasVerifiedToolResultReadback(input, options.scope, options), true);
  assert.equal(hasVerifiedToolResultReadback(input, "another thread", options), false);
  assert.equal(hasVerifiedToolResultReadback(input, options.scope, {...options, now: Date.now() + 31*60000}), false);
  page.readbackProof = page.readbackProof.slice(0, -2) + "AA";
  assert.equal(hasVerifiedToolResultReadback([{type: "function_call_output", output: JSON.stringify(page)}], options.scope, options), false);
  const payload = {instructions: "rules", input: [{role: "developer", content: "workspace-write"}]};
  const a = toolResultRecoveryScope("thread", payload);
  assert.notEqual(a, toolResultRecoveryScope("thread", {...payload, input: [{role: "developer", content: "danger-full-access"}]}));
  assert.equal(a, toolResultRecoveryScope("thread", {...payload, input: [...payload.input, {role: "user", content: "next turn"}]}));
});
