import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn,spawnSync} from 'node:child_process';
import {chmodSync,existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import { freePort } from './port-pool.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// This is an outer process guard, including Node's cold module imports. The
// combined lifecycle suite exceeded 5s before reaching an immediate fake
// interpreter failure; allow that scheduling pressure without changing the
// production probe limits or any exit/message/cache assertion.
const CHILD_TIMEOUT_MS = 30_000;
// The fixture has no provider credentials, but Windows child processes still
// need their runtime environment to start PowerShell and load system modules.
// Match the public runtime allowlist used by the private-file ACL helper.
function startupChildRuntimeEnvironment(environment = process.env) {
  const allowed = new Set([
    'PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP',
    'PSModulePath', 'SystemDrive', 'ProgramData', 'ProgramFiles',
    'ProgramFiles(x86)', 'ProgramW6432', 'USERPROFILE',
  ].map(name => name.toLowerCase()));
  return Object.fromEntries(Object.entries(environment).filter(([name, value]) =>
    allowed.has(name.toLowerCase()) && typeof value === 'string'));
}
function state(t) {
  const directory=mkdtempSync(path.join(os.tmpdir(), 'startup-contract-'));
  const stateDir=path.join(directory,'state');
  mkdirSync(stateDir,{mode:0o700});
  const userDir = path.join(directory, 'user');
  const homeDir = path.join(directory, 'codex-home');
  for (const folder of [userDir, homeDir, path.join(userDir, 'AppData', 'Roaming'), path.join(userDir, 'AppData', 'Local')]) {
    mkdirSync(folder, {recursive: true, mode: 0o700});
  }
  const registryFile = path.join(directory, 'registry.json');
  writeFileSync(registryFile, JSON.stringify({version: 1, providers: [{id: 'custom', displayName: 'Fixture custom',
    kind: 'openai-compatible', ownedBy: 'fixture', perModelEndpoint: true, authMode: 'per-model'}],
    models: [{slug: 'custom/gateway-fixture', gatewayModel: 'gateway-fixture', upstreamModel: 'gateway-fixture',
      provider: 'custom', listed: false, endpoint: {protocol: 'openai', keyless: true,
        baseUrl: 'http://127.0.0.1:9999/v1'}}]}));
  writeFileSync(path.join(stateDir, 'enabled-providers.json'), JSON.stringify({version: 1, providers: ['custom']}));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const env={
    ...startupChildRuntimeEnvironment(),
    TMPDIR:os.tmpdir(),
    HOME:userDir, USERPROFILE:userDir, CODEX_HOME:homeDir,
    APPDATA:path.join(userDir,'AppData','Roaming'), LOCALAPPDATA:path.join(userDir,'AppData','Local'),
    KIMI_CODE_HOME:path.join(directory,'kimi-home'),
    MODEL_ROUTER_TARGET:'codex',
    MODEL_ROUTER_STATE_DIR:stateDir,
    CODEX_ROUTER_STATE_DIR:stateDir,
    MODEL_ROUTER_REGISTRY:registryFile,
    MODEL_ROUTER_USER_MODELS:path.join(stateDir,'user-models.json'),
    MODEL_ROUTER_GENERIC_PROVIDERS:path.join(stateDir,'generic-providers.json'),
    CODEX_ROUTER_NO_DISCOVERY:'1', NO_DISCOVERY:'1',
    MODEL_ROUTER_SHOW_ALL_MODELS:'0', CODEX_ROUTER_SHOW_ALL_MODELS:'0',
    CODEX_ROUTER_SERVICE_PLATFORM:'test-fixture',
    MODEL_ROUTER_LITELLM_BIN:path.join(directory,'missing-litellm'),
    MODEL_ROUTER_QUIET:'1',
  };
  const record=path.join(stateDir,'startup-attempts.json');
  return {directory,stateDir,env,record};
}
function seed(record) {
  writeFileSync(record,JSON.stringify({version:1,consecutiveFailures:3,lastFailureAt:Date.now(),nextAttemptNotBefore:Date.now()+600000}),{mode:0o600});
}
function run(entry,env,timeout=CHILD_TIMEOUT_MS) {
  const result=spawnSync(process.execPath,[path.join(root,'src',entry)],{env,cwd:root,encoding:'utf8',timeout});
  assert.ifError(result.error);
  return {status:result.status,output:`${result.stdout||''}${result.stderr||''}`};
}

// This unlisted registry fixture is still an explicitly selected Chat route:
// listing controls the picker, not its actual gateway execution dependency.
// Ask the real registry/plan boundary instead of inferring that from the name.
function gatewayPlan(env) {
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import { MODELS, RUNTIME_PROVIDERS, providerForModel } from './src/model-registry.mjs';
    import { createExecutionPlan } from './src/route-execution-plan.mjs';
    import { readProviderSelection } from './src/provider-selection.mjs';
    const selected = new Set(readProviderSelection());
    console.log(JSON.stringify(createExecutionPlan({ models: MODELS, providerForModel,
      routeEnabled: model => RUNTIME_PROVIDERS.get(model.provider)?.generic === true || selected.has(model.provider) })));
  `], { env, cwd: root, encoding: 'utf8', timeout: CHILD_TIMEOUT_MS });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

async function runDegradedSupervisor(fixture, { entry = 'start.mjs', env = fixture.env,
  gatewayError = /dependency unavailable: LiteLLM gateway exited before becoming healthy/ } = {}) {
  const ports = await Promise.all(Array.from({ length: 7 }, () => freePort()));
  assert.equal(new Set(ports).size, ports.length);
  const [router, gateway, oauth, api, grok, antigravity, devin] = ports;
  writeFileSync(path.join(fixture.stateDir, 'internal-secret'), 'foreground-synthetic-internal-key\n', { mode: 0o600 });
  writeFileSync(path.join(fixture.stateDir, 'caller-secret'), 'foreground-synthetic-caller-key-with-sufficient-length\n', { mode: 0o600 });
  const child = spawn(process.execPath, [path.join(root, 'src', entry)], {
    cwd: root,
    env: {
      ...env,
      MODEL_ROUTER_PORT: String(router), MODEL_ROUTER_GATEWAY_PORT: String(gateway),
      MODEL_ROUTER_OAUTH_PORT: String(oauth), MODEL_ROUTER_API_PORT: String(api), MODEL_ROUTER_GROK_OAUTH_PORT: String(grok),
      MODEL_ROUTER_ANTIGRAVITY_OAUTH_PORT: String(antigravity), MODEL_ROUTER_DEVIN_CLI_PORT: String(devin),
      CODEX_NATIVE_BASE_URL: 'http://127.0.0.1:9/unused-native', MODEL_ROUTER_NATIVE_TRANSPORT: 'http',
      CODEX_ROUTER_GATEWAY_RESTARTS: '0', CODEX_ROUTER_STARTUP_HEALTH_TIMEOUT_MS: '2000',
      MODEL_ROUTER_SHUTDOWN_DRAIN_MS: '100', MODEL_ROUTER_SHUTDOWN_FLUSH_MS: '100', NODE_USE_ENV_PROXY: '0',
    },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
  });
  let output = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { output += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  let timer;
  try {
    const deadline = Date.now() + CHILD_TIMEOUT_MS;
    while (!/serving independent routes/.test(output) && Date.now() < deadline) {
      assert.equal(child.exitCode, null, output);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.match(output, /serving independent routes/);
    assert.match(output, gatewayError);
    assert.equal((await fetch(`http://127.0.0.1:${router}/health/live`)).status, 200);
    const healthResponse = await fetch(`http://127.0.0.1:${router}/health`);
    assert.equal(healthResponse.status, 503);
    const health = await healthResponse.json();
    assert.equal(health.executionPlan.needsGateway, true);
    assert.deepEqual(health.executionPlan.services, ['api', 'gateway']);
    assert.ok(health.degraded.includes('gateway'), JSON.stringify(health));
    assert.doesNotMatch(output, /backing off|foreground-synthetic-(?:internal|caller)-key/);
    return output;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.send({ type: 'model-router:shutdown' });
    try {
      const result = await Promise.race([exited, new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`supervisor IPC shutdown did not finish: ${output}`)), 15_000);
      })]);
      assert.equal(result.signal, null, output);
      assert.equal(result.code, 0, output);
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.connected) child.disconnect();
    }
  }
}

test('isolated startup children keep Windows runtime variables without inheriting credentials', () => {
  const environment = startupChildRuntimeEnvironment({
    PATH: 'fixture-bin', sYsTeMrOoT: 'C:\\Windows', ComSpec: 'fixture-cmd.exe',
    PSModulePath: 'fixture-modules', PATHEXT: '.EXE;.CMD', TEMP: 'fixture-temp',
    OPENAI_API_KEY: 'unrelated-provider-secret', CODEX_ROUTER_CALLER_KEY: 'unrelated-caller-secret',
    MODEL_ROUTER_STATE_DIR: 'unrelated-installed-state',
  });
  assert.equal(environment.sYsTeMrOoT, 'C:\\Windows');
  assert.equal(environment.ComSpec, 'fixture-cmd.exe');
  assert.equal(environment.PSModulePath, 'fixture-modules');
  assert.equal(environment.PATHEXT, '.EXE;.CMD');
  assert.equal(environment.TEMP, 'fixture-temp');
  assert.equal(environment.PATH, 'fixture-bin');
  assert.equal(Object.hasOwn(environment, 'OPENAI_API_KEY'), false);
  assert.equal(Object.hasOwn(environment, 'CODEX_ROUTER_CALLER_KEY'), false);
  assert.equal(Object.hasOwn(environment, 'MODEL_ROUTER_STATE_DIR'), false);
});

test('automatic payload still skips an active cooldown before launcher checks',t=>{
  const fixture=state(t);seed(fixture.record);
  const result=run('start.mjs',fixture.env);
  assert.equal(result.status,69,result.output);
  assert.match(result.output,/backing off/);
  assert.doesNotMatch(result.output,/LiteLLM is not installed/);
});

test('explicit foreground startup bypasses the automatic cooldown',t=>{
  const fixture=state(t);seed(fixture.record);
  const result=run('foreground-start.mjs',fixture.env);
  assert.notEqual(result.status,69,'explicit foreground start was refused by automatic cooldown: '+result.output);
  assert.match(result.output,/Internal service key is missing/);
  assert.equal(JSON.parse(readFileSync(fixture.record,'utf8')).consecutiveFailures,3);
});

test('direct kill switch bypasses cooldown and reveals a missing service capability',t=>{
  const fixture=state(t);seed(fixture.record);
  const result=run('start.mjs',{...fixture.env,CODEX_ROUTER_DISABLE_STARTUP_BACKOFF:'1'});
  assert.equal(result.status,1,result.output);
  assert.match(result.output,/Internal service key is missing/);
  assert.doesNotMatch(result.output,/backing off/);
});

test('a missing service capability fails fast without creating cooldown when the gateway is unavailable',t=>{
  const fixture=state(t);
  const result=run('start.mjs',fixture.env);
  assert.equal(result.status,1,result.output);
  assert.match(result.output,/Internal service key is missing/);
  assert.equal(existsSync(fixture.record),false);
});

test('the startup fixture explicitly selects a Chat route and its actual gateway dependency', t => {
  const fixture = state(t);
  const plan = gatewayPlan(fixture.env);
  assert.equal(plan.needsGateway, true);
  assert.deepEqual(plan.services, ['api', 'gateway']);
});

test('bundled venv setup diagnostics remain visible on degraded startup without seeding cooldown',{skip:process.platform==='win32'},async t=>{
  const fixture=state(t);
  const source=path.join(fixture.directory,'source');
  const bin=path.join(source,'.venv','bin');mkdirSync(bin,{recursive:true});
  symlinkSync(path.join(root,'config'),path.join(source,'config'),'dir');
  symlinkSync(path.join(root,'src'),path.join(source,'src'),'dir');
  writeFileSync(path.join(bin,'litellm'),'placeholder\n',{mode:0o755});
  writeFileSync(path.join(bin,'python'),"#!/bin/sh\nprintf 'ModuleNotFoundError: encodings\\n' >&2\nexit 1\n",{mode:0o755});
  const env={...fixture.env,CODEX_ROUTER_SOURCE_ROOT:source};delete env.MODEL_ROUTER_LITELLM_BIN;
  assert.equal(gatewayPlan(env).needsGateway, true);
  // Credentials are a fatal preflight. A deferred gateway startup diagnostic
  // does not replace that error, and this early exit must not seed cooldown.
  const result=run('start.mjs',env);
  assert.equal(result.status,1,result.output);
  assert.match(result.output,/Internal service key is missing/);
  assert.equal(existsSync(fixture.record),false);
  // With complete synthetic capabilities, execute the real service boundary
  // and observe the selected gateway's concrete degraded diagnostic and health.
  const output = await runDegradedSupervisor(fixture, { env, gatewayError: /gateway unavailable: The LiteLLM virtual environment is broken/ });
  assert.match(output, /exited with code 1/);
  assert.doesNotMatch(output, /Internal service key is missing/);
  assert.equal(existsSync(fixture.record), false);
});

// The fresh main already exposes bounded startup timeout overrides. This
// diagnostic uses those existing overrides only to keep a real pending probe
// deterministic and short; it does not alter the reviewed source or945 work.
test('transient bundled venv timeouts continue to the credential preflight without cooldown',{skip:process.platform==='win32'},t=>{
  const fixture=state(t);
  const source=path.join(fixture.directory,'source');
  const bin=path.join(source,'.venv','bin');mkdirSync(bin,{recursive:true});
  symlinkSync(path.join(root,'config'),path.join(source,'config'),'dir');
  writeFileSync(path.join(bin,'litellm'),'placeholder\n',{mode:0o755});
  // Only shell builtins: no orphanable grandchildren on the spawn timeout.
  writeFileSync(path.join(bin,'python'),"#!/bin/sh\ntrap 'exit 0' TERM\nwhile :; do :; done\n",{mode:0o755});
  const env={...fixture.env,CODEX_ROUTER_SOURCE_ROOT:source,CODEX_ROUTER_VENV_PROBE_TIMEOUT_MS:'30',CODEX_ROUTER_VENV_PROBE_RETRY_TIMEOUT_MS:'30'};
  delete env.MODEL_ROUTER_LITELLM_BIN;
  const result=run('start.mjs',env);
  assert.equal(result.status,1,result.output);
  assert.match(result.output,/transient process scheduling pressure is possible/);
  assert.match(result.output,/Internal service key is missing/);
  assert.equal(existsSync(fixture.record),false,'an inconclusive probe must not seed cooldown');
});


test('foreground and disabled final venv timeouts leave managed state untouched',{skip:process.platform==='win32'},t=>{
  for (const [entry,disabled] of [['foreground-start.mjs',false],['start.mjs',true]]) {
    const fixture=state(t);
    const source=path.join(fixture.directory,'source');
    const bin=path.join(source,'.venv','bin');mkdirSync(bin,{recursive:true});
    symlinkSync(path.join(root,'config'),path.join(source,'config'),'dir');
    writeFileSync(path.join(bin,'litellm'),'placeholder\n',{mode:0o755});
    writeFileSync(path.join(bin,'python'),"#!/bin/sh\ntrap 'exit 0' TERM\nwhile :; do :; done\n",{mode:0o755});
    seed(fixture.record);
    const original=readFileSync(fixture.record,'utf8');
    const env={...fixture.env,CODEX_ROUTER_SOURCE_ROOT:source,CODEX_ROUTER_VENV_PROBE_TIMEOUT_MS:'30',CODEX_ROUTER_VENV_PROBE_RETRY_TIMEOUT_MS:'30'};
    delete env.MODEL_ROUTER_LITELLM_BIN;
    if (disabled) env.CODEX_ROUTER_DISABLE_STARTUP_BACKOFF='1';
    const result=run(entry,env);
    assert.equal(result.status,1,result.output);
    assert.match(result.output,/transient process scheduling pressure is possible/);
    assert.equal(readFileSync(fixture.record,'utf8'),original);
  }
});

test('a missing internal credential is fatal and never seeds cooldown',t=>{
  const fixture=state(t);
  const result=run('start.mjs',{...fixture.env,MODEL_ROUTER_LITELLM_BIN:process.execPath});
  assert.equal(result.status,1,result.output);
  assert.match(result.output,/Internal service key is missing/);
  assert.equal(existsSync(fixture.record),false);
});

test('the real foreground supervisor reaches its children without changing an active managed cooldown', { timeout: 120_000 }, async t => {
  const fixture = state(t);
  seed(fixture.record);
  const original = readFileSync(fixture.record, 'utf8');
  await runDegradedSupervisor(fixture, { entry: 'foreground-start.mjs',
    env: { ...fixture.env, MODEL_ROUTER_LITELLM_BIN: process.execPath } });
  assert.equal(readFileSync(fixture.record, 'utf8'), original);
});
