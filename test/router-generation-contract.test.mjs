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
import { aggregateProviderUsage } from "../src/provider-usage.mjs";
import { openPort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const caller = "synthetic-generation-contract-caller-capability";
const internal = "synthetic-generation-contract-internal-capability";
const frame = (e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
const example = "The XML example is `<reason>disk full</reason>`; x < and <th";
function frames(body) {
  return body.split(/\r?\n\r?\n/).map((block) => block.split(/\r?\n/).find((l) => l.startsWith("data:")))
    .filter(Boolean).map((line) => JSON.parse(line.slice(5)));
}
function ledger(directory) {
  const file = path.join(directory, "usage-events.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
}
async function waitUntil(predicate, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`isolated Router exited: ${child.testErrors()}`);
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`isolated Router wait timed out: ${child.testErrors()}`);
}

test("real Router and API forwarder preserve content and outcomes without a gateway", async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "router-generation-contract-"));
  const codexHome = path.join(temp, "codex");
  mkdirSync(codexHome);
  let terminal = "completed";
  let calls = 0;
  const upstream = http.createServer(async (request, response) => {
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true,"credential_present":true}');
      return;
    }
    for await (const _chunk of request) { /* consume synthetic input */ }
    calls += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    const initial = { id: `r_${calls}`, object: "response", status: "in_progress", output: [] };
    const item = { id: `msg_${calls}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: example, annotations: [] }] };
    const events = [
      { type: "response.created", response: initial },
      { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
      { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: example },
    ];
    if (terminal !== "eof") events.push(
      { type: "response.output_text.done", output_index: 0, content_index: 0, item_id: item.id, text: example },
      { type: "response.content_part.done", output_index: 0, content_index: 0, part: item.content[0] },
      { type: "response.output_item.done", output_index: 0, item },
      { type: terminal === "embedded-failure" ? "response.completed" : `response.${terminal}`,
        response: { ...initial, status: terminal === "embedded-failure" ? "failed" : terminal,
          output: [item], usage: { input_tokens: 50, output_tokens: 10 },
          ...(terminal === "failed" ? { error: { code: "synthetic_failure", message: "synthetic only" } } : {}),
        },
      },
    );
    response.end(events.map(frame).join(""));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;
  const entry = { ...userModelEntry({ providerId: "custom", upstreamId: "grok-4.6-synthetic-contract", priority: 999, metadata: {} }),
    endpoint: { baseUrl: `${upstreamBase}/v1`, protocol: "openai-responses", keyless: true } };
  writeFileSync(path.join(temp, "user-models.json"), JSON.stringify({ version: 1, models: [entry] }));
  writeFileSync(path.join(temp, "enabled-providers.json"), JSON.stringify({ version: 1, providers: ["custom"] }));
  const port = await openPort();
  const apiPort = await openPort();
  let gatewayCalls = 0;
  const unusedGateway = http.createServer((_request, response) => {
    gatewayCalls += 1;
    response.writeHead(503).end("negative control: gateway must not be used");
  });
  await new Promise((resolve) => unusedGateway.listen(0, "127.0.0.1", resolve));
  const gatewayBase = `http://127.0.0.1:${unusedGateway.address().port}`;
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(MODEL_ROUTER_|CODEX_ROUTER_|ROUTER_PLANE_)/.test(key)) delete env[key];
  Object.assign(env, { CODEX_HOME: codexHome, MODEL_ROUTER_STATE_DIR: temp, CODEX_ROUTER_STATE_DIR: temp,
    MODEL_ROUTER_USER_MODELS: path.join(temp, "user-models.json"),
    CODEX_ROUTER_PORT: String(port), CODEX_ROUTER_CALLER_KEY: caller, CODEX_ROUTER_INTERNAL_KEY: internal,
    KIMI_INTERNAL_KEY: internal, CODEX_ROUTER_GATEWAY_BASE_URL: `${gatewayBase}/v1`,
    CODEX_ROUTER_API_PORT: String(apiPort),
    CODEX_ROUTER_API_BASE_URL: `http://127.0.0.1:${apiPort}/v1`, CODEX_NATIVE_BASE_URL: upstreamBase,
    CODEX_ROUTER_GATEWAY_HEALTH_URL: `${gatewayBase}/health`, CODEX_ROUTER_API_HEALTH_URL: `http://127.0.0.1:${apiPort}/health`,
    CODEX_ROUTER_NO_DISCOVERY: "0", CODEX_ROUTER_SHOW_ALL_MODELS: "1", CODEX_ROUTER_QUIET: "1",
  });
  const api = spawn(process.execPath, [path.join(root, "src/api-forwarder.mjs")], { cwd: root, env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let apiErrors = "";
  api.stderr.on("data", (chunk) => { apiErrors += chunk; });
  api.testErrors = () => apiErrors;
  const child = spawn(process.execPath, [path.join(root, "src/router.mjs")], { cwd: root, env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let errors = "";
  child.stderr.on("data", (chunk) => { errors += chunk; });
  child.testErrors = () => errors;
  const base = callerBaseUrl(port, caller);
  try {
    await waitUntil(async () => { try { return (await fetch(`http://127.0.0.1:${apiPort}/health`, { headers: { authorization: `Bearer ${internal}` } })).ok; } catch { return false; } }, api);
    await waitUntil(async () => { try { return (await fetch(`${base}/models`)).ok; } catch { return false; } }, child);
    let count = 0;
    for (const model of [entry.slug, "gpt-6.1-sol"]) {
      for (const [kind, outcome] of [["completed", "completed"], ["failed", "failed"], ["incomplete", "incomplete"], ["embedded-failure", "failed"], ["eof", "indeterminate"]]) {
        terminal = kind;
        const response = await fetch(`${base}/responses`, { method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer synthetic-native-session" },
          body: JSON.stringify({ model, stream: true, input: "Synthetic local regression only", tools: [] }),
          signal: AbortSignal.timeout(10_000),
        });
        const body = await response.text();
        assert.equal(response.status, 200, body);
        const events = frames(body);
        assert.equal(events.filter((e) => e.type === "response.output_text.delta").map((e) => e.delta).join(""), example);
        if (kind !== "eof") assert.equal(events.find((e) => e.type === "response.output_item.done").item.content[0].text, example);
        await waitUntil(() => ledger(temp).length > count, child);
        count += 1;
        const event = ledger(temp).at(-1);
        assert.equal(event.httpStatus, 200);
        // The canonical API forwarder rejects an EOF without a terminal frame
        // and explicitly reports that protocol failure. A native clean EOF is
        // still unknown, since no semantic terminal has certified its result.
        const expectedOutcome = model === entry.slug && kind === "eof" ? "failed" : outcome;
        assert.equal(event.generationOutcome, expectedOutcome, `${model}/${kind}`);
        if (model === entry.slug && kind === "eof") {
          assert.ok(events.some((e) => ["response.failed", "error"].includes(e.type)), "canonical frame validation must remain active");
        }
        assert.ok(Number.isInteger(event.ingressMs) && event.ingressMs >= 0);
        assert.ok(Number.isInteger(event.preparationMs) && event.preparationMs >= 0);
        assert.ok(Number.isInteger(event.upstreamHeadersMs) && event.upstreamHeadersMs >= 0);
        if (kind !== "eof") {
          assert.equal(event.inputTokens, 50, "failed generation tokens still count");
          assert.equal(event.outputTokens, 10);
        }
        const activity = await (await fetch(`${base}/activity`)).json();
        const recent = activity.recent.find((e) => e.requestId === event.requestId);
        assert.equal(recent.generationOutcome, expectedOutcome, "activity and billing disagree");
        assert.equal(recent.httpStatus, event.httpStatus);
      }
    }
    const totals = aggregateProviderUsage(ledger(temp)).providers;
    assert.equal(totals.find((p) => p.id === "custom").successfulRequests, 1);
    assert.equal(totals.find((p) => p.id === "openai").successfulRequests, 1);
    assert.equal(calls, count, "none of these semantic terminals should replay");
    assert.equal(gatewayCalls, 0, "native Responses must not acquire a Python/gateway dependency");
  } finally {
    for (const ownedChild of [child, api]) {
      if (ownedChild.exitCode === null && ownedChild.signalCode === null) {
        ownedChild.kill("SIGTERM");
        await new Promise((resolve) => ownedChild.once("exit", resolve));
      }
    }
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    unusedGateway.closeAllConnections();
    await new Promise((resolve) => unusedGateway.close(resolve));
    rmSync(temp, { recursive: true, force: true });
  }
});
