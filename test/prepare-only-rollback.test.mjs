import "./helpers/isolated-runtime-environment.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { posixShell } from "./helpers/posix-shell.mjs";

const shell = posixShell();
const source = readFileSync(new URL("../install.sh", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const branchStart = source.indexOf('if [ "$prepare_only" = true ]; then');
const branchEnd = source.indexOf('\nfi\n', branchStart);
assert.ok(branchStart >= 0 && branchEnd > branchStart);
const branch = source.slice(branchStart, branchEnd + 4)
  .replace('"$repo_dir/bin/install" --prepare-only', 'fixture_install');
const restoreStart = source.indexOf("restore_previous_revision() {");
const restoreEnd = source.indexOf("\n}\n", restoreStart);
assert.ok(restoreStart >= 0 && restoreEnd > restoreStart);
const restore = source.slice(restoreStart, restoreEnd + 3);

for (const status of [0, 2, 17]) test(`prepare-only status ${status} ${status ? "restores the saved source revision" : "keeps the prepared checkout"}`, { skip: !shell }, () => {
  const result = spawnSync(shell, ["-s"], {
    encoding: "utf8", timeout: 5_000,
    input: `set -eu\nprepare_only=true\nprevious_revision=synthetic-old-revision\nrepo_dir=/synthetic\nfixture_git_called=false\nfixture_install() { return ${status}; }\ngit() { [ "$*" = '-C /synthetic switch --detach synthetic-old-revision' ] || exit 99; fixture_git_called=true; }\ndie() { [ "$fixture_git_called" = true ] || exit 98; printf 'FAIL:%s\\n' "$*"; exit 1; }\n${restore}\n${branch}\n`,
  });
  assert.equal(result.status, status ? 1 : 0, result.stderr);
  if (status) {
    assert.match(result.stdout, /managed source checkout was restored to synthetic-old-revision/);
    assert.match(result.stdout, /dependency preparation must be retried/);
  } else assert.equal(result.stdout, "");
});
