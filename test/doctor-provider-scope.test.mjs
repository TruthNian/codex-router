import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let server;
let routerPort;

test.before(async () => {
  // Only health is substituted: provider selection, registry loading and every
  // credential reader execute the actual doctor code in the child process.
  server = spawn(process.execPath, ["--input-type=module", "-e", `
    import http from "node:http";
    const server = http.createServer((_request, response) => {
      response.writeHead(200, {"content-type":"application/json"});
      response.end(JSON.stringify({service:"codex-router",version:"fixture"}));
    });
    server.listen(0,"127.0.0.1",()=>process.stdout.write(String(server.address().port)));
  `], { stdio: ["ignore", "pipe", "inherit"] });
  const [chunk] = await once(server.stdout, "data");
  routerPort = Number(chunk);
});

test.after(async () => {
  if (!server) return;
  const exited = once(server, "exit");
  server.kill();
  await exited;
});

function stage({ providers = ["custom"], deepseekKey = true, pool, credentialStore, generic, noDiscovery = false } = {}) {
  const fixture = mkdtempSync(path.join(process.env.CODEX_HOME || os.tmpdir(), "doctor-provider-scope-"));
  const home = path.join(fixture, "codex");
  const state = path.join(fixture, "state");
  const kimi = path.join(fixture, "kimi");
  mkdirSync(home, { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(path.join(kimi, "credentials"), { recursive: true });
  mkdirSync(path.join(fixture, "grok"), { recursive: true });
  writeFileSync(path.join(home, "config.toml"), 'model = "gpt-5.6-sol"\n');
  if (providers !== null) {
    writeFileSync(path.join(state, "enabled-providers.json"), JSON.stringify({ version: 1, providers }));
  }
  if (deepseekKey) writeFileSync(path.join(state, "deepseek-api-key.secret"), "SYNTHETIC_DEEPSEEK_KEY\n");
  writeFileSync(path.join(kimi, "credentials", "kimi-code.json"), "{ invalid synthetic credential");
  writeFileSync(path.join(fixture, "grok", "auth.json"), "{ invalid synthetic credential");
  writeFileSync(path.join(state, "antigravity-oauth.json"), "{ invalid synthetic credential");
  if (pool !== undefined) writeFileSync(path.join(state, "provider-api-key-pools.json"), pool);
  if (credentialStore) writeFileSync(path.join(state, "provider-credentials.json"), JSON.stringify(credentialStore));
  if (generic) writeFileSync(path.join(state, "generic-providers.json"), JSON.stringify({ version: 1, providers: generic }));

  const probe = path.join(fixture, "read-probe.mjs");
  const reads = path.join(fixture, "credential-reads.jsonl");
  writeFileSync(probe, `
    import fs from "node:fs";
    import childProcess from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";
    import path from "node:path";
    const fixture = ${JSON.stringify(fixture)};
    const reads = ${JSON.stringify(reads)};
    const watched = new Set([
      path.join(fixture,"state","deepseek-api-key.secret"),
      path.join(fixture,"kimi","credentials","kimi-code.json"),
      path.join(fixture,"grok","auth.json"),
      path.join(fixture,"state","antigravity-oauth.json"),
    ]);
    function record(file) {
      const target = file instanceof URL ? file.pathname : String(file);
      if (watched.has(path.resolve(target))) {
        const relative = path.relative(fixture, target);
        if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Credential probe escaped its fixture");
        fs.appendFileSync(reads, JSON.stringify(path.basename(target)) + "\\n");
      }
    }
    const read = fs.readFileSync;
    fs.readFileSync = function(file, ...args) {
      record(file);
      return read.call(this, file, ...args);
    };
    // Antigravity intentionally opens a no-follow descriptor and reads from
    // it; observing only readFileSync(path) would miss that credential reader.
    const open = fs.openSync;
    fs.openSync = function(file, ...args) {
      record(file);
      return open.call(this, file, ...args);
    };
    // A fixture HOME does not isolate the logged-in macOS Keychain or gcloud.
    // Do not let an --all positive control consult either real credential store.
    const exec = childProcess.execFileSync;
    childProcess.execFileSync = function(command, ...args) {
      if (command === "/usr/bin/security" || /(?:^|[\\\\/])gcloud(?:\\.cmd|\\.exe)?$/.test(String(command))) {
        throw Object.assign(new Error("Credential CLI unavailable in fixture"), {code:"ENOENT"});
      }
      return exec.call(this, command, ...args);
    };
    syncBuiltinESMExports();
  `);

  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(?:MODEL_ROUTER_|CODEX_ROUTER_|KIMI_|GROK_|DEVIN_|GOOGLE_|GCLOUD_|XDG_)/.test(name) &&
    !/(?:API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|CREDENTIALS)/i.test(name)));
  Object.assign(environment, {
    HOME: fixture,
    USERPROFILE: fixture,
    APPDATA: path.join(fixture, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(fixture, "AppData", "Local"),
    CODEX_HOME: home,
    CODEX_BIN: process.execPath,
    KIMI_CODE_HOME: kimi,
    GROK_HOME: path.join(fixture, "grok"),
    DEVIN_CREDENTIALS_PATH: path.join(fixture, "devin", "credentials.toml"),
    MODEL_ROUTER_TARGET: "codex",
    MODEL_ROUTER_STATE_DIR: state,
    CODEX_ROUTER_STATE_DIR: state,
    MODEL_ROUTER_PORT: String(routerPort),
    MODEL_ROUTER_LITELLM_BIN: process.execPath,
    MODEL_ROUTER_LAUNCH_AGENTS_DIR: path.join(fixture, "launch-agents"),
    CODEX_ROUTER_SERVICE_PLATFORM: "test-fixture",
    // Both credential roots have been constructed above; enabling discovery
    // here exercises only synthetic provider files, never the host profile.
    CODEX_ROUTER_NO_DISCOVERY: noDiscovery ? "1" : "0",
  });
  assert.ok(path.relative(fixture, home).startsWith("codex"));
  assert.ok(path.relative(fixture, state).startsWith("state"));
  return { fixture, environment, probe, reads };
}

function doctor(options = {}, args = []) {
  const fixture = stage(options);
  try {
    const result = spawnSync(process.execPath, ["--import", pathToFileURL(fixture.probe).href,
      path.join(repository, "src", "doctor.mjs"), "--json", ...args], {
      cwd: repository, env: fixture.environment, encoding: "utf8", timeout: 120_000,
    });
    assert.equal(result.error, undefined);
    assert.ok(result.stdout, result.stderr);
    const report = JSON.parse(result.stdout);
    return {
      checks: new Map(report.checks.map((check) => [check.name, check])),
      reads: existsSync(fixture.reads)
        ? readFileSync(fixture.reads, "utf8").trim().split("\n").map(JSON.parse)
        : [],
    };
  } finally {
    rmSync(fixture.fixture, { recursive: true, force: true });
  }
}

test("default doctor checks selected providers without opening disabled credentials", () => {
  const { checks, reads } = doctor();
  assert.equal(checks.get("Custom per-model endpoints").status, "ok");
  for (const name of ["DeepSeek API key", "Kimi OAuth", "Grok OAuth", "Antigravity OAuth"]) {
    assert.equal(checks.has(name), false, name);
  }
  assert.deepEqual(reads, [], "hidden credential readers still scanned disabled providers");
});

test("--all restores inventory and is a positive control for the read detector", () => {
  const { checks, reads } = doctor({}, ["--all"]);
  assert.equal(checks.get("DeepSeek API key").status, "ok");
  assert.equal(checks.get("Kimi OAuth").status, "warn");
  assert.ok(reads.includes("deepseek-api-key.secret"));
  assert.ok(reads.includes("kimi-code.json"));
  assert.ok(reads.includes("auth.json"));
  assert.ok(reads.includes("antigravity-oauth.json"));
});

test("selected missing API credentials remain failures", () => {
  const { checks, reads } = doctor({ providers: ["deepseek"], deepseekKey: false });
  assert.equal(checks.get("DeepSeek API key").status, "fail");
  assert.equal(checks.has("Kimi OAuth"), false);
  assert.deepEqual(reads, []);
});

test("selection of a protocol variant keeps the canonical provider family in scope", () => {
  const { checks, reads } = doctor({ providers: ["commandcode-messages"] });
  assert.equal(checks.get("Command Code key").status, "fail");
  assert.equal(checks.get("Command Code Messages key").status, "fail");
  assert.equal(checks.has("DeepSeek API key"), false);
  assert.deepEqual(reads, []);
});

test("invalid authoritative pools cannot be masked by a selected legacy credential", () => {
  const { checks } = doctor({ providers: ["deepseek"], pool: "{invalid pool state" });
  assert.equal(checks.get("Provider API-key pools").status, "fail");
  assert.equal(checks.get("DeepSeek API key").status, "fail");
});

test("disabled pool references are not resolved until --all explicitly requests inventory", () => {
  const credentialId = "cred_scope_deepseek_ref";
  const options = {
    pool: JSON.stringify({ version: 1, providers: {
      deepseek: { credentials: { [credentialId]: {} } },
    } }),
    credentialStore: { schemaVersion: 2, credentials: [{
      id: credentialId, providerId: "deepseek", kind: "api_key", state: "active",
      secretRef: { type: "provider-file", providerId: "deepseek", target: "codex" },
    }] },
  };
  const scoped = doctor(options);
  assert.deepEqual(scoped.reads, []);
  assert.equal(scoped.checks.has("Provider API-key pools"), false);
  const inventory = doctor(options, ["--all"]);
  assert.ok(inventory.reads.includes("deepseek-api-key.secret"));
  assert.equal(inventory.checks.get("Provider API-key pools").status, "ok");
});

test("selected empty authoritative pools stay failures despite a usable legacy key", () => {
  const { checks, reads } = doctor({ providers: ["deepseek"],
    pool: JSON.stringify({ version: 1, providers: { deepseek: {} } }),
  });
  assert.equal(checks.get("Provider API-key pools").status, "fail");
  assert.equal(checks.get("DeepSeek API key").status, "fail");
  assert.deepEqual(reads, [], "doctor bypassed authoritative pool state for the legacy key");
});

test("enabled generic providers remain diagnosed outside the built-in selection file", () => {
  const descriptor = { displayName: "Scope fixture", baseUrl: "https://provider.example.test/v1",
    adapter: "openai-responses", credentialRef: "cred_missing_fixture", headers: {} };
  const options = { providers: [], generic: [
    { ...descriptor, id: "scope-enabled", enabled: true },
    { ...descriptor, id: "scope-disabled", displayName: "Disabled fixture", enabled: false },
  ] };
  const { checks } = doctor(options);
  assert.equal(checks.get("Scope fixture generic provider").status, "fail");
  assert.equal(checks.has("Disabled fixture generic provider"), false);
  const inventory = doctor(options, ["--all"]);
  assert.equal(inventory.checks.get("Scope fixture generic provider").status, "fail");
  assert.equal(inventory.checks.get("Disabled fixture generic provider").status, "ok");
  assert.match(inventory.checks.get("Disabled fixture generic provider").detail, /disabled/);
});

test("legacy show-all selections retain credential diagnostics", () => {
  const { checks, reads } = doctor({ providers: null });
  assert.equal(checks.get("DeepSeek API key").status, "ok");
  assert.equal(checks.get("Kimi OAuth").status, "fail");
  assert.ok(reads.includes("deepseek-api-key.secret"));
  assert.ok(reads.includes("kimi-code.json"));
});

test("--all never overrides credential discovery being disabled", () => {
  const { checks, reads } = doctor({ noDiscovery: true }, ["--all"]);
  assert.equal(checks.get("Credential discovery").status, "warn");
  assert.equal(checks.has("DeepSeek API key"), false);
  assert.equal(checks.has("Kimi OAuth"), false);
  assert.deepEqual(reads, []);
});
