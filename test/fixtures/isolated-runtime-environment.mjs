import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";

// Import this before any src module: paths.mjs captures its environment at
// evaluation time. A bare CI invocation must be as isolated as a local runner.
// Children preload only the Keychain boundary, preserving their own fixtures.
const keychainOnly = new URL(import.meta.url).searchParams.has("keychain-only");
const temporaryDirectory = path.resolve(os.tmpdir());
const keychainGuard = Symbol.for("codex-router.test.isolated-keychain");
if (!childProcess[keychainGuard]) {
  const originalExecFileSync = childProcess.execFileSync;
  childProcess.execFileSync = function (file, args, ...options) {
    if (file === "/usr/bin/security" || file === "security") {
      const error = new Error("The isolated runtime fixture cannot access the host Keychain.");
      error.status = args?.[0] === "find-generic-password" ? 44 : 1;
      throw error;
    }
    return originalExecFileSync.call(this, file, args, ...options);
  };
  childProcess[keychainGuard] = true;
  syncBuiltinESMExports();
}

export const isolatedRuntimeRoot = keychainOnly
  ? undefined
  : mkdtempSync(path.join(temporaryDirectory, "codex-router-isolated-runtime-"));
export const isolatedRuntimeHome = keychainOnly
  ? undefined
  : path.join(isolatedRuntimeRoot, "codex");
export const isolatedRuntimeStateDir = keychainOnly
  ? undefined
  : path.join(isolatedRuntimeRoot, "state");

if (!keychainOnly) {
  process.once("exit", () => {
    assert.equal(path.isAbsolute(isolatedRuntimeRoot), true);
    assert.equal(path.dirname(isolatedRuntimeRoot), temporaryDirectory);
    assert.ok(path.basename(isolatedRuntimeRoot).startsWith("codex-router-isolated-runtime-"));
    rmSync(isolatedRuntimeRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const environment = {
    HOME: isolatedRuntimeRoot,
    USERPROFILE: isolatedRuntimeRoot,
    APPDATA: path.join(isolatedRuntimeRoot, "appdata"),
    LOCALAPPDATA: path.join(isolatedRuntimeRoot, "localappdata"),
    CODEX_HOME: isolatedRuntimeHome,
    CODEX_ROUTER_STATE_DIR: isolatedRuntimeStateDir,
    XDG_CONFIG_HOME: path.join(isolatedRuntimeRoot, ".config"),
    XDG_DATA_HOME: path.join(isolatedRuntimeRoot, ".local", "share"),
    KIMI_CODE_HOME: path.join(isolatedRuntimeRoot, "kimi-code"),
    GROK_HOME: path.join(isolatedRuntimeRoot, "grok"),
    GROK_AUTH_PATH: path.join(isolatedRuntimeRoot, "grok", "auth.json"),
    DEVIN_CREDENTIALS_PATH: path.join(isolatedRuntimeRoot, "devin", "credentials.toml"),
    CLOUDSDK_CONFIG: path.join(isolatedRuntimeRoot, "gcloud"),
    GOOGLE_APPLICATION_CREDENTIALS: path.join(isolatedRuntimeRoot, "gcloud", "application-default.json"),
    GCLOUD_BIN: path.join(isolatedRuntimeRoot, "missing-gcloud"),
    DSH_HOME: path.join(isolatedRuntimeRoot, "dsh"),
    GEMINI_CLI_HOME: isolatedRuntimeRoot,
    CURSOR_HOME: path.join(isolatedRuntimeRoot, "cursor"),
    PI_CODING_AGENT_DIR: path.join(isolatedRuntimeRoot, "pi"),
    HERMES_HOME: path.join(isolatedRuntimeRoot, "hermes"),
    CLAUDE_CONFIG_DIR: path.join(isolatedRuntimeRoot, "claude"),
  };
  for (const value of Object.values(environment)) {
    const relative = path.relative(isolatedRuntimeRoot, value);
    assert.equal(path.isAbsolute(value), true);
    assert.equal(relative.startsWith("..") || path.isAbsolute(relative), false);
  }
  for (const directory of [isolatedRuntimeHome, isolatedRuntimeStateDir, environment.APPDATA, environment.LOCALAPPDATA]) {
    mkdirSync(directory, { recursive: true });
  }
  // A high-priority alias would mask legacy fixtures that deliberately replace
  // only CODEX_ROUTER_STATE_DIR. Other inherited file overrides must not escape
  // the synthetic home or keep referring to the caller's real installation.
  for (const name of [
    "MODEL_ROUTER_STATE_DIR", "KIMI_CODEX_STATE_DIR",
    "MODEL_ROUTER_DSH_SETTINGS", "MODEL_ROUTER_DSH_CREDENTIALS",
    "MODEL_ROUTER_GEMINI_ENV", "MODEL_ROUTER_CURSOR_STATE_DB", "MODEL_ROUTER_CURSOR_LAUNCHER",
    "MODEL_ROUTER_OPENCODE_CONFIG", "OPENCODE_CONFIG", "MODEL_ROUTER_PI_MODELS", "MODEL_ROUTER_OMP_MODELS",
    "MODEL_ROUTER_COMMANDCODE_PROVIDERS", "MODEL_ROUTER_HERMES_CONFIG", "MODEL_ROUTER_CLAUDE_LAUNCHER",
    "MODEL_ROUTER_API_KEY_POOL_PATH", "MODEL_ROUTER_PROVIDER_CREDENTIAL_STORE",
    "MODEL_ROUTER_PROVIDER_CREDENTIAL_MIGRATIONS", "MODEL_ROUTER_CHATGPT_ACCOUNT_POOL",
    "MODEL_ROUTER_CHATGPT_ACCOUNT_HOMES", "MODEL_ROUTER_GENERIC_PROVIDERS",
    "MODEL_ROUTER_SEARCH_SIDECARS", "MODEL_ROUTER_USER_MODELS", "MODEL_ROUTER_VERTEX_STATE_PATH",
    "MODEL_ROUTER_LAUNCH_AGENTS_DIR", "CODEX_ROUTER_LAUNCH_AGENTS_DIR",
  ]) delete process.env[name];
  for (const name of Object.keys(process.env)) {
    if (/(?:_API_KEY|_API_TOKEN)$/.test(name)) delete process.env[name];
  }
  Object.assign(process.env, environment);
  const preload = new URL(import.meta.url);
  preload.search = "?keychain-only=1";
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ""} --import=${JSON.stringify(preload.href)}`.trim();
}
