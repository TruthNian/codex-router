import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { terminateProcessTree } from "../src/process-tree.mjs";
import { freePort } from "./port-pool.mjs";
import { WebSocket } from "undici";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const caller = "compatibility-fixture-caller-with-sufficient-length";

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "compatibility-layer-"));
  const state = path.join(directory, "state");
  const home = path.join(directory, "home");
  mkdirSync(state); mkdirSync(home);
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(MODEL_ROUTER_|CODEX_ROUTER_|KIMI_|GROK_|GOOGLE_|GCLOUD_)/.test(key) || /(?:_API_KEY|_TOKEN)$/.test(key)) delete env[key];
  }
  Object.assign(env, { HOME: home, USERPROFILE: home, CODEX_HOME: home,
    APPDATA: path.join(home, "appdata"), LOCALAPPDATA: path.join(home, "localappdata"),
    MODEL_ROUTER_STATE_DIR: state, CODEX_ROUTER_STATE_DIR: state,
    MODEL_ROUTER_REGISTRY: path.join(directory, "registry.json") });
  const provider = { id: "custom", displayName: "Fixture", ownedBy: "fixture",
    kind: "openai-compatible", authMode: "per-model", perModelEndpoint: true };
  const models = ["glm", "grok", "chat"].map((id) => ({
    slug: `custom/${id}`, gatewayModel: `custom-${id}`, upstreamModel: id,
    provider: "custom", listed: true, displayName: id, description: "Synthetic fixture model", contextWindow: 128000,
    autoCompact: 110000, priority: 1, defaultEffort: "medium",
    reasoningLevels: [{ effort: "medium", description: "Fixture" }],
    inputModalities: ["text"], compHash: `fixture-${id}`,
    endpoint: { protocol: id === "chat" ? "openai" : "openai-responses",
      baseUrl: "https://fixture.example.test/v1", credential: { file: "fixture.secret", environment: ["FIXTURE_COMPAT_KEY"] } },
  }));
  const writeRegistry = () => writeFileSync(env.MODEL_ROUTER_REGISTRY,
    JSON.stringify({ version: 1, providers: [provider], models }));
  writeRegistry();
  writeFileSync(path.join(state, "enabled-providers.json"), JSON.stringify({ version: 1, providers: ["custom"] }));
  return { directory, state, env, models, writeRegistry, policy: path.join(state, "compatibility-layer.json") };
}

function node(f, args) {
  const result = spawnSync(process.execPath, args, { cwd: root, env: f.env, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function settings(f) { return node(f, ["src/compatibility-layer-state.mjs", "status"]); }
function registry(f) {
  return node(f, ["--input-type=module", "-e", `
    import { MODELS, COMPATIBILITY_DISABLED_MODELS } from './src/model-registry.mjs';
    import { runtimeDependencyRequirements } from './src/runtime-dependency-requirements.mjs';
    console.log(JSON.stringify({ models: MODELS, blocked: [...COMPATIBILITY_DISABLED_MODELS.keys()],
      plan: runtimeDependencyRequirements({includePendingActivation:false}) }));`]);
}

test("compatibility policy preserves the legacy default and fails closed on invalid or unreadable state", () => {
  const f = fixture();
  try {
    assert.equal(settings(f).enabled, true);
    assert.equal(settings(f).configured, false);
    for (const invalid of ["{", '{"version":2,"enabled":true}', '{"version":1,"enabled":"false"}']) {
      writeFileSync(f.policy, invalid);
      assert.equal(settings(f).enabled, false);
      assert.equal(settings(f).invalid, true);
    }
    rmSync(f.policy); mkdirSync(f.policy);
    assert.equal(settings(f).enabled, false);
    rmSync(f.policy, { recursive: true });
    writeFileSync(f.policy, '\uFEFF{"version":1,"enabled":true}');
    assert.equal(settings(f).enabled, true);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("CLI persists off across fresh processes without changing model identities or credential references", () => {
  const f = fixture();
  try {
    const original = readFileSync(f.env.MODEL_ROUTER_REGISTRY, "utf8");
    const before = registry(f);
    assert.equal(before.plan.needsGateway, true);
    const changed = node(f, ["src/compatibility-layer-state.mjs", "off"]);
    assert.equal(changed.enabled, false);
    assert.equal(changed.restartRequired, true);
    const after = registry(f);
    assert.deepEqual(after.plan.services, ["api"]);
    assert.deepEqual(after.models, before.models.filter(m => m.endpoint.protocol === "openai-responses"));
    assert.deepEqual(after.blocked, ["custom/chat", "custom-chat"]);
    assert.equal(readFileSync(f.env.MODEL_ROUTER_REGISTRY, "utf8"), original);
    assert.deepEqual(JSON.parse(readFileSync(f.policy, "utf8")), { version: 1, enabled: false });
    node(f, ["src/compatibility-layer-state.mjs", "on"]);
    assert.deepEqual(registry(f).models, before.models);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("readiness refuses a healthy process which has not adopted the persisted policy", () => {
  const f = fixture();
  try {
    writeFileSync(f.policy, '{"version":1,"enabled":false}');
    const run = (enabled) => node(f, ["--input-type=module", "-e", `
      import { waitForRouterHealth } from './src/router-health.mjs';
      const result=await waitForRouterHealth({timeoutMs:1,fetchImpl:async()=>new Response(
        JSON.stringify({service:'codex-router',ok:true,${enabled === undefined ? "" : `compatibilityLayer:{enabled:${enabled}},`}}),{status:200})});
      console.log(JSON.stringify(result));`]);
    assert.equal(run(undefined).ok, false);
    assert.equal(run(true).ok, false);
    assert.match(run(true).error, /policy changed/);
    assert.equal(run(false).ok, true);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("updates and rollback refuse revisions which cannot preserve the explicit opt-out", () => {
  const f = fixture();
  try {
    const repo = path.join(f.directory, "git"); mkdirSync(repo);
    const git = (...args) => {
      const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", timeout: 20_000 });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git("init"); writeFileSync(path.join(repo, "README"), "fixture"); git("add", ".");
    const commit = () => git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture");
    commit(); const old = git("rev-parse", "HEAD");
    mkdirSync(path.join(repo, "src"));
    writeFileSync(path.join(repo, "src/compatibility-layer-state.mjs"), "// support marker\n");
    git("add", "."); commit(); const current = git("rev-parse", "HEAD");
    writeFileSync(f.policy, '{"version":1,"enabled":false}');
    f.env.CODEX_ROUTER_SOURCE_ROOT = repo;
    const result = node(f, ["--input-type=module", "-e", `
      import { requireCompatibilityPolicySupport } from './src/update.mjs';
      let rejected=false;
      try { requireCompatibilityPolicySupport('${old}'); } catch(e) { rejected=/cannot honor/.test(e.message); }
      requireCompatibilityPolicySupport('${current}');
      console.log(JSON.stringify({rejected}));`]);
    assert.equal(result.rejected, true);
    assert.equal(git("rev-parse", "HEAD"), current);
    assert.deepEqual(JSON.parse(readFileSync(f.policy, "utf8")), { version: 1, enabled: false });
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("a real core stack boots without a gateway and rejects disabled requests before any upstream delivery", { timeout: 120_000 }, async () => {
  const f = fixture();
  let child, stderr = "";
  const delivered = [];
  const payloads = [];
  const upstream = http.createServer(async (req, res) => {
    let text = ""; for await (const chunk of req) text += chunk;
    const payload = JSON.parse(text || "{}"); delivered.push(payload.model); payloads.push(payload);
    const summaryRequest = JSON.stringify(payload.input).includes("Return exactly one JSON object");
    const answer = summaryRequest ? JSON.stringify({ objective: "Continue fixture", requirement_refs: ["U001"],
      attempt_refs: [], observation_refs: [], unverified: [], unknowns: [], blockers: [], next_step: "Verify fixture" }) : "fixture ok";
    const result = {
      id: "resp_fixture", object: "response", status: "completed", model: payload.model,
      output: [{ type: "message", id: "msg_fixture", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: answer }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    };
    if (payload.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const event of [
        { type: "response.created", response: { ...result, status: "in_progress", output: [] } },
        { type: "response.output_item.added", output_index: 0, item: { ...result.output[0], content: [] } },
        { type: "response.content_part.added", output_index: 0, content_index: 0, item_id: "msg_fixture", part: { type: "output_text", text: "" } },
        { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg_fixture", delta: "fixture ok" },
        { type: "response.output_text.done", output_index: 0, content_index: 0, item_id: "msg_fixture", text: "fixture ok" },
        { type: "response.output_item.done", output_index: 0, item: result.output[0] },
        { type: "response.completed", response: result },
      ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    } else res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
  });
  try {
    await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;
    const ports = await Promise.all(Array.from({ length: 6 }, () => freePort()));
    const [routerPort, apiPort, gatewayPort, oauthPort, grokPort, antigravityPort] = ports;
    for (const model of f.models) model.endpoint.baseUrl = `${upstreamBase}/v1`;
    f.writeRegistry();
    writeFileSync(f.policy, '{"version":1,"enabled":false}');
    writeFileSync(path.join(f.state, "caller-secret"), caller);
    writeFileSync(path.join(f.state, "internal-secret"), "compatibility-internal-fixture-with-sufficient-length");
    writeFileSync(path.join(f.state, "merged-models.json"), JSON.stringify({ models: [
      { slug: "gpt-fixture", display_name: "Fixture", visibility: "list" },
      { slug: "custom/chat", display_name: "Stale disabled model", visibility: "list" },
    ] }));
    Object.assign(f.env, { MODEL_ROUTER_PORT: String(routerPort), MODEL_ROUTER_API_PORT: String(apiPort),
      MODEL_ROUTER_GATEWAY_PORT: String(gatewayPort), MODEL_ROUTER_OAUTH_PORT: String(oauthPort),
      MODEL_ROUTER_GROK_OAUTH_PORT: String(grokPort), MODEL_ROUTER_ANTIGRAVITY_OAUTH_PORT: String(antigravityPort),
      MODEL_ROUTER_LITELLM_BIN: path.join(f.directory, "must-not-launch-missing-gateway"),
      CODEX_NATIVE_BASE_URL: upstreamBase, FIXTURE_COMPAT_KEY: "synthetic-fixture-key" });
    child = spawn(process.execPath, [path.join(root, "src/start.mjs")], { cwd: root, env: f.env,
      windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const base = `http://127.0.0.1:${routerPort}`;
    let health;
    for (let i = 0; i < 300; i++) {
      assert.equal(child.exitCode, null, stderr);
      try { const r = await fetch(`${base}/health`); if (r.ok) { health = await r.json(); break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(health?.ok, true, stderr);
    assert.equal(health.compatibilityLayer.enabled, false);
    const detailed = await (await fetch(`${base}/_codex-router/${caller}/v1/health`)).json();
    assert.equal(detailed.gateway.enabled, false);
    assert.equal(existsSync(path.join(f.state, "litellm.yaml")), false);
    const url = `${base}/_codex-router/${caller}/v1/responses`;
    const send = (model, extra = {}) => fetch(url, { method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer synthetic-native-token" },
      body: JSON.stringify({ model, stream: false, input: "fixture", ...extra }) });
    for (const model of ["custom/glm", "custom/grok", "gpt-fixture"]) {
      const response = await send(model);
      assert.equal(response.status, 200, await response.text());
    }
    const stream = await send("custom/glm", { stream: true });
    assert.equal(stream.status, 200);
    const streamText = await stream.text();
    assert.match(streamText, /response.completed/);
    assert.match(streamText, /fixture ok/);
    const toolResult = await send("custom/grok", { input: [
      { type: "function_call", call_id: "tool-1", name: "fixture_tool", arguments: "{}" },
      { type: "function_call_output", call_id: "tool-1", output: "original tool evidence" },
    ], tools: [{ type: "function", name: "fixture_tool", parameters: { type: "object", properties: {} } }] });
    assert.equal(toolResult.status, 200, await toolResult.text());
    assert.ok(payloads.at(-1).input.some(item => item.output === "original tool evidence"));
    const compact = await send("custom/glm", { input: [
      { role: "user", content: [{ type: "input_text", text: "Continue fixture" }] },
      { type: "compaction_trigger" },
    ] });
    assert.equal(compact.status, 200, await compact.clone().text());
    assert.equal((await compact.json()).output[0].type, "compaction");
    const socket = new WebSocket(`ws://127.0.0.1:${routerPort}/_codex-router/${caller}/v1/responses`, {
      headers: { "OpenAI-Beta": "responses_websockets=2026-02-06" },
    });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("fixture WebSocket open timeout")), 10_000);
        socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
        socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error(`fixture WebSocket failed: ${stderr}`)); }, { once: true });
      });
      const completed = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("fixture WebSocket completion timeout")), 10_000);
        socket.addEventListener("message", event => {
          const message = JSON.parse(String(event.data));
          if (message.type === "response.completed") { clearTimeout(timer); resolve(message); }
          if (message.type === "error" || message.type === "response.failed") {
            clearTimeout(timer); reject(new Error(JSON.stringify(message)));
          }
        });
      });
      socket.send(JSON.stringify({ type: "response.create", model: "custom/glm", input: [{ role: "user", content: "fixture" }], stream: true }));
      assert.equal((await completed).type, "response.completed");
    } finally { socket.close(); }
    const before = delivered.length;
    const blocked = await send("custom/chat");
    assert.equal(blocked.status, 409);
    assert.equal((await blocked.json()).error.code, "compatibility_layer_disabled");
    for (const endpoint of ["embeddings", "decisions", "responses/compact"]) {
      const rejected = await fetch(url.replace(/responses$/, endpoint), { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "custom/chat", input: [] }) });
      assert.equal(rejected.status, 409, await rejected.clone().text());
      assert.equal((await rejected.json()).error.code, "compatibility_layer_disabled");
    }
    assert.equal(delivered.length, before);
    const listed = await (await fetch(`${base}/_codex-router/${caller}/v1/models`)).json();
    assert.ok(!listed.data.some(m => m.id === "custom/chat"));
    writeFileSync(path.join(f.state, "native-aliases.json"), JSON.stringify({ version: 1, aliases: { "gpt-disabled-alias": "custom/chat" } }));
    const alias = await send("gpt-disabled-alias");
    assert.equal(alias.status, 409, await alias.text());
    writeFileSync(path.join(f.state, "native-redirect.json"), JSON.stringify({ version: 1, model: "custom/chat" }));
    const redirect = await send("gpt-fixture");
    assert.equal(redirect.status, 409, await redirect.text());
    const internal = await fetch(`http://127.0.0.1:${apiPort}/v1/responses`, { method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer compatibility-internal-fixture-with-sufficient-length" },
      body: JSON.stringify({ model: "custom-chat", input: "must not arrive" }) });
    assert.equal(internal.status, 409);
    assert.equal((await internal.json()).error.code, "compatibility_layer_disabled");
    assert.equal(delivered.length, before);
  } finally {
    if (child) await terminateProcessTree(child, { graceMs: 500 });
    await new Promise(resolve => upstream.close(resolve));
    rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
