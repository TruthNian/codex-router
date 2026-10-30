import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { posixShell } from "./helpers/posix-shell.mjs";

const shell = posixShell();
const source = readFileSync(new URL("../packaging/homebrew/check-core-readiness.sh", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const formula = "local/codex-router-readiness/codex-router";
const trust = 'brew trust --formula "$tap_name/codex-router"\n';

function runFixture({ install = false, withoutTrust = false, failure = "", existingTap = false, existingFormula = false } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "homebrew-readiness-"));
  const script = path.join(root, "packaging/homebrew/check-core-readiness.sh");
  mkdirSync(path.dirname(script), { recursive: true });
  mkdirSync(path.join(root, "Formula"));
  mkdirSync(path.join(root, "tmp"));
  writeFileSync(path.join(root, "Formula/codex-router.rb"), "fixture formula bytes\n");
  assert.equal(source.split(trust).length, 2, "the exact temporary formula must have one trust boundary");
  writeFileSync(script, withoutTrust ? source.replace(trust, "") : source);
  // A shell function shadows brew for the complete shipped script. No host
  // package manager is executed, including during the script's EXIT trap.
  const fixture = `
brew() {
  printf '%s\\n' "$*" >> "$FIXTURE_ROOT/calls"
  case "$1" in
    tap) [ "$EXISTING_TAP" != true ] || printf '%s\\n' local/codex-router-readiness ;;
    tap-new)
      [ "$*" = 'tap-new --no-git local/codex-router-readiness' ] || return 91
      mkdir -p "$FIXTURE_ROOT/tap/Formula" ;;
    --repository) printf '%s\\n' "$FIXTURE_ROOT/tap" ;;
    trust)
      [ "$*" = 'trust --formula ${formula}' ] || return 92
      cmp "$FIXTURE_ROOT/Formula/codex-router.rb" "$FIXTURE_ROOT/tap/Formula/codex-router.rb" || return 93
      [ "$FAILURE" != trust ] || return 17
      touch "$FIXTURE_ROOT/trusted" ;;
    style)
      [ -f "$2" ] || return 94 ;;
    audit|install)
      if [ ! -f "$FIXTURE_ROOT/trusted" ]; then echo 'untrusted temporary formula' >&2; return 42; fi
      case "$1" in
        audit) [ "$*" = 'audit --strict --new --online --formula ${formula}' ] || return 95 ;;
        install) [ "$*" = 'install --build-from-source ${formula}' ] || return 96 ;;
      esac
      [ "$FAILURE" != "$1" ] || return 17 ;;
    list) [ "$*" = 'list --formula codex-router' ] || return 97; [ "$EXISTING_FORMULA" = true ] ;;
    test|uninstall) [ "$2" = '${formula}' ] || return 98; [ "$FAILURE" != "$1" ] || return 17 ;;
    untap) [ "$2" = local/codex-router-readiness ] || return 99; rm -rf "$FIXTURE_ROOT/tap" ;;
    *) return 100 ;;
  esac
}
. "$0"
`;
  try {
    const result = spawnSync(shell, ["-c", fixture, script.replaceAll("\\", "/"), ...(install ? ["--install"] : [])], {
      encoding: "utf8", timeout: 5_000,
      env: { ...process.env, FIXTURE_ROOT: root.replaceAll("\\", "/"), TMPDIR: path.join(root, "tmp").replaceAll("\\", "/"),
        FAILURE: failure, EXISTING_TAP: String(existingTap), EXISTING_FORMULA: String(existingFormula) },
    });
    const calls = readFileSync(path.join(root, "calls"), "utf8").trim().split("\n");
    return { ...result, calls, tapExists: existsSync(path.join(root, "tap")),
      probeExists: readdirSync(path.join(root, "tmp")).length !== 0 };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const install of [false, true]) test(`Homebrew readiness trusts only its copied formula before audit${install ? " and install" : ""}`, { skip: !shell }, () => {
  const result = runFixture({ install });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls.filter(call => call.startsWith("trust ")), [`trust --formula ${formula}`]);
  assert.ok(result.calls.indexOf(`trust --formula ${formula}`) > result.calls.indexOf("tap-new --no-git local/codex-router-readiness"));
  assert.ok(result.calls.indexOf(`trust --formula ${formula}`) < result.calls.indexOf(`audit --strict --new --online --formula ${formula}`));
  assert.deepEqual(result.calls.filter(call => /^(install|test|uninstall) /.test(call)), install
    ? [`install --build-from-source ${formula}`, `test ${formula}`, `uninstall ${formula}`] : []);
  assert.equal(result.calls.at(-1), "untap local/codex-router-readiness");
  assert.equal(result.tapExists, false);
  assert.equal(result.probeExists, false);
});

test("the old untrusted readiness path fails audit and still cleans its temporary tap", { skip: !shell }, () => {
  const result = runFixture({ withoutTrust: true });
  assert.equal(result.status, 42, result.stderr);
  assert.match(result.stderr, /untrusted temporary formula/);
  assert.equal(result.calls.at(-1), "untap local/codex-router-readiness");
  assert.equal(result.tapExists, false);
  assert.equal(result.probeExists, false);
});

test("Homebrew readiness refuses a pre-existing tap before mutation or trust", { skip: !shell }, () => {
  const result = runFixture({ existingTap: true });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /already exists/);
  assert.deepEqual(result.calls, ["tap"]);
});

test("Homebrew readiness refuses to replace the user's installed formula", { skip: !shell }, () => {
  const result = runFixture({ install: true, existingFormula: true });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /refusing to replace the user's formula/);
  assert.deepEqual(result.calls.filter(call => /^(install|uninstall) /.test(call)), []);
  assert.equal(result.calls.at(-1), "untap local/codex-router-readiness");
  assert.equal(result.tapExists, false);
  assert.equal(result.probeExists, false);
});

for (const failure of ["trust", "audit", "test"]) test(`Homebrew readiness preserves ${failure} failure and cleans only its own artifacts`, { skip: !shell }, () => {
  const result = runFixture({ install: true, failure });
  assert.equal(result.status, 17, result.stderr);
  if (failure === "trust") assert.equal(result.calls.some(call => /^(audit|install) /.test(call)), false);
  assert.deepEqual(result.calls.filter(call => call.startsWith("uninstall ")), failure === "test" ? [`uninstall ${formula}`] : []);
  assert.equal(result.calls.at(-1), "untap local/codex-router-readiness");
  assert.equal(result.tapExists, false);
  assert.equal(result.probeExists, false);
});
