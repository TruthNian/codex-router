import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

test("a symlink does not hide later normal and archived rollout files", async () => {
  const source = await readFile(new URL("../apps/control-center/electron/ipc.mjs", import.meta.url), "utf8");
  const start = source.indexOf("function walkRollouts(");
  const end = source.indexOf("\nfunction readFileEdges", start);
  assert.ok(start >= 0 && end > start);
  const id = "019f7432-43d9-7413-8f18-5f964587f58e";
  const walk = vm.runInNewContext(`${source.slice(start, end)}\nwalkRollouts`, {
    path: path.posix, SESSION_LIST_LIMIT: 100, SESSION_UUID_IN_FILENAME: new RegExp(id),
    readdirSync: () => [
      { isSymbolicLink: () => true },
      { name: `rollout-${id}.jsonl`, isSymbolicLink: () => false,
        isDirectory: () => false, isFile: () => true },
    ],
  });
  for (const archived of [false, true]) {
    const files = [];
    walk("/fixture", archived, files);
    assert.equal(files.length, 1);
    assert.equal(files[0].id, id);
    assert.equal(files[0].archived, archived);
  }
});
