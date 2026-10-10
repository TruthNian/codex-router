import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { userModelEntry } from "../src/user-models.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureBase = process.env.CODEX_HOME || os.tmpdir();

function model(provider, id, extra = {}) {
  return { ...userModelEntry({ providerId: provider, upstreamId: id, priority: 1 }), ...extra };
}

function apiProvider(id, protocol = "openai") {
  return { id, kind: "openai-compatible", displayName: id, ownedBy: "fixture", protocol,
    baseUrl: "https://fixture.example.test/v1",
    credential: { file: `${id}.secret`, environment: ["FIXTURE_UNUSED_KEY"] } };
}

function fixture({ providers = [], models = [], selected = [], generic, userModels } = {}) {
  const directory = mkdtempSync(path.join(fixtureBase, "runtime-dependencies-"));
  const home = path.join(directory, "codex");
  const state = path.join(directory, "state");
  mkdirSync(home, { recursive: true });
  mkdirSync(state, { recursive: true });
  const registry = path.join(directory, "registry.json");
  writeFileSync(registry, JSON.stringify({ version: 1, providers, models }));
  if (selected !== null) writeFileSync(path.join(state, "enabled-providers.json"),
    JSON.stringify({ version: 1, providers: selected }));
  if (generic) writeFileSync(path.join(state, "generic-providers.json"),
    JSON.stringify({ version: 1, providers: generic }));
  if (userModels) writeFileSync(path.join(state, "user-models.json"),
    JSON.stringify({ version: 1, models: userModels }));
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(MODEL_ROUTER_|CODEX_ROUTER_|KIMI_|GROK_|GOOGLE_|GCLOUD_)/.test(name) || /(?:_API_KEY|_TOKEN)$/.test(name)) {
      delete env[name];
    }
  }
  Object.assign(env, {
    HOME: directory, USERPROFILE: directory, APPDATA: path.join(directory, "appdata"),
    LOCALAPPDATA: path.join(directory, "localappdata"), CODEX_HOME: home,
    MODEL_ROUTER_STATE_DIR: state, CODEX_ROUTER_STATE_DIR: state,
    MODEL_ROUTER_REGISTRY: registry, CODEX_ROUTER_NO_DISCOVERY: "1",
  });
  // A synthetic path alone is insufficient if a forgotten alias wins. Assert
  // the roots that the child will use before it can import any state reader.
  for (const name of ["CODEX_HOME", "MODEL_ROUTER_STATE_DIR", "CODEX_ROUTER_STATE_DIR", "MODEL_ROUTER_REGISTRY"]) {
    const relative = path.relative(directory, env[name]);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), name);
  }
  return { directory, env };
}

function requirements(options, args = []) {
  const staged = fixture(options);
  try {
    const result = spawnSync(process.execPath, ["src/runtime-dependency-requirements.mjs", ...args], {
      cwd: root, env: staged.env, encoding: "utf8", timeout: 20_000,
    });
    assert.equal(result.status, 0, result.stderr);
    return args.length ? result.stdout.trim() : JSON.parse(result.stdout);
  } finally {
    rmSync(staged.directory, { recursive: true, force: true });
  }
}

test("native-only selection needs no Python despite other registry providers", () => {
  const providers = [apiProvider("unused-chat")];
  assert.deepEqual(requirements({ providers, models: [model("unused-chat", "a")] }),
    { needsGateway: false, services: [] });
});

test("per-model Responses protocol avoids gateway without credential readiness", () => {
  const custom = { id: "custom", kind: "openai-compatible", displayName: "Custom",
    ownedBy: "fixture", perModelEndpoint: true, authMode: "per-model" };
  const endpoint = { protocol: "openai-responses", baseUrl: "https://fixture.example.test/v1",
    credential: { file: "missing-synthetic-key.secret", environment: ["FIXTURE_UNUSED_KEY"] } };
  const options = { providers: [custom], selected: ["custom"], models: [
    model("custom", "glm-5.3", { endpoint }),
    model("custom", "grok-4.6", { endpoint }),
  ] };
  assert.deepEqual(requirements(options), { needsGateway: false, services: ["api"] });
  assert.equal(requirements(options, ["--gateway-required"]), "unused");
});

test("selected hidden vision Chat route still provisions the gateway", () => {
  const options = { providers: [apiProvider("fixture-responses", "openai-responses"), apiProvider("fixture-chat")],
    selected: ["fixture-responses", "fixture-chat"], models: [
      model("fixture-responses", "main"),
      model("fixture-chat", "vision", { listed: false, inputModalities: ["text", "image"] }),
    ] };
  assert.deepEqual(requirements(options), { needsGateway: true, services: ["api", "gateway"] });
});

test("canonical parent selection includes an Anthropic protocol variant", () => {
  const parent = apiProvider("fixture-family", "openai-responses");
  const variant = { ...apiProvider("fixture-messages", "anthropic"), variantOf: parent.id,
    credential: parent.credential };
  assert.equal(requirements({ providers: [parent, variant], selected: [parent.id],
    models: [model(parent.id, "a"), model(variant.id, "b")] }).needsGateway, true);
});

test("enabled generic Chat routes override empty built-in selection; disabled ones do not", () => {
  const generic = { id: "fixture-generic", displayName: "Fixture", baseUrl: "https://generic.example.test/v1",
    adapter: "openai-chat", enabled: true, allowPrivate: false,
    credentialRef: "cred_fixture_missing_key_001" };
  const options = { generic: [generic], userModels: [model(generic.id, "vision", { listed: false })] };
  assert.equal(requirements(options).needsGateway, true);
  assert.deepEqual(requirements({ ...options, generic: [{ ...generic, enabled: false }] }),
    { needsGateway: false, services: [] });
  assert.deepEqual(requirements({ ...options, generic: [{ ...generic, adapter: "openai-responses" }] }),
    { needsGateway: false, services: ["api"] });
});

test("legacy missing selection retains all requestable gateway dependencies", () => {
  assert.equal(requirements({ selected: null, providers: [apiProvider("fixture-chat")],
    models: [model("fixture-chat", "hidden", { listed: false })] }).needsGateway, true);
});

test("selected OAuth and Ollama routes preserve their gateway requirement", () => {
  const providers = [
    { id: "kimi-oauth", displayName: "Fixture Kimi", ownedBy: "fixture", kind: "oauth", proxyBaseEnv: "FIXTURE_KIMI_PROXY" },
    { id: "ollama", displayName: "Fixture Ollama", ownedBy: "fixture", kind: "openai-compatible", keyless: true,
      transport: "ollama", baseUrl: "http://127.0.0.1:11434/v1" },
  ];
  const models = [model("kimi-oauth", "k"), model("ollama", "o")];
  assert.deepEqual(requirements({ providers, models, selected: providers.map((p) => p.id) }),
    { needsGateway: true, services: ["gateway", "kimi", "ollama"] });
});

test("pending Antigravity proof gets its adoption listener before enablement; gateway queries do not inspect it", () => {
  const provider = { id: "antigravity-oauth", displayName: "Fixture Antigravity", ownedBy: "fixture",
    kind: "oauth", proxyBaseEnv: "FIXTURE_ANTIGRAVITY_PROXY" };
  const staged = fixture({ providers: [provider], selected: [provider.id] });
  try {
    // This is the one credential-discovery fixture: all roots are asserted
    // synthetic above, and the only provider is the synthetic proof below.
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import fs from "node:fs";
      import path from "node:path";
      import {syncBuiltinESMExports} from "node:module";
      import {writePrivateJson} from "./src/file-security.mjs";
      import {runtimeDependencyRequirements} from "./src/runtime-dependency-requirements.mjs";
      const token = path.join(process.env.MODEL_ROUTER_STATE_DIR,"antigravity-oauth.json");
      writePrivateJson(token, {
        version:3,managed_by:"codex-router",session_generation:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        client_id:"operator-owned.apps.googleusercontent.com",client_secret:"synthetic-client-secret",
        access_token:"synthetic-access",refresh_token:"synthetic-refresh",expires_at:2000000000,expires_in:3600,
        project_id:"fixture-project",project_source:"managed",probe_version:1,probe_verified_at:1700000000000,
        probe_model:"gemini-3.1-pro",probe_activation:{version:1,state:"pending_activation",
          generation:"11111111-1111-4111-8111-111111111111"}
      });
      let reads=0;
      for (const method of ["readFileSync","openSync"]) {
        const original=fs[method];
        fs[method]=function(file,...args) {
          if (typeof file==="string" && path.resolve(file)===token) reads++;
          return original.call(this,file,...args);
        };
      }
      syncBuiltinESMExports();
      const selected=runtimeDependencyRequirements();
      const selectedReads=reads;
      fs.writeFileSync(path.join(process.env.MODEL_ROUTER_STATE_DIR,"enabled-providers.json"),
        JSON.stringify({version:1,providers:[]}));
      reads=0;
      const unselected=runtimeDependencyRequirements();
      const unselectedReads=reads;
      reads=0;
      const gatewayOnly=runtimeDependencyRequirements({includePendingActivation:false});
      const gatewayOnlyReads=reads;
      fs.writeFileSync(path.join(process.env.MODEL_ROUTER_STATE_DIR,"antigravity-oauth.json"),
        JSON.stringify({...JSON.parse(fs.readFileSync(token,"utf8")),probe_activation:{version:1,state:"active",
          generation:"11111111-1111-4111-8111-111111111111"}}));
      const ordinaryUnselected=runtimeDependencyRequirements();
      process.stdout.write(JSON.stringify({selected:selected.services,needsGateway:selected.needsGateway,
        selectedReads,unselected:unselected.services,unselectedReads,gatewayOnly:gatewayOnly.services,
        gatewayOnlyReads,ordinaryUnselected:ordinaryUnselected.services}));
    `], { cwd: root, env: { ...staged.env, CODEX_ROUTER_NO_DISCOVERY: "0" }, encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout);
    assert.deepEqual(value.selected, ["antigravity"]);
    assert.equal(value.needsGateway, false);
    assert.ok(value.selectedReads > 0, "selected proof must exercise the credential read positive control");
    assert.deepEqual(value.unselected, ["antigravity"]);
    assert.ok(value.unselectedReads > 0, "pending adoption must inspect the protected proof before enablement");
    assert.deepEqual(value.gatewayOnly, []);
    assert.equal(value.gatewayOnlyReads, 0);
    assert.deepEqual(value.ordinaryUnselected, []);
    const preload = path.join(staged.directory, "credential-read-probe.mjs");
    const readLog = path.join(staged.directory, "credential-reads.log");
    const token = path.join(staged.env.MODEL_ROUTER_STATE_DIR, "antigravity-oauth.json");
    writeFileSync(preload, `
      import fs from "node:fs";
      import path from "node:path";
      import {syncBuiltinESMExports} from "node:module";
      const watched=${JSON.stringify(token)},log=${JSON.stringify(readLog)};
      for(const method of ["readFileSync","openSync"]){
        const original=fs[method];
        fs[method]=function(file,...args){
          if(typeof file==="string"&&path.resolve(file)===watched)fs.appendFileSync(log,"read\\n");
          return original.call(this,file,...args);
        };
      }
      syncBuiltinESMExports();
    `);
    const run = (args) => spawnSync(process.execPath, ["--import", pathToFileURL(preload).href,
      "src/runtime-dependency-requirements.mjs", ...args], {
      cwd: root, env: { ...staged.env, CODEX_ROUTER_NO_DISCOVERY: "0" }, encoding: "utf8", timeout: 20_000,
    });
    const adoption = run([]);
    assert.equal(adoption.status, 0, adoption.stderr);
    assert.ok(existsSync(readLog), "adoption CLI must exercise the credential read detector");
    rmSync(readLog);
    const gateway = run(["--gateway-required"]);
    assert.equal(gateway.status, 0, gateway.stderr);
    assert.equal(gateway.stdout.trim(), "unused");
    assert.equal(existsSync(readLog), false, "gateway-only CLI must not read an unselected OAuth record");
  } finally {
    rmSync(staged.directory, { recursive: true, force: true });
  }
});

function windowsDependencies({ gateway = "unused", pythonStep = "run", force = false,
  mode = "dependencies", serviceExit = 0, healthExit = 0 } = {}) {
  const staged = fixture();
  const checkout = path.join(staged.directory, "checkout");
  const shim = path.join(staged.directory, "shims");
  const calls = path.join(staged.directory, "calls.log");
  try {
    mkdirSync(checkout, { recursive: true });
    mkdirSync(shim, { recursive: true });
    cpSync(path.join(root, "install.ps1"), path.join(checkout, "install.ps1"));
    writeFileSync(path.join(checkout, "package.json"), '{"name":"codex-model-router"}\n');
    for (const client of ["dsh", "gemini", "cursor", "claude", "openclaw"]) {
      writeFileSync(path.join(staged.env.MODEL_ROUTER_STATE_DIR, `${client}-models.json`), "{}\n");
    }
    writeFileSync(path.join(shim, "node.cmd"), [
      "@echo off", 'echo node %*>>"%FIXTURE_CALLS%"',
      'if /I "%~1"=="-p" (echo 24.0.0& exit /b 0)',
      'if /I "%~1"=="src/runtime-dependency-requirements.mjs" (echo %FIXTURE_GATEWAY%& exit /b 0)',
      'if /I "%~1"=="src/install-plan.mjs" if /I "%~2"=="status" (',
      '  if /I "%~3"=="python-deps" (echo %FIXTURE_PYTHON_STEP%& exit /b 0)',
      "  echo skip", "  exit /b 0", ")",
      'if /I "%~1"=="src/service.mjs" if /I "%~2"=="install" exit /b %FIXTURE_SERVICE_EXIT%',
      'if /I "%~1"=="src/wait-health.mjs" exit /b %FIXTURE_HEALTH_EXIT%',
      'if /I "%~2"=="status" echo {"mode":"native","installed":false}',
      "exit /b 0", "",
    ].join("\r\n"));
    for (const tool of ["npm", "uv"]) writeFileSync(path.join(shim, `${tool}.cmd`),
      `@echo off\r\necho ${tool} %*>>"%FIXTURE_CALLS%"\r\nexit /b 0\r\n`);
    const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
      path.join(checkout, "install.ps1"), "-CheckoutInstall",
      ...(mode === "dependencies" ? ["-DependenciesOnly"] : mode === "prepare" ? ["-PrepareOnly"] : []),
      ...(force ? ["-ForceDeps"] : [])], {
      cwd: checkout, encoding: "utf8", timeout: 30_000,
      env: { ...staged.env, PATH: `${shim};${process.env.PATH}`, FIXTURE_CALLS: calls,
        FIXTURE_GATEWAY: gateway, FIXTURE_PYTHON_STEP: pythonStep,
        FIXTURE_SERVICE_EXIT: String(serviceExit), FIXTURE_HEALTH_EXIT: String(healthExit) },
    });
    const invoked = readFileSync(calls, "utf8").replace(/\\/g, "/");
    return { result, invoked };
  } finally {
    rmSync(staged.directory, { recursive: true, force: true });
  }
}

test("Windows dependencies-only Responses install performs no Python or state work", {
  skip: process.platform !== "win32",
}, () => {
  const { result, invoked } = windowsDependencies();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(invoked, /runtime-dependency-requirements\.mjs --gateway-required/);
  assert.doesNotMatch(invoked, /python-deps|venv-home|uv |provider-selection|secret|catalog|service|config-manager|install-manifest/);
});

test("Windows gateway preparation keeps hash-verified LiteLLM installation", {
  skip: process.platform !== "win32",
}, () => {
  const { result, invoked } = windowsDependencies({ gateway: "required" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(invoked, /status python-deps/);
  assert.match(invoked, /uv pip install --python .* --require-hashes -r requirements\/python\.txt/);
  assert.match(invoked, /record python-deps/);
  assert.doesNotMatch(invoked, /provider-selection|secret|catalog|service|config-manager|install-manifest/);
});

test("Windows explicit repair rebuilds both trees even for Responses-only routes", {
  skip: process.platform !== "win32",
}, () => {
  const { result, invoked } = windowsDependencies({ force: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(invoked, /npm ci --omit=dev/);
  assert.match(invoked, /uv pip install .*--require-hashes/);
  assert.doesNotMatch(invoked, /runtime-dependency-requirements/);
});

test("Windows malformed dependency query fails before provisioning or publication", {
  skip: process.platform !== "win32",
}, () => {
  const { result, invoked } = windowsDependencies({ gateway: "unexpected" });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(invoked, /python-deps|uv |catalog|service|config-manager/);
});

test("Windows PrepareOnly never publishes companion routes or catalog", { skip: process.platform !== "win32" }, () => {
  const { result, invoked } = windowsDependencies({ mode: "prepare" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.doesNotMatch(invoked, /catalog\.mjs|config-manager\.mjs (?:enable|install)|service\.mjs install/);
});

test("Windows full install adopts a healthy service before every client publication", { skip: process.platform !== "win32" }, () => {
  const { result, invoked } = windowsDependencies({ mode: "full" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const health = invoked.indexOf("src/wait-health.mjs");
  assert.ok(invoked.indexOf("install-manifest.mjs record") < invoked.indexOf("service.mjs install"));
  for (const marker of ["catalog.mjs", "dsh-config-manager.mjs install", "gemini-config-manager.mjs install",
    "cursor-config-manager.mjs install", "claude-code-config-manager.mjs install",
    "openclaw-config-manager.mjs install", "config-manager.mjs enable"]) {
    assert.ok(health !== -1 && invoked.indexOf(marker) > health, `not published after readiness: ${marker}`);
  }
});

for (const [failure, options] of [["service installation", { serviceExit: 17 }], ["readiness", { healthExit: 18 }],
  ["cold-start timeout", { serviceExit: 75 }]]) {
  test(`Windows full install does not publish clients after failed ${failure}`, { skip: process.platform !== "win32" }, () => {
    const { result, invoked } = windowsDependencies({ mode: "full", ...options });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(invoked, /catalog\.mjs|config-manager\.mjs (?:enable|install)/);
    if (options.serviceExit === 75) assert.doesNotMatch(invoked, /service\.mjs uninstall/);
  });
}

test("POSIX dependencies-only exits before state writers and preserves gateway hash commands", () => {
  const source = readFileSync(path.join(root, "bin", "install"), "utf8");
  assert.ok(source.indexOf('if [ "$dependencies_only" = true ]; then\n  echo "Runtime dependencies') <
    source.indexOf("node src/secret.mjs ensure"));
  assert.match(source, /if \[ "\$gateway_required" = unused \]; then[\s\S]*else\s*case "\$\(install_step python-deps\)"/);
  assert.match(source, /uv pip install --python \.venv\/bin\/python --require-hashes -r requirements\/python\.txt/);
  assert.match(source, /\.venv\/bin\/python -m pip install --require-hashes -r requirements\/python\.txt/);
});

function posixShell() {
  if (spawnSync("sh", ["-c", "exit 0"], { stdio: "ignore" }).status === 0) return "sh";
  if (process.platform !== "win32") return null;
  const git = spawnSync("git", ["--exec-path"], { encoding: "utf8" });
  if (git.status !== 0) return null;
  const bundled = path.resolve(git.stdout.trim(), "../../..", "bin", "sh.exe");
  return existsSync(bundled) ? bundled : null;
}

const shell = posixShell();

function enableFixture({ existing = false, serviceExit = 0, publicationExit = 0, healthExit = 0,
  entry = "enable", args = [] } = {}) {
  const staged = fixture();
  const checkout = path.join(staged.directory, "checkout");
  const runtime = path.join(staged.directory, "runtime");
  const calls = path.join(staged.directory, "calls.log");
  try {
    mkdirSync(path.join(checkout, "bin"), { recursive: true });
    mkdirSync(runtime, { recursive: true });
    for (const script of ["enable", "install"]) cpSync(path.join(root, "bin", script), path.join(checkout, "bin", script));
    for (const client of ["dsh", "gemini", "cursor", "claude", "openclaw"]) {
      writeFileSync(path.join(staged.env.MODEL_ROUTER_STATE_DIR, `${client}-models.json`), "{}\n");
    }
    writeFileSync(path.join(runtime, "node"), `#!/bin/sh
printf '%s\\n' "$*" >>"$FIXTURE_CALLS"
case "\${1:-}" in
  src/install-plan.mjs) [ "\${2:-}" = status ] && printf 'skip\\n'; exit 0 ;;
  src/runtime-dependency-requirements.mjs) printf 'unused\\n'; exit 0 ;;
  src/wait-health.mjs) exit "$FIXTURE_HEALTH_EXIT" ;;
  src/service.mjs)
    case "\${2:-}" in
      status) printf '{"installed": %s}\\n' "$FIXTURE_EXISTING" ;;
      install) exit "$FIXTURE_SERVICE_EXIT" ;;
    esac ;;
  src/config-manager.mjs)
    case "\${2:-}" in
      status) [ "$FIXTURE_EXISTING" = true ] && printf '{"mode": "router"}\\n' || printf '{"mode": "native"}\\n' ;;
      enable) exit "$FIXTURE_PUBLICATION_EXIT" ;;
    esac ;;
esac
exit 0
`, { mode: 0o755 });
    writeFileSync(path.join(runtime, "npm"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(path.join(runtime, "uname"), "#!/bin/sh\nprintf 'Linux\\n'\n", { mode: 0o755 });
    const unixPath = (value) => process.platform === "win32"
      ? value.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_match, letter) => `/${letter.toLowerCase()}`)
      : value;
    const result = spawnSync(shell, ["-c", 'PATH="$FIXTURE_RUNTIME:/usr/bin:/bin"; export PATH; exec "$FIXTURE_ENTRY" "$@"', "fixture", ...args], {
      cwd: checkout, encoding: "utf8", timeout: 30_000,
      env: { ...staged.env, PATH: `${unixPath(runtime)}:/usr/bin:/bin`, MODEL_ROUTER_TARGET: "codex",
        FIXTURE_CALLS: unixPath(calls), FIXTURE_EXISTING: String(existing), FIXTURE_SERVICE_EXIT: String(serviceExit),
        FIXTURE_PUBLICATION_EXIT: String(publicationExit), FIXTURE_HEALTH_EXIT: String(healthExit),
        FIXTURE_RUNTIME: unixPath(runtime), FIXTURE_ENTRY: unixPath(path.join(checkout, "bin", entry)) },
    });
    return { result, invoked: existsSync(calls) ? readFileSync(calls, "utf8") : "" };
  } finally {
    rmSync(staged.directory, { recursive: true, force: true });
  }
}

test("enable prepares dependencies and reaches readiness before publishing routes", { skip: !shell }, () => {
  const { result, invoked } = enableFixture();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.ok(invoked.indexOf("provider-selection.mjs ensure-configured") < invoked.indexOf("install-plan.mjs status node-deps"));
  assert.ok(invoked.indexOf("install-plan.mjs status node-deps") < invoked.indexOf("service.mjs install"));
  assert.ok(invoked.indexOf("wait-health.mjs") < invoked.indexOf("catalog.mjs"));
  assert.ok(invoked.indexOf("wait-health.mjs") < invoked.indexOf("config-manager.mjs enable"));
  assert.doesNotMatch(invoked, /python-deps|litellm-config/);
});

test("failed enable preparation preserves pre-existing service and client config", { skip: !shell }, () => {
  const { result, invoked } = enableFixture({ existing: true, serviceExit: 17 });
  assert.equal(result.status, 17, `${result.stdout}\n${result.stderr}`);
  assert.doesNotMatch(invoked, /catalog\.mjs|config-manager\.mjs (?:enable|disable)|service\.mjs uninstall/);
});

test("failed first enable removes only the service it just created", { skip: !shell }, () => {
  const { result, invoked } = enableFixture({ serviceExit: 17 });
  assert.equal(result.status, 17);
  assert.match(invoked, /service\.mjs uninstall/);
  assert.doesNotMatch(invoked, /config-manager\.mjs (?:enable|disable)|catalog\.mjs/);
});

test("failed publication does not disable an existing client or uninstall its service", { skip: !shell }, () => {
  const { result, invoked } = enableFixture({ existing: true, publicationExit: 18 });
  assert.equal(result.status, 18);
  assert.doesNotMatch(invoked, /config-manager\.mjs disable|service\.mjs uninstall/);
});

test("enable readiness timeout preserves its starting service without publishing", { skip: !shell }, () => {
  const { result, invoked } = enableFixture({ serviceExit: 75 });
  assert.equal(result.status, 75);
  assert.doesNotMatch(invoked, /catalog\.mjs|config-manager\.mjs (?:enable|disable)|service\.mjs uninstall/);
});

test("POSIX PrepareOnly never publishes companion routes or catalog", { skip: !shell }, () => {
  const { result, invoked } = enableFixture({ entry: "install", args: ["--prepare-only"] });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.doesNotMatch(invoked, /catalog\.mjs|config-manager\.mjs (?:enable|install)|service\.mjs install/);
});

test("POSIX full install adopts a healthy service before every client publication", { skip: !shell }, () => {
  const { result, invoked } = enableFixture({ entry: "install" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const health = invoked.indexOf("src/wait-health.mjs");
  assert.ok(invoked.indexOf("install-manifest.mjs record") < invoked.indexOf("service.mjs install"));
  for (const marker of ["catalog.mjs", "dsh-config-manager.mjs install", "gemini-config-manager.mjs install",
    "cursor-config-manager.mjs install", "claude-code-config-manager.mjs install",
    "openclaw-config-manager.mjs install", "config-manager.mjs enable"]) {
    assert.ok(health !== -1 && invoked.indexOf(marker) > health, `not published after readiness: ${marker}`);
  }
});

for (const [failure, options] of [["service installation", { serviceExit: 17 }], ["readiness", { healthExit: 18 }],
  ["cold-start timeout", { serviceExit: 75 }]]) {
  test(`POSIX full install does not publish clients after failed ${failure}`, { skip: !shell }, () => {
    const { result, invoked } = enableFixture({ entry: "install", ...options });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(invoked, /catalog\.mjs|config-manager\.mjs (?:enable|install)/);
    if (options.serviceExit === 75) assert.doesNotMatch(invoked, /service\.mjs uninstall/);
  });
}
