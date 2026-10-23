import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "compatibility-install-"));
  const checkout = path.join(directory, "checkout");
  const shims = path.join(directory, "shims");
  const state = path.join(directory, "state");
  const calls = path.join(directory, "calls.log");
  for (const dir of [checkout, shims, state]) mkdirSync(dir);
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(MODEL_ROUTER_|CODEX_ROUTER_|KIMI_|GROK_|GOOGLE_|GCLOUD_)/.test(key) || /(?:_API_KEY|_TOKEN)$/.test(key)) delete env[key];
  }
  Object.assign(env, { HOME: directory, USERPROFILE: directory, CODEX_HOME: path.join(directory, "home"),
    MODEL_ROUTER_STATE_DIR: state, MODEL_ROUTER_TARGET: "codex", FIXTURE_CALLS: calls });
  return { directory, checkout, shims, state, calls, env };
}

function windows(policy, force) {
  const f = fixture();
  try {
    cpSync(path.join(root, "install.ps1"), path.join(f.checkout, "install.ps1"));
    writeFileSync(path.join(f.checkout, "package.json"), '{"name":"codex-model-router"}');
    writeFileSync(path.join(f.shims, "node.cmd"), ["@echo off", 'echo node %*>>"%FIXTURE_CALLS%"',
      'if /I "%~1"=="-p" (echo 24.0.0& exit /b 0)',
      'if /I "%~1"=="src/compatibility-layer-state.mjs" (echo %FIXTURE_POLICY%& exit /b 0)',
      'if /I "%~1"=="src/install-plan.mjs" if /I "%~2"=="status" (echo skip& exit /b 0)',
      'if /I "%~2"=="status" echo {"mode":"native","installed":false}',
      "exit /b 0", ""].join("\r\n"));
    for (const tool of ["npm", "uv"]) writeFileSync(path.join(f.shims, `${tool}.cmd`),
      `@echo off\r\necho ${tool} %*>>"%FIXTURE_CALLS%"\r\nexit /b 0\r\n`);
    const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
      path.join(f.checkout, "install.ps1"), "-CheckoutInstall", "-PrepareOnly", ...(force ? ["-ForceDeps"] : [])], {
      cwd: f.checkout, env: { ...f.env, PATH: `${f.shims};${process.env.PATH}`, FIXTURE_POLICY: policy },
      encoding: "utf8", timeout: 30_000,
    });
    return { result, calls: existsSync(f.calls) ? readFileSync(f.calls, "utf8").replace(/\\/g, "/") : "" };
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
}

for (const force of [false, true]) test(`Windows ${force ? "forced repair" : "installation"} respects compatibility off`,
  { skip: process.platform !== "win32" }, () => {
    const { result, calls } = windows("unused", force);
    assert.equal(result.status, 0, result.stderr);
    assert.match(calls, /compatibility-layer-state.mjs required/);
    assert.doesNotMatch(calls, /python-deps|uv |pip|venv/);
    if (force) assert.match(calls, /npm ci/);
  });

test("Windows invalid policy query fails before Python provisioning", { skip: process.platform !== "win32" }, () => {
  const { result, calls } = windows("invalid", true);
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(calls, /python-deps|uv |pip|venv/);
});

test("Windows enabled compatibility remains a positive Python provisioning control", { skip: process.platform !== "win32" }, () => {
  const { result, calls } = windows("required", true);
  assert.equal(result.status, 0, result.stderr);
  assert.match(calls, /uv pip install .*--require-hashes/);
});

function shellPath() {
  if (process.platform !== "win32") return "sh";
  const git = spawnSync("git", ["--exec-path"], { encoding: "utf8" });
  const shell = git.status === 0 ? path.resolve(git.stdout.trim(), "../../..", "bin", "sh.exe") : "";
  return shell && existsSync(shell) ? shell : null;
}
const shell = shellPath();
function posix(policy, force) {
  const f = fixture();
  try {
    mkdirSync(path.join(f.checkout, "bin"));
    cpSync(path.join(root, "bin/install"), path.join(f.checkout, "bin/install"));
    const unix = value => process.platform === "win32"
      ? value.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, c) => `/${c.toLowerCase()}`) : value;
    writeFileSync(path.join(f.shims, "node"), `#!/bin/sh
printf '%s\\n' "node $*" >>"$FIXTURE_CALLS"
case "$1" in
  src/compatibility-layer-state.mjs) printf '%s\\n' "$FIXTURE_POLICY" ;;
  src/install-plan.mjs) [ "\${2:-}" = status ] && printf 'skip\\n' ;;
esac
exit 0
`, { mode: 0o755 });
    for (const tool of ["npm", "uv"]) writeFileSync(path.join(f.shims, tool),
      `#!/bin/sh\nprintf '%s\\n' "${tool} $*" >>"$FIXTURE_CALLS"\nexit 0\n`, { mode: 0o755 });
    const result = spawnSync(shell, ["-c", 'PATH="$FIXTURE_RUNTIME:/usr/bin:/bin"; export PATH; exec sh "$FIXTURE_ENTRY" "$@"',
      "fixture", "--prepare-only", ...(force ? ["--force-deps"] : [])], {
      cwd: f.checkout, encoding: "utf8", timeout: 30_000,
      env: { ...f.env, FIXTURE_POLICY: policy, FIXTURE_CALLS: unix(f.calls),
        FIXTURE_RUNTIME: unix(f.shims), FIXTURE_ENTRY: unix(path.join(f.checkout, "bin/install")) },
    });
    return { result, calls: existsSync(f.calls) ? readFileSync(f.calls, "utf8") : "" };
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
}
for (const force of [false, true]) test(`POSIX ${force ? "forced repair" : "installation"} respects compatibility off`, { skip: !shell }, () => {
  const { result, calls } = posix("unused", force);
  assert.equal(result.status, 0, result.stderr);
  assert.match(calls, /compatibility-layer-state.mjs required/);
  assert.doesNotMatch(calls, /python-deps|uv |pip|venv/);
  if (force) assert.match(calls, /npm ci/);
});

test("POSIX enabled compatibility remains a positive Python provisioning control", { skip: !shell }, () => {
  const { result, calls } = posix("required", true);
  assert.equal(result.status, 0, result.stderr);
  assert.match(calls, /uv pip install .*--require-hashes/);
});
