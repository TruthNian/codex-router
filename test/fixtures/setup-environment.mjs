import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
const keychainFixture = new URL("./setup-keychain-isolation.mjs", import.meta.url).href;

export function setupFixtureRoot(prefix) {
  const parent = process.env.CODEX_HOME || os.tmpdir();
  assert.equal(path.isAbsolute(parent), true);
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, prefix));
  assert.equal(path.relative(parent, root).startsWith(".."), false);
  return root;
}

// Setup's discovery tests opt in only after every credential/client root and
// both state aliases are bound to their own fresh synthetic fixture.
export function setupFixtureEnvironment(root, state, codex = path.join(root, "codex")) {
  const environment = {
    ...process.env,
    HOME: root, USERPROFILE: root,
    APPDATA: path.join(root, "appdata"), LOCALAPPDATA: path.join(root, "localappdata"),
    CODEX_HOME: codex,
    MODEL_ROUTER_STATE_DIR: state, CODEX_ROUTER_STATE_DIR: state,
    KIMI_CODE_HOME: path.join(root, "kimi-code"),
    GROK_HOME: path.join(root, "grok"), GROK_AUTH_PATH: path.join(root, "grok", "auth.json"),
    DEVIN_CREDENTIALS_PATH: path.join(root, "devin", "credentials.toml"),
    XDG_CONFIG_HOME: path.join(root, ".config"), XDG_DATA_HOME: path.join(root, ".local", "share"),
    CLOUDSDK_CONFIG: path.join(root, "gcloud"),
    GOOGLE_APPLICATION_CREDENTIALS: path.join(root, "gcloud", "application-default.json"),
    MODEL_ROUTER_API_KEY_POOL_PATH: path.join(state, "provider-api-key-pool.json"),
    MODEL_ROUTER_GENERIC_PROVIDERS: path.join(state, "generic-providers.json"),
    MODEL_ROUTER_VERTEX_STATE_PATH: path.join(state, "vertex-settings.json"),
    MODEL_ROUTER_LAUNCH_AGENTS_DIR: path.join(root, "LaunchAgents"),
    CODEX_ROUTER_LAUNCH_AGENTS_DIR: path.join(root, "LaunchAgents"),
    CODEX_ROUTER_SERVICE_PLATFORM: process.platform,
    CODEX_ROUTER_SETUP_FIXTURE_ROOT: root,
  };
  for (const name of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "CODEX_HOME", "MODEL_ROUTER_STATE_DIR", "CODEX_ROUTER_STATE_DIR", "KIMI_CODE_HOME", "GROK_HOME", "GROK_AUTH_PATH", "DEVIN_CREDENTIALS_PATH", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "CLOUDSDK_CONFIG", "GOOGLE_APPLICATION_CREDENTIALS", "MODEL_ROUTER_API_KEY_POOL_PATH", "MODEL_ROUTER_GENERIC_PROVIDERS", "MODEL_ROUTER_VERTEX_STATE_PATH", "MODEL_ROUTER_LAUNCH_AGENTS_DIR", "CODEX_ROUTER_LAUNCH_AGENTS_DIR"]) {
    assert.equal(path.isAbsolute(environment[name]), true);
    assert.equal(path.relative(root, environment[name]).startsWith(".."), false);
  }
  for (const name of Object.keys(environment)) {
    if (/(?:_API_KEY|_API_TOKEN)$/.test(name)) environment[name] = "";
  }
  environment.CODEX_ROUTER_NO_DISCOVERY = "0";
  environment.NODE_OPTIONS = `${environment.NODE_OPTIONS || ""} --import=${JSON.stringify(keychainFixture)}`.trim();
  return environment;
}
