import "./helpers/isolated-runtime-environment.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { posixShell } from "./helpers/posix-shell.mjs";

const shell = posixShell();
const source = readFileSync(new URL("../scripts/build-electron-companion.sh", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const start = source.indexOf('(\n  cd "$app_dir"');
const end = source.indexOf('\nstaged_dir=', start);
assert.ok(start >= 0 && end > start);
const build = source.slice(start, end).replace('"$app_dir/node_modules/.bin/electron-builder"', 'fixture_builder');

test("Linux packaging selects the app project from both checkout and unrelated working directories", { skip: !shell }, (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "linux-builder-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, "app");
  mkdirSync(app);
  for (const cwd of [fileURLToPath(new URL("../", import.meta.url)), root]) {
    const result = spawnSync(shell, ["-s", "--", app.replaceAll("\\", "/")], {
      cwd, encoding: "utf8", timeout: 5_000,
      input: `set -eu\napp_dir=$(CDPATH='' cd -- "$1" && pwd -P)\nstaging_root=/synthetic-staging\nnpm() { [ "$PWD" = "$app_dir" ] || exit 90; printf 'npm:%s\\n' "$*"; }\nfixture_builder() { [ "$PWD" = "$app_dir" ] || exit 91; [ "$CSC_IDENTITY_AUTO_DISCOVERY" = false ] || exit 92; printf 'builder:%s\\n' "$*"; }\n${build}\n`,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stderr.trim().split(/\r?\n/), [
      "npm:ci", "npm:run check", "npm:test", "npm:run build",
      "builder:--linux dir --publish never --config.directories.output=/synthetic-staging",
    ]);
  }
});
