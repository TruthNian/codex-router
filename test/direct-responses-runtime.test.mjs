import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import { userModelEntry } from "../src/user-models.mjs";
import { PROVIDER_DELIVERY_STATE_HEADER } from "../src/transport-failure.mjs";
import { openPort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const caller = "synthetic-direct-responses-caller-capability";
const internal = "synthetic-direct-responses-internal-capability";
const nativeCredential = "synthetic-direct-responses-native-credential";
const namespace = "mcp__cua_repl";
const callId = "call_cua_identity";
const customCallId = "call_patch_identity";
const argumentsText = JSON.stringify({ code: "await cua.getState()", title: "Inspect synthetic state" });
const patch = "*** Begin Patch\n*** End Patch";
const reasoningText = "Synthetic reasoning remains in its own channel.";
const answer = "Preserve `<reason>literal XML</reason>`, x < and <th.";
const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAY0lEQVR4nO3PQQ3AIADAQEALAhGJsIngcVnSU9DOfe74s6UDXjWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgfRdzAdh+IIyPAAAAAElFTkSuQmCC";
const tools = [
  { type: "namespace", name: namespace, description: "Synthetic CUA namespace", tools: [
    { type: "function", name: "js", description: "Inspect a local synthetic browser", parameters: {
      type: "object", properties: { code: { type: "string" }, title: { type: "string" } }, required: ["code"],
    } },
  ] },
  { type: "custom", name: "apply_patch", description: "Synthetic patch; never executed", format: { type: "text" } },
];

const frame = (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
function parseEvents(body) {
  return body.split(/\r?\n\r?\n/).flatMap((block) => {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart()).join("\n");
    return data && data !== "[DONE]" ? [JSON.parse(data)] : [];
  });
}
function ledger(directory) {
  const file = path.join(directory, "usage-events.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse) : [];
}
async function waitUntil(predicate, children = []) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Owned fixture process exited: ${child.testErrors()}`);
    }
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error(`Isolated contract condition timed out. ${children.map((child) => child.testErrors()).join("\n")}`);
}
async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks));
}
function json(response, payload, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}
function snapshot(output, id = "resp_contract") {
  return { id, object: "response", created_at: 1, status: "completed", output,
    usage: { input_tokens: 1234, output_tokens: 25, total_tokens: 1259,
      input_tokens_details: { cached_tokens: 1000 }, output_tokens_details: { reasoning_tokens: 7 } } };
}
function textItem(text, id = "msg_final", phase) {
  return { id, type: "message", role: "assistant", status: "completed",
    ...(phase ? { phase } : {}), content: [{ type: "output_text", text, annotations: [] }] };
}
function stream(output, id = "resp_contract") {
  const events = [];
  const add = (type, fields) => events.push({ type, sequence_number: events.length, ...fields });
  add("response.created", { response: { ...snapshot([], id), status: "in_progress" } });
  output.forEach((item, outputIndex) => {
    const fields = { output_index: outputIndex, item_id: item.id };
    const tool = ["function_call", "custom_tool_call"].includes(item.type);
    const field = item.type === "custom_tool_call" ? "input" : "arguments";
    add("response.output_item.added", { output_index: outputIndex,
      item: { ...item, status: "in_progress", ...(tool ? { [field]: "" } : { content: [] }) } });
    if (tool) {
      const kind = item.type === "custom_tool_call" ? "custom_tool_call_input" : "function_call_arguments";
      for (const delta of [item[field].slice(0, 5), item[field].slice(5)]) add(`response.${kind}.delta`, { ...fields, delta });
      add(`response.${kind}.done`, { ...fields, [field]: item[field] });
    } else {
      for (const [contentIndex, part] of item.content.entries()) {
        const partFields = { ...fields, content_index: contentIndex };
        add("response.content_part.added", { ...partFields, part: { ...part, text: "" } });
        for (const delta of [part.text.slice(0, 11), part.text.slice(11)]) add(`response.${part.type}.delta`, { ...partFields, delta });
        add(`response.${part.type}.done`, { ...partFields, text: part.text });
        add("response.content_part.done", { ...partFields, part });
      }
    }
    add("response.output_item.done", { output_index: outputIndex, item });
  });
  add("response.completed", { response: snapshot(output, id) });
  return events;
}

test("direct Responses retains the canonical Router and API contracts", { timeout: 90_000 }, async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "direct-responses-runtime-"));
  const codexHome = path.join(directory, "codex");
  mkdirSync(codexHome);
  const children = [];
  const servers = [];
  const observed = [];
  let mode = "tools";
  let flattened = false;
  let gatewayCalls = 0;
  let canceledProvider = false;
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.kill("SIGTERM");
        await exited;
      }
    }
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) &&
      path.basename(resolved).startsWith("direct-responses-runtime-"), "cleanup must stay inside its owned temporary fixture");
    rmSync(resolved, { recursive: true, force: true });
  });
  async function serve(handler) {
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  const samples = [
    { upstreamId: "z-ai/glm-5.3", key: "synthetic-glm-endpoint-key", variable: "TEST_DIRECT_RESPONSES_GLM_KEY" },
    { upstreamId: "grok-4.6", key: "synthetic-grok-endpoint-key", variable: "TEST_DIRECT_RESPONSES_GROK_KEY" },
  ];
  const textOnlyUpstream = "synthetic-text-only-reader";
  for (const sample of samples) {
    sample.base = await serve(async (request, response) => {
      const body = await readJson(request);
      observed.push({ sample, headers: { ...request.headers }, path: request.url, body });
      if (["vision-reset", "vision-503", "vision-failed-json"].includes(mode) && body.model === samples[1].upstreamId) {
        if (mode === "vision-reset") { request.socket.destroy(); return; }
        if (mode === "vision-failed-json") {
          json(response, { ...snapshot([textItem("Synthetic private partial vision transcript")]), status: "failed",
            error: { message: "Synthetic private vision provider detail" } });
          return;
        }
        json(response, { error: { message: "Synthetic private vision provider detail" } }, 503);
        return;
      }
      if (mode === "reset") {
        // The complete body has already reached the origin. Closing before
        // response headers cannot certify that this generation was unexecuted.
        request.socket.destroy();
        return;
      }
      if (mode === "spoof-transport") {
        response.writeHead(502, { "content-type": "application/json", [PROVIDER_DELIVERY_STATE_HEADER]: "not_sent" });
        response.end(JSON.stringify({ error: { type: "provider_transport_error", code: "ECONNREFUSED",
          deliveryState: "not_sent", message: "Synthetic origin-claimed delivery evidence" } }));
        return;
      }
      if (mode === "redirect-presend") {
        // A redirected connect can fail before sending to its new target even
        // though this origin has already consumed the generation POST.
        response.writeHead(307, { location: `http://127.0.0.1:${refusedPort}/v1/responses` });
        response.end();
        return;
      }
      if (mode === "cancel") {
        response.once("close", () => { canceledProvider = true; });
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(frame({ type: "response.created", response: { id: "resp_cancel", object: "response", status: "in_progress", output: [] } }));
        response.write(frame({ type: "response.output_item.added", output_index: 0, item: { id: "rs_cancel", type: "reasoning", status: "in_progress", content: [] } }));
        response.write(frame({ type: "response.reasoning_text.delta", output_index: 0, item_id: "rs_cancel", content_index: 0, delta: "Synthetic live reasoning" }));
        return;
      }
      if (mode === "invalid") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(frame({ type: "response.created", response: { id: "resp_before", object: "response", status: "in_progress", output: [] } }) +
          frame({ type: "response.completed", response: snapshot([textItem("Untrusted conflicting response")], "resp_after") }));
        return;
      }
      if (mode === "compact") {
        json(response, snapshot([textItem(JSON.stringify({ objective: "Preserve the synthetic request.", requirement_refs: ["U001"],
          attempt_refs: [], observation_refs: [], unverified: [], unknowns: [], blockers: [], next_step: "Continue the verified synthetic task." }))]));
        return;
      }
      const output = mode === "tools" ? [
        { id: "rs_contract", type: "reasoning", status: "completed", content: [{ type: "reasoning_text", text: reasoningText }] },
        textItem("Inspect the synthetic browser first.", "msg_progress"),
        { id: "fc_cua", type: "function_call", call_id: callId, status: "completed",
          name: flattened ? `${namespace}__js` : "js", ...(flattened ? {} : { namespace }), arguments: argumentsText },
        { id: "ctc_patch", type: "custom_tool_call", call_id: customCallId, status: "completed", name: "apply_patch", input: patch },
        textItem(answer),
      ] : [textItem(answer, "msg_final", "final_answer")];
      if (body.stream === false) { json(response, snapshot(output)); return; }
      response.writeHead(200, { "content-type": "text/event-stream" });
      // Nontrivial chunk boundaries exercise the real framing adapters.
      const bytes = Buffer.from(stream(output).map(frame).join(""));
      for (let offset = 0; offset < bytes.length; offset += 137) response.write(bytes.subarray(offset, offset + 137));
      response.end();
    });
    sample.entry = { ...userModelEntry({ providerId: "custom", upstreamId: sample.upstreamId, priority: 900,
      metadata: { inputModalities: ["text", "image"], ...(sample.upstreamId.includes("glm") ? { goalContinuationGuard: true, repetitionGuard: true } : {}) } }),
      endpoint: { baseUrl: `${sample.base}/v1`, protocol: "openai-responses",
        credential: { file: `${sample.variable}.secret`, environment: [sample.variable] } } };
  }
  const textOnly = { ...samples[0], upstreamId: textOnlyUpstream, entry: {
    ...userModelEntry({ providerId: "custom", upstreamId: textOnlyUpstream, priority: 800, metadata: { inputModalities: ["text"] } }),
    endpoint: samples[0].entry.endpoint,
  } };
  const refusedPort = await openPort();
  const refused = { entry: { ...userModelEntry({ providerId: "custom", upstreamId: "synthetic-refused-connect", priority: 700,
    metadata: { inputModalities: ["text"] } }), endpoint: { ...samples[0].entry.endpoint, baseUrl: `http://127.0.0.1:${refusedPort}/v1` } } };
  writeFileSync(path.join(directory, "user-models.json"), JSON.stringify({ version: 1,
    models: [...samples.map((sample) => sample.entry), textOnly.entry, refused.entry] }));
  writeFileSync(path.join(directory, "enabled-providers.json"), JSON.stringify({ version: 1, providers: ["custom"] }));
  writeFileSync(path.join(directory, "vision-bridge.json"), JSON.stringify({ version: 1, enabled: true,
    engine: samples[1].entry.slug, effort: "low", local: null }));
  const gateway = await serve((_request, response) => { gatewayCalls += 1; json(response, { error: { message: "Forbidden gateway negative control" } }, 503); });
  const native = await serve((_request, response) => { json(response, { error: { message: "No native upstream may be used in this fixture" } }, 503); });
  const apiPort = await openPort();
  const routerPort = await openPort();
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^(MODEL_ROUTER_|CODEX_ROUTER_|ROUTER_PLANE_)/.test(name)) delete env[name];
  Object.assign(env, { CODEX_HOME: codexHome, MODEL_ROUTER_STATE_DIR: directory, CODEX_ROUTER_STATE_DIR: directory,
    MODEL_ROUTER_USER_MODELS: path.join(directory, "user-models.json"), CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_API_PORT: String(apiPort), CODEX_ROUTER_CALLER_KEY: caller, CODEX_ROUTER_INTERNAL_KEY: internal,
    KIMI_INTERNAL_KEY: internal, CODEX_ROUTER_API_BASE_URL: `http://127.0.0.1:${apiPort}/v1`,
    CODEX_ROUTER_API_HEALTH_URL: `http://127.0.0.1:${apiPort}/health`,
    CODEX_ROUTER_GATEWAY_BASE_URL: `${gateway}/v1`, CODEX_ROUTER_GATEWAY_HEALTH_URL: `${gateway}/health`,
    CODEX_NATIVE_BASE_URL: native, CODEX_ROUTER_NO_DISCOVERY: "0", CODEX_ROUTER_SHOW_ALL_MODELS: "1", CODEX_ROUTER_QUIET: "1",
    ...Object.fromEntries(samples.map((sample) => [sample.variable, sample.key])),
  });
  function run(script, overrides = {}) {
    const child = spawn(process.execPath, [path.join(root, "src", script)], { cwd: root, env: { ...env, ...overrides },
      stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    children.push(child);
    let errors = "";
    child.stderr.on("data", (chunk) => { errors += chunk; });
    child.testErrors = () => errors;
    return child;
  }
  const api = run("api-forwarder.mjs");
  const router = run("router.mjs");
  const base = callerBaseUrl(routerPort, caller);
  await waitUntil(async () => { try { return (await fetch(`http://127.0.0.1:${apiPort}/health`, { headers: { authorization: `Bearer ${internal}` } })).ok; } catch { return false; } }, [api]);
  await waitUntil(async () => { try { return (await fetch(`${base}/models`)).ok; } catch { return false; } }, [router]);
  const headers = { "content-type": "application/json", authorization: `Bearer ${nativeCredential}`, "chatgpt-account-id": "synthetic-native-account-id" };
  async function post(sample, payload, endpoint = "/responses", options = {}) {
    return fetch(`${options.baseUrl ?? base}${endpoint}`, { method: "POST", headers: { ...headers, ...options.headers }, body: JSON.stringify({ model: sample.entry.slug,
      stream: true, input: [{ role: "user", content: "Synthetic contract input" }], tools, ...payload }),
      signal: options.signal ?? AbortSignal.timeout(10_000) });
  }

  await t.test("CUA namespaced and flattened calls retain IDs, arguments, custom tools and phases", async () => {
    mode = "tools";
    for (const sample of samples) for (const spelling of [false, true]) {
      flattened = spelling;
      const response = await post(sample, {});
      const body = await response.text();
      assert.equal(response.status, 200, body);
      const events = parseEvents(body);
      const finished = events.filter((event) => event.type === "response.output_item.done").map((event) => event.item);
      const cua = finished.find((item) => item.type === "function_call");
      assert.deepEqual({ id: cua.id, call_id: cua.call_id, namespace: cua.namespace, name: cua.name, arguments: cua.arguments },
        { id: "fc_cua", call_id: callId, namespace, name: "js", arguments: argumentsText });
      const custom = finished.find((item) => item.type === "custom_tool_call");
      assert.equal(custom.call_id, customCallId);
      assert.equal(custom.name, "apply_patch");
      assert.equal(custom.input, patch);
      assert.equal(finished.find((item) => item.id === "msg_progress").phase, "commentary");
      assert.equal(finished.find((item) => item.id === "msg_final").phase, "final_answer");
      assert.equal(events.filter((event) => event.type === "response.reasoning_text.delta").map((event) => event.delta).join(""), reasoningText);
      assert.equal(events.filter((event) => event.type === "response.output_text.delta" && event.item_id === "msg_final").map((event) => event.delta).join(""), answer);
      const completed = events.find((event) => event.type === "response.completed").response;
      assert.equal(completed.output.find((item) => item.id === "fc_cua").call_id, callId);
      assert.equal(completed.usage.input_tokens_details.cached_tokens, 1000);
      assert.equal(completed.usage.output_tokens_details.reasoning_tokens, 7);
    }
  });

  await t.test("replayed reasoning, native namespaces, phase and image survive canonical preparation", async () => {
    mode = "plain";
    const input = [
      { type: "message", role: "user", content: [{ type: "input_text", text: "Inspect this synthetic pixel" }, { type: "input_image", image_url: image, detail: "auto" }] },
      { type: "reasoning", id: "rs_prior", content: [{ type: "reasoning_text", text: reasoningText }] },
      { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "Prior progress" }] },
      { type: "function_call", id: "fc_prior", call_id: "call_prior", namespace, name: "js", arguments: argumentsText },
      { type: "function_call_output", call_id: "call_prior", output: "Synthetic CUA state" },
      { type: "custom_tool_call", id: "ctc_prior", call_id: "patch_prior", name: "apply_patch", input: patch },
      { type: "custom_tool_call_output", call_id: "patch_prior", output: "Synthetic patch result" },
    ];
    for (const sample of samples) {
      const response = await post(sample, { input, reasoning: { effort: "high" }, client_metadata: { private: "synthetic" }, access_programs: ["synthetic"] });
      assert.equal(response.status, 200, await response.text());
      const sent = observed.at(-1).body;
      assert.equal(sent.model, sample.upstreamId);
      assert.deepEqual(sent.tools, tools, "Responses tools must not cross a Chat Completions flattening path");
      assert.deepEqual(sent.input.find((item) => item.type === "reasoning"), input[1]);
      assert.equal(sent.input.find((item) => item.role === "assistant").phase, "commentary");
      assert.equal(sent.input.find((item) => item.type === "function_call").call_id, "call_prior");
      assert.equal(sent.input.find((item) => item.type === "function_call_output").output, "Synthetic CUA state");
      assert.equal(sent.input.find((item) => item.type === "custom_tool_call").input, patch);
      assert.equal(sent.input[0].content.find((part) => part.type === "input_image").image_url, image);
      assert.equal(sent.reasoning.effort, "high");
      assert.equal(sent.messages, undefined);
      assert.equal(sent.client_metadata, undefined);
      assert.equal(sent.access_programs, undefined);
    }
  });

  await t.test("nonstream JSON keeps native tools, namespace identities and usage", async () => {
    mode = "tools";
    flattened = true;
    for (const sample of samples) {
      const response = await post(sample, { stream: false });
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      const cua = result.output.find((item) => item.type === "function_call");
      assert.equal(cua.namespace, namespace);
      assert.equal(cua.name, "js");
      assert.equal(cua.call_id, callId);
      assert.equal(cua.arguments, argumentsText);
      assert.equal(result.output.find((item) => item.type === "custom_tool_call").input, patch);
      assert.equal(result.output.find((item) => item.id === "msg_final").content[0].text, answer);
      assert.equal(result.usage.input_tokens, 1234);
    }
  });

  await t.test("a Responses vision describer bypasses the gateway before the text-only turn", async () => {
    mode = "plain";
    const before = observed.length;
    const response = await post(textOnly, { tools: [], input: [{ type: "message", role: "user", content: [
      { type: "input_text", text: "Read this synthetic screenshot before answering." },
      { type: "input_image", image_url: image, detail: "auto" },
    ] }] });
    const body = await response.text();
    assert.equal(response.status, 200, body);
    const requests = observed.slice(before);
    assert.equal(requests.length, 2, "one vision description and one selected text-only generation are required");
    assert.equal(requests[0].body.model, samples[1].upstreamId);
    assert.equal(requests[0].headers.authorization, `Bearer ${samples[1].key}`);
    assert.ok(JSON.stringify(requests[0].body.input).includes(image), "only the vision-capable engine receives the original image");
    assert.equal(requests[1].body.model, textOnlyUpstream);
    assert.equal(requests[1].headers.authorization, `Bearer ${samples[0].key}`);
    assert.ok(!JSON.stringify(requests[1].body.input).includes("input_image"), "the text-only engine must receive evidence instead of image bytes");
    assert.ok(JSON.stringify(requests[1].body.input).includes(answer), "the actual vision output must be part of the selected model's input");
    assert.equal(gatewayCalls, 0, "the describer must use the same direct execution plan as ordinary Responses");
  });

  await t.test("remote V1 compaction uses the same direct credential and preparation boundary", async () => {
    mode = "compact";
    for (const sample of samples) {
      const input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "Preserve the synthetic request." }] },
        { type: "custom_tool_call", id: "ctc_compact", call_id: "patch_compact", name: "apply_patch", input: patch },
        { type: "custom_tool_call_output", call_id: "patch_compact", output: "Verified synthetic patch output" }];
      const response = await post(sample, { input, stream: false }, "/responses/compact");
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      assert.ok(Array.isArray(result.output) && result.output.length > 0);
      assert.match(JSON.stringify(result.output), /kcr2|compaction|checkpoint/i, "compaction must return a replayable checkpoint");
      const sent = observed.at(-1);
      assert.equal(sent.path, "/v1/responses");
      assert.equal(sent.body.model, sample.upstreamId);
      assert.ok(sent.body.tools === undefined || Array.isArray(sent.body.tools) && sent.body.tools.length === 0,
        "the summarizer must not receive any executable tool declarations");
      assert.equal(sent.body.input.find((item) => item.type === "custom_tool_call").call_id, "patch_compact");
      assert.ok(sent.body.input.some((item) => JSON.stringify(item).includes("Verified synthetic patch output")));
    }
  });

  await t.test("an ambiguous direct vision failure degrades the image without spending another engine", async () => {
    for (const failure of ["vision-reset", "vision-503", "vision-failed-json"]) {
      mode = failure;
      const before = observed.length;
      const response = await post(textOnly, { tools: [], input: [{ type: "message", role: "user", content: [
        { type: "input_text", text: `Read this synthetic screenshot for the ${failure} scenario.` },
        { type: "input_image", image_url: image },
      ] }] });
      assert.equal(response.status, 200, await response.text());
      const requests = observed.slice(before);
      assert.deepEqual(requests.map((sent) => sent.body.model), [samples[1].upstreamId, textOnlyUpstream],
        "one uncertain vision POST must not spend a second image-capable engine");
      assert.ok(JSON.stringify(requests[1].body.input).includes("could not be read"));
      assert.ok(!JSON.stringify(requests[1].body.input).includes("Synthetic private vision provider detail"));
      assert.ok(!JSON.stringify(requests[1].body.input).includes("Synthetic private partial vision transcript"));
      assert.ok(!JSON.stringify(requests[1].body.input).includes("input_image"));
    }
    assert.equal(gatewayCalls, 0);
  });

  await t.test("caller cancellation closes the real provider response and records cancellation", async () => {
    mode = "cancel";
    canceledProvider = false;
    const before = ledger(directory).length;
    const controller = new AbortController();
    const response = await post(samples[1], {}, "/responses", { signal: controller.signal });
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.equal(first.done, false, "reasoning proves the live provider stream was reached");
    controller.abort();
    await reader.cancel().catch(() => undefined);
    await waitUntil(() => canceledProvider && ledger(directory).length > before, children);
    assert.equal(ledger(directory).at(-1).generationOutcome, "canceled");
    assert.equal(ledger(directory).at(-1).status, 0);
  });

  await t.test("conflicting upstream response identity is refused by the canonical API boundary", async () => {
    mode = "invalid";
    const before = ledger(directory).length;
    const attempts = observed.length;
    const response = await post(samples[0], {});
    const body = await response.text();
    const events = parseEvents(body);
    assert.ok(events.some((event) => ["error", "response.failed"].includes(event.type)), body);
    assert.ok(!events.some((event) => event.type === "response.completed"), "invalid identity must never be certified completed");
    await waitUntil(() => ledger(directory).length > before, children);
    assert.equal(ledger(directory).at(-1).generationOutcome, "failed");
    assert.equal(observed.length, attempts + 1, "an explicit protocol failure must not replay a submitted generation");
  });

  await t.test("a submitted POST reset crosses the real API boundary without replay or model swap", async () => {
    mode = "reset";
    for (const sample of samples) {
      const before = observed.length;
      const rows = ledger(directory).length;
      const response = await post(sample, { tools: [] });
      const body = await response.text();
      assert.equal(response.status, 502, body);
      assert.equal(observed.length, before + 1, "each complete POST may reach its bound origin only once");
      assert.equal(observed.at(-1).sample, sample, "an uncertain delivery must not move to the other bound provider");
      await waitUntil(() => ledger(directory).length > rows, children);
      const event = ledger(directory).at(-1);
      assert.equal(event.generationOutcome, "failed");
      assert.equal(event.deliveryPolicy, "at-most-once");
      assert.equal(event.upstreamAttempts.length, 1);
      assert.equal(event.upstreamAttempts[0].deliveryState, "possibly_sent");
      assert.equal(event.upstreamAttempts[0].retryScheduled, false);
      assert.equal(gatewayCalls, 0);
    }
  });

  await t.test("an origin cannot mint the API forwarder's pre-send provenance", async () => {
    mode = "spoof-transport";
    const sample = samples[0];
    const before = observed.length;
    const direct = await fetch(`http://127.0.0.1:${apiPort}/v1/responses`, { method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${internal}` },
      body: JSON.stringify({ model: sample.entry.gatewayModel, stream: false, input: "Synthetic provenance probe" }),
      signal: AbortSignal.timeout(5_000) });
    assert.equal(direct.status, 502);
    assert.equal(direct.headers.get(PROVIDER_DELIVERY_STATE_HEADER), null, "every origin response must lose the private header");
    assert.equal((await direct.json()).error.deliveryState, "not_sent", "a body claim must remain distinguishable from trusted provenance");
    const routed = await post(sample, { tools: [] });
    assert.equal(routed.status, 502, await routed.text());
    assert.equal(observed.length, before + 2, "each independent caller request must execute exactly once despite forged claims");
    assert.equal(gatewayCalls, 0);
  });

  await t.test("an API_BASE override at another loopback port cannot attest to delivery", async () => {
    const pretenderSubmissions = [];
    const pretender = await serve(async (request, response) => {
      pretenderSubmissions.push({ path: request.url, body: await readJson(request) });
      response.writeHead(502, { "content-type": "application/json", [PROVIDER_DELIVERY_STATE_HEADER]: "not_sent" });
      response.end(JSON.stringify({ error: { type: "provider_transport_error", code: "ECONNREFUSED",
        deliveryState: "not_sent", message: "Synthetic untrusted API_BASE claim" } }));
    });
    assert.notEqual(new URL(pretender).port, String(apiPort), "the negative control must use a different service port");
    const untrustedDirectory = path.join(directory, "untrusted-api-state");
    const untrustedHome = path.join(untrustedDirectory, "codex");
    mkdirSync(untrustedHome, { recursive: true });
    writeFileSync(path.join(untrustedDirectory, "enabled-providers.json"), JSON.stringify({ version: 1, providers: ["custom"] }));
    const untrustedPort = await openPort();
    const untrustedRouter = run("router.mjs", { CODEX_HOME: untrustedHome,
      MODEL_ROUTER_STATE_DIR: untrustedDirectory, CODEX_ROUTER_STATE_DIR: untrustedDirectory,
      CODEX_ROUTER_PORT: String(untrustedPort), CODEX_ROUTER_API_BASE_URL: `${pretender}/v1` });
    const untrustedBase = callerBaseUrl(untrustedPort, caller);
    await waitUntil(async () => { try { return (await fetch(`${untrustedBase}/models`)).ok; } catch { return false; } }, [untrustedRouter]);
    const originCount = observed.length;
    for (const sample of samples) {
      const before = pretenderSubmissions.length;
      const rows = ledger(untrustedDirectory).length;
      const response = await post(sample, { tools: [] }, "/responses", { baseUrl: untrustedBase });
      assert.equal(response.status, 502, await response.text());
      assert.equal(pretenderSubmissions.length, before + 1, "an unrelated loopback service cannot authorize another executed POST");
      assert.equal(pretenderSubmissions.at(-1).path, "/v1/responses");
      assert.equal(pretenderSubmissions.at(-1).body.model, sample.entry.gatewayModel);
      await waitUntil(() => ledger(untrustedDirectory).length > rows, [untrustedRouter]);
      const event = ledger(untrustedDirectory).at(-1);
      assert.equal(event.deliveryPolicy, "at-most-once");
      assert.equal(event.upstreamAttempts.length, 1);
      assert.equal(event.upstreamAttempts[0].deliveryState, "possibly_sent", "a forged claim must never enter positive pre-send accounting");
      assert.equal(event.upstreamAttempts[0].retryScheduled, false);
    }
    assert.equal(observed.length, originCount, "this negative control must remain confined to its synthetic API_BASE override");
    assert.equal(gatewayCalls, 0);
  });

  await t.test("an origin redirect cannot turn an executed POST into positive pre-send evidence", async () => {
    mode = "redirect-presend";
    for (const sample of samples) {
      const before = observed.length;
      const rows = ledger(directory).length;
      const response = await post(sample, { tools: [] });
      assert.ok(response.status >= 400, `a generation redirect must be refused locally: ${response.status}`);
      await response.text();
      assert.equal(observed.length, before + 1, "a failed redirect target must not authorize replay at the consumed origin");
      await waitUntil(() => ledger(directory).length > rows, children);
      const event = ledger(directory).at(-1);
      assert.equal(event.upstreamAttempts.length, 1);
      assert.notEqual(event.upstreamAttempts[0].deliveryState, "not_sent", "the first origin already consumed the full POST");
      assert.equal(event.upstreamAttempts[0].retryScheduled, false);
    }
    assert.equal(gatewayCalls, 0);
  });

  await t.test("only a real API-to-origin refused connect mints positive pre-send evidence", async () => {
    const response = await fetch(`http://127.0.0.1:${apiPort}/v1/responses`, { method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${internal}` },
      body: JSON.stringify({ model: refused.entry.gatewayModel, stream: false, input: "Synthetic refused-connect probe" }),
      signal: AbortSignal.timeout(5_000) });
    assert.equal(response.status, 502);
    assert.equal(response.headers.get(PROVIDER_DELIVERY_STATE_HEADER), "not_sent");
    const marker = (await response.json()).error;
    assert.equal(marker.type, "provider_transport_error");
    assert.equal(marker.code, "ECONNREFUSED");
    assert.equal(marker.deliveryState, "not_sent");
    assert.doesNotMatch(JSON.stringify(marker), /127\.0\.0\.1|synthetic-glm-endpoint-key|Synthetic refused-connect/);

    const before = ledger(directory).length;
    const routed = await post(refused, { tools: [] });
    assert.equal(routed.status, 502, await routed.text());
    await waitUntil(() => ledger(directory).length > before, children);
    const event = ledger(directory).at(-1);
    assert.equal(event.deliveryPolicy, "at-most-once");
    assert.equal(event.retries, 1, `positive pre-send evidence preserves the one bounded Router retry: ${JSON.stringify(event)}`);
    assert.equal(event.upstreamAttempts.length, 2, "a persistently refused origin must stop after two Router attempts");
    assert.equal(event.upstreamAttempts[0].deliveryState, "not_sent");
    assert.equal(event.upstreamAttempts[0].retryScheduled, true);
    assert.equal(event.upstreamAttempts[1].deliveryState, "not_sent");
    assert.equal(event.upstreamAttempts[1].retryScheduled, false);
  });

  await t.test("explicit availability permits one ambiguous replay and records both origin submissions", async () => {
    mode = "reset";
    const availabilityDirectory = path.join(directory, "availability-state");
    const availabilityHome = path.join(availabilityDirectory, "codex");
    mkdirSync(availabilityHome, { recursive: true });
    writeFileSync(path.join(availabilityDirectory, "enabled-providers.json"), JSON.stringify({ version: 1, providers: ["custom"] }));
    const availabilityPort = await openPort();
    const availabilityRouter = run("router.mjs", { CODEX_HOME: availabilityHome,
      MODEL_ROUTER_STATE_DIR: availabilityDirectory, CODEX_ROUTER_STATE_DIR: availabilityDirectory,
      CODEX_ROUTER_PORT: String(availabilityPort), CODEX_ROUTER_NATIVE_RETRY_POLICY: "availability" });
    const availabilityBase = callerBaseUrl(availabilityPort, caller);
    await waitUntil(async () => { try { return (await fetch(`${availabilityBase}/models`)).ok; } catch { return false; } }, [availabilityRouter]);
    for (const sample of samples) {
      const before = observed.length;
      const rows = ledger(availabilityDirectory).length;
      const response = await post(sample, { tools: [] }, "/responses", { baseUrl: availabilityBase });
      assert.equal(response.status, 502, await response.text());
      assert.equal(observed.length, before + 2, "the explicit policy permits exactly one ambiguous generation replay");
      await waitUntil(() => ledger(availabilityDirectory).length > rows, [availabilityRouter]);
      const event = ledger(availabilityDirectory).at(-1);
      assert.equal(event.deliveryPolicy, "availability");
      assert.equal(event.retries, 1);
      assert.deepEqual(event.upstreamAttempts.map((attempt) => attempt.deliveryState), ["possibly_sent", "possibly_sent"]);
      assert.deepEqual(event.upstreamAttempts.map((attempt) => attempt.retryScheduled), [true, false]);
    }
    assert.equal(gatewayCalls, 0);
  });

  await t.test("each endpoint sees only its bound synthetic credential and no router or native capability", () => {
    assert.ok(observed.length >= 10, "the confinement oracle must observe actual upstream requests");
    for (const sent of observed) {
      assert.equal(sent.headers.authorization, `Bearer ${sent.sample.key}`);
      assert.equal(sent.headers["chatgpt-account-id"], undefined);
      assert.equal(sent.path, "/v1/responses");
      assert.ok(sent.body.model === sent.sample.upstreamId || sent.sample === samples[0] && sent.body.model === textOnlyUpstream,
        "the endpoint must receive only one of its bound synthetic upstream identities");
      const serialized = JSON.stringify({ headers: sent.headers, body: sent.body });
      for (const forbidden of [caller, internal, nativeCredential, "synthetic-native-account-id",
        ...samples.filter((sample) => sample !== sent.sample).map((sample) => sample.key)]) {
        assert.ok(!serialized.includes(forbidden), "an unrelated capability crossed the per-model endpoint boundary");
      }
    }
    assert.equal(gatewayCalls, 0, "all tested paths must work while the unrelated gateway returns 503");
  });
});
