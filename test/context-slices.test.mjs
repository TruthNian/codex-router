import "./helpers/isolated-runtime-environment.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../bin/context-slices.mjs", import.meta.url));

for (const [names, collision] of [
  [["rollout.jsonl", "rollout.jsonl"], true],
  [["rollout", "rollout.txt"], true],
  [["rollout.jsonl", "rollout.txt"], false],
]) test(`context slices ${names.join(" + ")}: ${collision ? "reject before writing" : "retain exact events"}`, (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "context-slices-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const inputs = [path.join(root, "a", names[0]), path.join(root, "b", names[1])];
  for (const [index, input] of inputs.entries()) {
    mkdirSync(path.dirname(input), { recursive: true });
    writeFileSync(input, `event-${index}\n`);
  }
  const out = path.join(root, "out");
  const result = spawnSync(process.execPath, [script, ...inputs, "--out", out], { encoding: "utf8", timeout: 5_000 });
  if (collision) {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /would overwrite the same slices/);
    assert.equal(existsSync(out), false, "rejection must precede even the output directory write");
  } else {
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(readFileSync(path.join(out, "manifest.json"), "utf8"));
    assert.equal(manifest.files.length, 2);
    assert.notEqual(manifest.files[0].slices[0].file, manifest.files[1].slices[0].file);
    for (const [index, entry] of manifest.files.entries()) {
      assert.equal(readFileSync(path.join(out, entry.slices[0].file), "utf8"), `event-${index}\n`);
    }
  }
});
