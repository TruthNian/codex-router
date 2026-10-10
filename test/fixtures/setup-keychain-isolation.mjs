import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";

// HOME cannot isolate the global macOS Keychain. Load this only for setup's
// synthetic subprocesses and retain all other subprocess behavior unchanged.
const root = process.env.CODEX_ROUTER_SETUP_FIXTURE_ROOT;
assert.equal(typeof root, "string");
assert.equal(path.isAbsolute(root), true);
for (const name of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "CODEX_HOME", "MODEL_ROUTER_STATE_DIR", "CODEX_ROUTER_STATE_DIR", "KIMI_CODE_HOME", "GROK_HOME", "GROK_AUTH_PATH", "DEVIN_CREDENTIALS_PATH", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "CLOUDSDK_CONFIG", "GOOGLE_APPLICATION_CREDENTIALS", "MODEL_ROUTER_API_KEY_POOL_PATH", "MODEL_ROUTER_GENERIC_PROVIDERS", "MODEL_ROUTER_VERTEX_STATE_PATH"]) {
  assert.equal(path.isAbsolute(process.env[name]), true);
  assert.equal(path.relative(root, process.env[name]).startsWith(".."), false);
}
assert.equal(process.env.MODEL_ROUTER_STATE_DIR, process.env.CODEX_ROUTER_STATE_DIR);
const execFileSync = childProcess.execFileSync;
childProcess.execFileSync = function (file, args, ...options) {
  if (file === "/usr/bin/security" && args?.[0] === "find-generic-password") {
    const absent = new Error("No credential in the synthetic fixture Keychain.");
    absent.status = 44;
    throw absent;
  }
  return execFileSync.call(this, file, args, ...options);
};
syncBuiltinESMExports();
