import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import { isBoyueDeepSeekResponses, usesDeepSeekResponses } from "../src/deepseek-responses.mjs";
import { curatableRequestProfile, requestProfileKnown } from "../src/request-profiles.mjs";
import { userModelEntry } from "../src/user-models.mjs";
import { RESPONSES_WEBSOCKET_BETA } from "../src/responses-websocket.mjs";
import { childOutput, waitForListeners } from "./listener-readiness.mjs";
import { openPort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const profile = "boyue-deepseek-responses";
const caller = "synthetic-boyue-router-caller-capability";
const internal = "synthetic-boyue-router-internal-capability";
const key = "synthetic-boyue-origin-only-credential";
const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const namespace = "mcp__fixture";
const functionTool = {
  type: "function", name: "lookup", description: "Synthetic read-only lookup",
  parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"], additionalProperties: false },
};
const customTool = { type: "custom", name: "edit_source", description: "Synthetic raw text recorder", format: { type: "text" } };
const searchTool = {
  type: "tool_search", execution: "client", description: "Search registered deferred tools",
  parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
};
const msg = (text, role = "user") => ({ type: "message", role, content: [{ type: "input_text", text }] });
const frame = (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

function json(response, body, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks));
}

function parseEvents(body) {
  return body.split(/\r?\n\r?\n/).flatMap((block) => {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart()).join("\n");
    return data && data !== "[DONE]" ? [JSON.parse(data)] : [];
  });
}

function textItem(text, id = "msg_final") {
  return { id, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
}

function snapshot(output, id) {
  return { id, object: "response", created_at: 1, status: "completed", model: "deepseek-flash", output,
    usage: { input_tokens: 128, output_tokens: 16, total_tokens: 144,
      input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
}

function eventsFor(output, id) {
  const events = [];
  const add = (type, fields) => events.push({ type, sequence_number: events.length, ...fields });
  add("response.created", { response: { ...snapshot([], id), status: "in_progress" } });
  add("response.in_progress", { response: { ...snapshot([], id), status: "in_progress" } });
  for (const [index, item] of output.entries()) {
    const fields = { output_index: index, item_id: item.id };
    const tool = item.type === "function_call" || item.type === "custom_tool_call";
    const input = item.type === "custom_tool_call" ? "input" : "arguments";
    add("response.output_item.added", { output_index: index,
      item: { ...item, status: "in_progress", ...(tool ? { [input]: "" } : { content: [] }) } });
    if (tool) {
      const kind = item.type === "custom_tool_call" ? "custom_tool_call_input" : "function_call_arguments";
      for (const delta of [item[input].slice(0, 4), item[input].slice(4)]) add(`response.${kind}.delta`, { ...fields, delta });
      add(`response.${kind}.done`, { ...fields, [input]: item[input] });
    } else {
      for (const [contentIndex, part] of item.content.entries()) {
        const partFields = { ...fields, content_index: contentIndex };
        add("response.content_part.added", { ...partFields, part: { ...part, text: "" } });
        for (const delta of [part.text.slice(0, 5), part.text.slice(5)]) add("response.output_text.delta", { ...partFields, delta });
        add("response.output_text.done", { ...partFields, text: part.text });
        add("response.content_part.done", { ...partFields, part });
      }
    }
    add("response.output_item.done", { output_index: index, item });
  }
  add("response.completed", { response: snapshot(output, id) });
  return events;
}

function complete(events) {
  const terminals = events.filter((event) => ["response.completed", "response.incomplete", "response.failed", "error"].includes(event.type));
  assert.equal(terminals.length, 1, JSON.stringify(terminals));
  assert.equal(terminals[0].type, "response.completed", JSON.stringify(terminals[0]));
  return terminals[0].response;
}

function assertCustomStream(events, expected) {
  const output = complete(events).output;
  const item = output.find((value) => value.type === "custom_tool_call");
  assert.ok(item, JSON.stringify(output));
  assert.equal(item.name, customTool.name);
  assert.equal(item.input, expected);
  assert.equal(events.filter((event) => event.type === "response.custom_tool_call_input.delta")
    .map((event) => event.delta).join(""), expected);
  assert.equal(events.filter((event) => event.type === "response.custom_tool_call_input.done").at(-1).input, expected);
  return item;
}

async function serve(handler) {
  const server = http.createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      if (!response.headersSent) json(response, { error: { message: error.message } }, 500);
      else response.destroy(error);
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return server;
}

async function waitUntil(predicate, description) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out: ${description}`);
}

async function connect(base) {
  const url = new URL(`${base}/responses`);
  const socket = net.createConnection({ host: url.hostname, port: Number(url.port) });
  const queue = [];
  let buffer = Buffer.alloc(0);
  let upgraded = false;
  let error;
  function masked(opcode, value = "") {
    const payload = Buffer.from(value);
    assert.ok(payload.length < 65536, "fixture client frame is bounded");
    const header = Buffer.alloc(payload.length < 126 ? 2 : 4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | (payload.length < 126 ? payload.length : 126);
    if (header.length === 4) header.writeUInt16BE(payload.length, 2);
    const mask = randomBytes(4);
    const bytes = Buffer.from(payload);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] ^= mask[index & 3];
    return Buffer.concat([header, mask, bytes]);
  }
  socket.on("error", (value) => { error = value; });
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!upgraded) {
      const end = buffer.indexOf("\r\n\r\n");
      if (end === -1) return;
      const head = buffer.subarray(0, end).toString("ascii");
      buffer = buffer.subarray(end + 4);
      if (!/^HTTP\/1\.1 101 /.test(head)) { error = new Error(head); socket.destroy(); return; }
      upgraded = true;
    }
    while (buffer.length >= 2) {
      const opcode = buffer[0] & 0x0f;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2); offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        const wideLength = buffer.readBigUInt64BE(2);
        if (wideLength > 1024n * 1024n) { error = new Error("Oversized fixture response frame"); socket.destroy(); return; }
        length = Number(wideLength); offset = 10;
      }
      if (buffer.length < offset + length) return;
      const payload = buffer.subarray(offset, offset + length); buffer = buffer.subarray(offset + length);
      if (opcode === 1) queue.push(JSON.parse(payload.toString("utf8")));
      if (opcode === 9) socket.write(masked(10, payload));
      if (opcode === 8) socket.end();
    }
  });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve); socket.once("error", reject);
  });
  socket.write([`GET ${url.pathname} HTTP/1.1`, `Host: ${url.host}`, "Upgrade: websocket", "Connection: Upgrade",
    `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`, "Sec-WebSocket-Version: 13",
    `OpenAI-Beta: ${RESPONSES_WEBSOCKET_BETA}`, "", ""].join("\r\n"));
  await waitUntil(() => upgraded || error, "authenticated WebSocket handshake");
  if (error) throw error;
  return {
    socket: { close: () => socket.destroy() },
    send: (payload) => socket.write(masked(1, JSON.stringify(payload))),
    async next(type) {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (error) throw error;
        if (queue.length) {
          const value = queue.shift();
          if (value.type === "error") assert.fail(JSON.stringify(value));
          if (!type || value.type === type) return value;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.fail(`Timed out waiting for WebSocket ${type}`);
    },
  };
}

test("Boyue DeepSeek profile is explicit, model-scoped and does not alter official or other reseller routes", () => {
  const current = { provider: "custom", upstreamModel: "deepseek/deepseek-flash", requestProfile: profile,
    endpoint: { protocol: "openai-responses", baseUrl: "https://apicz.boyuerichdata.com/v1" } };
  assert.equal(requestProfileKnown(profile), true);
  assert.equal(curatableRequestProfile(profile), true);
  assert.equal(isBoyueDeepSeekResponses(current), true);
  assert.equal(usesDeepSeekResponses(current), true);
  for (const candidate of [undefined, {}, { ...current, requestProfile: undefined },
    { ...current, upstreamModel: "deepseek/deepseek-pro" }, { ...current, provider: "openrouter" },
    { ...current, endpoint: { ...current.endpoint, protocol: "openai" } },
    { provider: "deepseek", upstreamModel: "deepseek-flash" }]) {
    assert.equal(isBoyueDeepSeekResponses(candidate), false);
  }
  assert.equal(usesDeepSeekResponses({ provider: "deepseek", upstreamModel: "deepseek-flash" }), true);
  assert.equal(usesDeepSeekResponses({ provider: "opencode-go", upstreamModel: "deepseek-flash" }), false);
});

test("Boyue profile crosses real Router and forwarder with desktop, discovery, compaction and interrupt contracts", { timeout: 60_000 }, async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "router-boyue-responses-"));
  const codexHome = path.join(directory, "codex"); mkdirSync(codexHome);
  const requests = [];
  let mode = "text";
  let closed = 0;
  let gatewayCalls = 0;
  const upstream = await serve(async (request, response) => {
    const body = await readJson(request);
    const localMode = mode;
    requests.push({ path: request.url, body, auth: request.headers.authorization, mode: localMode });
    const forced = body.tool_choice === "required" || ["function", "custom"].includes(body.tool_choice?.type) ||
      (body.tool_choice?.type === "allowed_tools" && body.tool_choice.mode === "required");
    if (body.model === "deepseek/deepseek-flash") {
      if ((forced && body.reasoning?.effort !== "none") || body.tools?.some((tool) => tool.type === "namespace" ||
          (tool.type === "custom" && tool.name !== "apply_patch"))) {
        json(response, { error: { code: "upstream_contract", message: "Thinking forced choice, namespaces and non-patch custom tools are unsupported" } }, 400); return;
      }
      if (body.reasoning?.effort !== "none" && body.tools?.length && Array.isArray(body.input) &&
          body.input.some((item) => item.type === "function_call") && !body.input.some((item) => item.type === "reasoning")) {
        json(response, { error: { code: "missing_reasoning", message: "Thinking history must carry reasoning_text" } }, 400); return;
      }
    }
    const id = `resp_boyue_${requests.length}`;
    if (["captured-output-limit", "captured-invalid-complete"].includes(localMode)) {
      let raw = readFileSync(new URL("./fixtures/boyue-truncated-tool.sse", import.meta.url), "utf8");
      if (localMode === "captured-invalid-complete") {
        const events = parseEvents(raw);
        for (const e of events) {
          if (e.item?.status === "incomplete") e.item.status = "completed";
          if (e.type === "response.incomplete") { e.type = "response.completed"; e.response.status = "completed"; e.response.output[0].status = "completed"; }
        }
        raw = events.map(frame).join("");
      }
      if (body.stream === false) { json(response, parseEvents(raw).at(-1).response); return; }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(raw); return;
    }
    if (localMode === "hold") {
      response.once("close", () => { closed += 1; });
      response.writeHead(200, { "content-type": "text/event-stream" });
      const completePrefix = eventsFor([textItem("checkpoint retained", "msg_checkpoint")], id).slice(0, -1);
      response.write(completePrefix.map(frame).join(""));
      response.write(frame({ type: "response.output_item.added", sequence_number: completePrefix.length, output_index: 1,
        item: { id: "ctc_partial", type: "custom_tool_call", name: "apply_patch", call_id: "pending_patch", status: "in_progress", input: "" } }));
      response.write(frame({ type: "response.custom_tool_call_input.delta", sequence_number: completePrefix.length + 1,
        output_index: 1, item_id: "ctc_partial", delta: "*** Begin Patch\n" }));
      return;
    }
    let output = [textItem("fixture answer")];
    if (localMode === "text" && forced) {
      const selected = body.tool_choice?.type === "function"
        ? body.tools?.find((tool) => tool.name === body.tool_choice.name)
        : body.tools?.find((tool) => tool.type === "function");
      if (!selected) { json(response, { error: { code: "unknown_tool", message: "Forced tool is undeclared" } }, 400); return; }
      output = [{ id: "fc_forced", type: "function_call", status: "completed", name: selected.name,
        call_id: "forced_lookup", arguments: '{"key":"exact"}' }];
    }
    if (localMode === "desktop") {
      const tool = body.tools.find((value) => value.type === "function" && value.name.endsWith("__lookup"));
      assert.ok(tool, "Desktop registered tool must reach the origin");
      output = [{ id: "fc_desktop", type: "function_call", status: "completed", name: tool.name,
        call_id: "desktop_lookup", arguments: '{"key":"desktop"}' }];
    } else if (localMode === "search") {
      const tool = body.tools.find((value) => value.name === "tool_search");
      assert.ok(tool, "Client tool_search must be bridged, not dropped");
      output = [{ id: "fc_search", type: "function_call", status: "completed", name: tool.name,
        call_id: "search_lookup", arguments: '{"query":"edit source"}' }];
    } else if (localMode === "custom") {
      const tool = body.tools.find((value) => value.type === "function" && value.parameters?.properties?.input);
      assert.ok(tool, `Discovered custom tool must be bridged: ${JSON.stringify(body.tools)}`);
      output = [{ id: "fc_custom", type: "function_call", status: "completed", name: tool.name,
        call_id: "custom_edit", arguments: '{"input":"RAW_CODE_17"}' }];
    }
    if (body.stream === false) { json(response, snapshot(output, id)); return; }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const bytes = Buffer.from(eventsFor(output, id).map(frame).join(""));
    for (let index = 0; index < bytes.length; index += 43) {
      response.write(bytes.subarray(index, index + 43));
      await new Promise((resolve) => setImmediate(resolve));
    }
    response.end();
  });
  const gateway = await serve((_request, response) => { gatewayCalls += 1; json(response, { error: { message: "Forbidden gateway negative control" } }, 503); });
  const endpoint = { baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, protocol: "openai-responses",
    credential: { file: "boyue-fixture.secret", environment: ["BOYUE_FIXTURE_KEY"] } };
  const model = { ...userModelEntry({ providerId: "custom", upstreamId: "deepseek/deepseek-flash", requestProfile: profile,
    priority: 900, metadata: { inputModalities: ["text", "image"], contextWindow: 65536, autoCompact: 50000 } }), endpoint };
  const control = { ...userModelEntry({ providerId: "custom", upstreamId: "unrelated-responses", priority: 800 }), endpoint };
  writeFileSync(path.join(directory, "user-models.json"), JSON.stringify({ version: 1, models: [model, control] }));
  writeFileSync(path.join(directory, "enabled-providers.json"), JSON.stringify({ version: 1, providers: ["custom"] }));
  // The HTTP catalog serves an already-published artifact, independently from
  // the route registry. Seed only this fixture's two isolated picker entries.
  writeFileSync(path.join(directory, "merged-models.json"), JSON.stringify({ models: [model, control] }));
  const routerPort = await openPort(); const apiPort = await openPort();
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^(MODEL_ROUTER_|CODEX_ROUTER_|ROUTER_PLANE_)/.test(name)) delete env[name];
  Object.assign(env, { HOME: directory, CODEX_HOME: codexHome, MODEL_ROUTER_STATE_DIR: directory, CODEX_ROUTER_STATE_DIR: directory,
    MODEL_ROUTER_USER_MODELS: path.join(directory, "user-models.json"), CODEX_ROUTER_PORT: String(routerPort), CODEX_ROUTER_API_PORT: String(apiPort),
    CODEX_ROUTER_CALLER_KEY: caller, CODEX_ROUTER_INTERNAL_KEY: internal, KIMI_INTERNAL_KEY: internal,
    CODEX_ROUTER_API_BASE_URL: `http://127.0.0.1:${apiPort}/v1`, CODEX_ROUTER_API_HEALTH_URL: `http://127.0.0.1:${apiPort}/health`,
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.address().port}/v1`,
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${gateway.address().port}/native`,
    CODEX_ROUTER_SHOW_ALL_MODELS: "1", CODEX_ROUTER_QUIET: "1", BOYUE_FIXTURE_KEY: key });
  const output = childOutput();
  const children = ["api-forwarder.mjs", "router.mjs"].map((script) => output.capture(script,
    spawn(process.execPath, [path.join(root, "src", script)], { cwd: root, env, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] })));
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await Promise.all(children.map((child) => child.exitCode !== null || child.signalCode !== null
      ? undefined : new Promise((resolve) => child.once("exit", resolve))));
    for (const server of [upstream, gateway]) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.match(path.basename(directory), /^router-boyue-responses-/);
    rmSync(directory, { recursive: true, force: true });
  });
  const base = callerBaseUrl(routerPort, caller);
  const send = (body, resource = "/responses", signal) => fetch(`${base}${resource}`, {
    method: "POST", headers: { "content-type": "application/json" }, signal,
    body: JSON.stringify({ model: model.slug, input: [msg("Synthetic Boyue test")], stream: true,
      reasoning: { effort: "high" }, tools: [], ...body }),
  });
  await waitForListeners([
    { name: "Boyue API /health", url: `http://127.0.0.1:${apiPort}/health`, headers: { authorization: `Bearer ${internal}` } },
    { name: "Boyue Router /models", url: `${base}/models` },
  ], { children, output });

  await t.test("fixture negative controls reproduce the original upstream refusals", async () => {
    for (const invalid of [{ reasoning: { effort: "high" }, tools: [], tool_choice: "required" },
      { reasoning: { effort: "none" }, tools: [customTool] }]) {
      const response = await fetch(`${endpoint.baseUrl}/responses`, { method: "POST", body: JSON.stringify({ model: model.upstreamModel, ...invalid }) });
      assert.equal(response.status, 400); await response.text();
    }
  });

  await t.test("served catalog and forced choices preserve isolation, actual tool permission and effort", async () => {
    const catalog = await (await fetch(`${base}/models`)).json();
    assert.ok(catalog.data.some((entry) => entry.id === model.slug));
    for (const tool_choice of ["required", { type: "function", name: "lookup" }]) {
      const response = await send({ tools: [functionTool], tool_choice });
      assert.equal(response.status, 200, await response.clone().text());
      assert.ok(complete(parseEvents(await response.text())).output.some((item) => item.type === "function_call" && item.name === "lookup"));
      assert.deepEqual(requests.at(-1).body.tool_choice, tool_choice);
      assert.equal(requests.at(-1).body.reasoning.effort, "none");
      assert.equal(requests.at(-1).path, "/v1/responses");
      assert.equal(requests.at(-1).auth, `Bearer ${key}`);
    }
    // Exercise the profile's API boundary directly for an unrelated endpoint;
    // this branch does not include the separate generic-custom Router changes.
    const response = await fetch(`http://127.0.0.1:${apiPort}/v1/responses`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${internal}` },
      body: JSON.stringify({ model: control.gatewayModel, input: [msg("rule", "developer")],
        tools: [functionTool], tool_choice: "required", stream: true, reasoning: { effort: "high" } }),
    });
    assert.equal(response.status, 200); complete(parseEvents(await response.text()));
    assert.equal(requests.at(-1).body.tool_choice, "required");
    assert.equal(requests.at(-1).body.reasoning.effort, "high");
    assert.ok(requests.at(-1).body.input.some((item) => item.role === "developer"));
    const prohibited = await send({ tools: [functionTool], tool_choice: "none" });
    assert.equal(prohibited.status, 200); complete(parseEvents(await prohibited.text()));
    assert.equal(requests.at(-1).body.tool_choice, "none");
    assert.equal(requests.at(-1).body.reasoning.effort, "high");
  });

  await t.test("captured output-limit response crosses the actual forwarder and Router without partial tool dispatch or replay", async () => {
    mode = "captured-output-limit";
    const before = requests.length;
    for (const stream of [true, false]) {
      const response = await send({ stream, tools: [{ type: "namespace", name: "web", tools: [{ type: "function", name: "run", parameters: { type: "object", properties: { url: { type: "string" } } } }] }] });
      assert.equal(response.status, 200);
      const result = stream ? parseEvents(await response.text()).at(-1).response : await response.json();
      assert.equal(result.status, "incomplete");
      assert.equal(result.incomplete_details.reason, "max_output_tokens");
      assert.deepEqual(result.output, []);
      assert.equal(result.usage.output_tokens, 16);
    }
    assert.equal(requests.length, before + 2, "one upstream request per client request");
    mode = "text";
  });

  await t.test("necessary raw failure capture reaches the actual Router error boundary only for the consented thread", async () => {
    mode = "captured-invalid-complete";
    const threadId = "00000000-0000-4000-8000-000000000017";
    writeFileSync(path.join(directory, "relay-failure-capture.json"), JSON.stringify({ threadId, model: model.slug, expiresAt: Date.now() + 60_000 }));
    const response = await fetch(`${base}/responses`, { method: "POST", headers: { "content-type": "application/json", "thread-id": threadId },
      body: JSON.stringify({ model: model.slug, input: [msg("Synthetic invalid completed JSON control")], stream: true,
        tools: [{ type: "namespace", name: "web", tools: [{ type: "function", name: "run", parameters: { type: "object", properties: { url: { type: "string" } } } }] }] }) });
    assert.match(await response.text(), /ERR_NAMESPACE_RELAY_COMMITTED_STREAM/);
    const capture = JSON.parse(readFileSync(path.join(directory, "relay-failure-capture-1.json"), "utf8"));
    assert.equal(capture.threadId, threadId);
    assert.equal(capture.reason, "ambiguous function arguments");
    const event = parseEvents(Buffer.from(capture.frameBase64, "base64").toString("utf8"))[0];
    assert.equal(event.arguments, '{"url"');
    assert.equal("headers" in capture, false);
    mode = "text";
  });

  await t.test("client discovery capability never silently grants provider-hosted web search", async () => {
    const ambient = await send({ tools: [{ type: "web_search" }, functionTool] });
    assert.equal(ambient.status, 200, await ambient.clone().text()); await ambient.text();
    assert.equal(requests.at(-1).body.tools.some((tool) => tool.type === "web_search"), false);
    const before = requests.length;
    const explicit = await send({ tools: [{ type: "web_search" }], tool_choice: { type: "web_search" } });
    assert.equal(explicit.status, 400); await explicit.text();
    assert.equal(requests.length, before, "unsupported explicit search is rejected before generation");
  });

  await t.test("desktop preflattened MCP tools retain exact callable identity and mixed developer images remain valid", async () => {
    mode = "desktop";
    const response = await send({
      input: [{ type: "message", role: "developer", content: [{ type: "input_text", text: "Follow the project contract." }, { type: "input_image", image_url: image }] }, msg("Use the registered lookup")],
      tools: [{ ...functionTool, name: `${namespace}__lookup` }],
      tool_choice: { type: "function", name: `${namespace}__lookup` },
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ tool_namespaces_info: {
        [namespace]: { name: namespace, functions: { lookup: { name: "lookup", direct: true, source: { kind: "mcp", server_name: "fixture" } } } },
      } }) },
    });
    assert.equal(response.status, 200, await response.clone().text());
    const result = complete(parseEvents(await response.text()));
    const call = result.output.find((item) => item.type === "function_call");
    assert.equal(call.namespace, namespace); assert.equal(call.name, "lookup");
    assert.deepEqual(JSON.parse(call.arguments), { key: "desktop" });
    const body = requests.at(-1).body;
    assert.equal(body.client_metadata, undefined);
    assert.ok(body.input.some((item) => item.role === "system" && item.content.some((part) => part.text === "Follow the project contract.")));
    assert.ok(body.input.some((item) => ["user", "developer"].includes(item.role) && item.content.some((part) => part.image_url === image)));
    assert.equal(body.input.some((item) => item.role === "system" && item.content.some((part) => part.type === "input_image")), false);
  });

  let discoveredHistory;
  await t.test("client tool discovery, deferred custom calls and subsequent results survive both bridges", async () => {
    mode = "search";
    const tools = [searchTool, { type: "namespace", name: "mcp__deferred", description: "Registered deferred tools", tools: [{ ...functionTool, defer_loading: true }] }];
    const response = await send({ tools, tool_choice: { type: "tool_search", execution: "client" } });
    assert.equal(response.status, 200, await response.clone().text());
    const result = complete(parseEvents(await response.text()));
    const search = result.output.find((item) => item.type === "tool_search_call");
    assert.ok(search, JSON.stringify(result)); assert.equal(search.execution, "client");
    assert.equal(requests.at(-1).body.tools.some((tool) => tool.name.includes("mcp__deferred")), false,
      "undeclared deferred tool is withheld until discovery");
    const searchOutput = { type: "tool_search_output", call_id: search.call_id, execution: "client", status: "completed", tools: [customTool] };
    discoveredHistory = [msg("Discover and edit source"), ...result.output, searchOutput];
    mode = "custom";
    const custom = await send({ input: discoveredHistory, tools: [searchTool], tool_choice: { type: "custom", name: customTool.name } });
    assert.equal(custom.status, 200, await custom.clone().text());
    const events = parseEvents(await custom.text());
    const call = assertCustomStream(events, "RAW_CODE_17");
    assert.equal(requests.at(-1).body.reasoning.effort, "none");
    assert.equal(requests.at(-1).body.input.some((item) => ["tool_search_call", "tool_search_output"].includes(item.type)), false);
    discoveredHistory = [...discoveredHistory, ...complete(events).output,
      { type: "custom_tool_call_output", call_id: call.call_id, output: "EDIT_APPLIED_17" }];
    mode = "text";
    const followup = await send({ input: discoveredHistory, tools: [searchTool] });
    assert.equal(followup.status, 200, await followup.clone().text()); complete(parseEvents(await followup.text()));
    const body = requests.at(-1).body;
    assert.equal(body.reasoning.effort, "high");
    assert.ok(body.input.some((item) => item.type === "function_call_output" && item.output === "EDIT_APPLIED_17"));
    assert.ok(body.input.some((item) => item.type === "reasoning" && item.content.some((part) => /unavailable/i.test(part.text))),
      "restored thinking explicitly marks genuinely unavailable historical reasoning");
    assert.equal(body.input.some((item) => item.type === "custom_tool_call"), false);
  });

  await t.test("compaction strips deferred schemas but retains real tool work and supports resumed requests", async () => {
    mode = "text";
    const response = await send({ input: [...discoveredHistory, msg("Keep PROJECT_CODE_592 in the summary.")], tools: [searchTool, customTool], stream: false }, "/responses/compact");
    assert.equal(response.status, 200, await response.clone().text());
    const compact = await response.json();
    assert.ok(Array.isArray(compact.output));
    assert.ok(JSON.stringify(compact.output).includes("fixture answer"), "V1 exposes a usable summary message");
    const body = requests.at(-1).body;
    assert.equal(body.stream, false, "the custom per-model endpoint uses the ordinary JSON summarizer");
    assert.equal(body.tools?.length || 0, 0); assert.equal(body.tool_choice, undefined); assert.equal(body.previous_response_id, undefined);
    assert.equal(body.input.some((item) => ["tool_search_call", "tool_search_output", "custom_tool_call", "custom_tool_call_output"].includes(item.type)), false);
    assert.ok(JSON.stringify(body.input).includes("RAW_CODE_17"));
    assert.ok(JSON.stringify(body.input).includes("EDIT_APPLIED_17"));
    assert.ok(JSON.stringify(body.input).includes("PROJECT_CODE_592"));
    const resumed = await send({ input: [...compact.output, msg("Continue the project")] });
    assert.equal(resumed.status, 200, await resumed.clone().text()); complete(parseEvents(await resumed.text()));
    const v2Response = await send({ input: [...discoveredHistory, { type: "compaction_trigger" }], tools: [searchTool, customTool], stream: false });
    assert.equal(v2Response.status, 200, await v2Response.clone().text());
    const v2 = await v2Response.json();
    assert.ok(v2.output.some((item) => item.type === "compaction" && typeof item.encrypted_content === "string"));
    const v2Resumed = await send({ input: [...v2.output, msg("Continue from the opaque V2 checkpoint")] });
    assert.equal(v2Resumed.status, 200, await v2Resumed.clone().text()); complete(parseEvents(await v2Resumed.text()));
  });

  await t.test("invalid discovery pairs cannot grant custom tools and a live function schema wins collisions", async () => {
    mode = "text";
    const call = { type: "tool_search_call", call_id: "search_negative", execution: "client", arguments: { query: "edit source" } };
    const result = { type: "tool_search_output", call_id: call.call_id, execution: "client", status: "completed", tools: [customTool] };
    for (const history of [[result], [call, result, result], [call, call, result]]) {
      const response = await send({ input: [msg("No undeclared tools may be granted"), ...history], tools: [searchTool] });
      assert.equal(response.status, 200, await response.clone().text()); complete(parseEvents(await response.text()));
      assert.equal(requests.at(-1).body.tools.some((tool) => tool.name === customTool.name || tool.parameters?.properties?.input), false);
      assert.equal(requests.at(-1).body.input.some((item) => ["tool_search_call", "tool_search_output"].includes(item.type)), false);
    }
    const live = { ...functionTool, name: customTool.name, description: "Authoritative live definition",
      parameters: { type: "object", properties: { live_only: { type: "string" } }, required: ["live_only"], additionalProperties: false } };
    const response = await send({ input: [msg("Respect the live tool declaration"), call, result], tools: [searchTool, live] });
    assert.equal(response.status, 200, await response.clone().text()); complete(parseEvents(await response.text()));
    const matches = requests.at(-1).body.tools.filter((tool) => tool.name === customTool.name);
    assert.equal(matches.length, 1); assert.deepEqual(matches[0].parameters, live.parameters);
    assert.equal(requests.at(-1).body.tools.some((tool) => tool.type === "custom" || tool.parameters?.properties?.input), false);
  });

  await t.test("discovered namespaced custom tools preserve namespace identity through a result round trip", async () => {
    const discoveredNamespace = { type: "namespace", name: "mcp__editor", description: "Synthetic editor tools", tools: [customTool] };
    const history = [msg("Discover the registered editor"),
      { type: "tool_search_call", call_id: "search_editor", execution: "client", arguments: { query: "editor" } },
      { type: "tool_search_output", call_id: "search_editor", execution: "client", status: "completed", tools: [discoveredNamespace] }];
    mode = "custom";
    const response = await send({ input: history, tools: [searchTool],
      tool_choice: { type: "custom", namespace: discoveredNamespace.name, name: customTool.name } });
    assert.equal(response.status, 200, await response.clone().text());
    const events = parseEvents(await response.text());
    const call = assertCustomStream(events, "RAW_CODE_17");
    assert.equal(call.namespace, discoveredNamespace.name);
    assert.ok(requests.at(-1).body.tools.some((tool) => tool.type === "function" && tool.name.startsWith("mcp__editor__") && tool.parameters?.properties?.input));
    mode = "text";
    const followup = await send({ input: [...history, ...complete(events).output,
      { type: "custom_tool_call_output", call_id: call.call_id, output: "NAMESPACED_EDIT_APPLIED" }], tools: [searchTool] });
    assert.equal(followup.status, 200, await followup.clone().text()); complete(parseEvents(await followup.text()));
    const body = requests.at(-1).body;
    assert.ok(body.input.some((item) => item.type === "function_call" && item.name.startsWith("mcp__editor__")));
    assert.ok(body.input.some((item) => item.type === "function_call_output" && item.output === "NAMESPACED_EDIT_APPLIED"));
  });

  await t.test("unknown HTTP previous-response IDs fail without silently losing history or calling the provider", async () => {
    const count = requests.length;
    const response = await send({ previous_response_id: "resp_unknown_boyue", input: [msg("What did I say before?")] });
    assert.equal(response.status, 409, await response.clone().text());
    await response.text(); assert.equal(requests.length, count);
  });

  await t.test("HTTP abort cancels the owned origin request without replay after first bytes", async () => {
    mode = "hold";
    const before = requests.length; const previousClosed = closed;
    const controller = new AbortController();
    const response = await send({ tools: [{ type: "custom", name: "apply_patch", format: { type: "text" } }] }, "/responses", controller.signal);
    const reader = response.body.getReader(); assert.equal((await reader.read()).done, false);
    controller.abort();
    try { while (!(await reader.read()).done) { /* the intentional cancellation may race a buffered frame */ } } catch { /* expected */ }
    await waitUntil(() => closed > previousClosed, "origin closes after HTTP cancellation");
    assert.equal(requests.length, before + 1, "no retry after response bytes reached the client");
    mode = "text";
  });

  await t.test("desktop WebSocket interruption preserves completed items and reconstructs a reusable continuation", async () => {
    mode = "hold";
    const before = requests.length; const previousClosed = closed;
    const peer = await connect(base);
    try {
      const create = (extra = {}) => ({ type: "response.create", model: model.slug, stream: true, reasoning: { effort: "high" },
        input: [msg("Start a synthetic interrupted turn")], tools: [{ type: "custom", name: "apply_patch", format: { type: "text" } }], ...extra });
      peer.send(create());
      const opened = await peer.next("response.created");
      await peer.next("response.custom_tool_call_input.delta");
      peer.send({ type: "response.interrupt", response_id: opened.response.id, mode: "discard_partial_items" });
      await peer.next("response.interrupt.accepted");
      const interrupted = await peer.next("response.incomplete");
      assert.equal(interrupted.response.incomplete_details.reason, "interrupted");
      assert.ok(interrupted.response.output.some((item) => item.id === "msg_checkpoint"));
      assert.equal(interrupted.response.output.some((item) => item.call_id === "pending_patch"), false);
      await waitUntil(() => closed > previousClosed, "origin closes after desktop interrupt");
      assert.equal(requests.length, before + 1, "interruption never replays a generation");
      mode = "text";
      const next = msg("Continue after interruption");
      peer.send(create({ previous_response_id: opened.response.id, input: [next] }));
      await peer.next("response.completed");
      const body = requests.at(-1).body;
      assert.equal(body.previous_response_id, undefined);
      assert.ok(body.input.some((item) => item.id === "msg_checkpoint"));
      assert.equal(body.input.some((item) => item.call_id === "pending_patch"), false);
      assert.ok(JSON.stringify(body.input).includes("Continue after interruption"));
      assert.equal(requests.length, before + 2);
    } finally { peer.socket.close(); }
  });
  assert.equal(gatewayCalls, 0, "Boyue Responses never enters native passthrough or the Chat gateway");
});
