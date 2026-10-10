import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import { handleResponsesWebSocketUpgrade } from "../src/responses-websocket.mjs";
import { userModelEntry } from "../src/user-models.mjs";
import { openPort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const caller = "synthetic-graceful-ws-caller-capability";
const internal = "synthetic-graceful-ws-internal-capability";
const nativeCredential = "synthetic-graceful-ws-native-credential";
const responseId = "resp_synthetic_shutdown";
const messageId = "msg_synthetic_shutdown";
const answer = "Synthetic final answer survives an IPC drain.";
const frame = (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function within(promise, milliseconds, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  })]); } finally { clearTimeout(timer); }
}

function observeBody(response) {
  let text = "";
  let firstByte;
  const first = new Promise((resolve) => { firstByte = resolve; });
  const done = new Promise((resolve, reject) => {
    response.setEncoding("utf8");
    response.on("data", (chunk) => { text += chunk; firstByte(); });
    response.once("end", () => resolve(text));
    response.once("error", reject);
  });
  // Attach a handler before shutdown can abort a stream, without swallowing the
  // assertion's eventual rejection.
  void done.catch(() => {});
  return { first, done };
}

function events(text) {
  return text.split(/\r?\n\r?\n/).flatMap((block) => {
    const data = block.split(/\r?\n/).find((line) => line.startsWith("data: "))?.slice(6);
    return data && data !== "[DONE]" ? [JSON.parse(data)] : [];
  });
}

test("IPC shutdown drains real upstream WebSocket turns and closes their pools before natural exit", { timeout: 45_000 }, async (t) => {
  for (const service of ["native Router", "generic API forwarder"]) {
    for (const outcome of ["completed during drain", "held through drain deadline", "awaiting first provider event", "awaiting event without disconnect cleanup"]) {
      await t.test(`${service}: ${outcome}`, { timeout: 10_000 }, async (subtest) => {
        const directory = mkdtempSync(path.join(os.tmpdir(), "graceful-ws-shutdown-"));
        const codexHome = path.join(directory, "codex");
        mkdirSync(codexHome);
        const sockets = new Set();
        let upgrades = 0;
        let submitted;
        let providerResponse;
        const turnArrived = new Promise((resolve) => { submitted = resolve; });
        let closed;
        const socketClosed = new Promise((resolve) => { closed = resolve; });
        let rawHttpCalls = 0;
        const awaitingEvent = outcome.startsWith("awaiting");
        const provider = http.createServer(async (request, response) => {
          if (request.method !== "POST" || request.url !== "/v1/responses") {
            rawHttpCalls += 1;
            response.writeHead(503).end("Synthetic forbidden HTTP fallback");
            return;
          }
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          const body = JSON.parse(Buffer.concat(chunks));
          providerResponse = response;
          if (awaitingEvent) { submitted(body); return; }
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write(frame({ type: "response.created", sequence_number: 0,
            response: { id: responseId, object: "response", created_at: 1, status: "in_progress", output: [] } }));
          response.write(frame({ type: "response.output_item.added", sequence_number: 1, output_index: 0,
            item: { id: messageId, type: "message", role: "assistant", status: "in_progress", content: [] } }));
          response.write(frame({ type: "response.output_text.delta", sequence_number: 2,
            output_index: 0, item_id: messageId, content_index: 0, delta: answer }));
          submitted(body);
        });
        await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
        const providerPort = provider.address().port;
        provider.on("upgrade", (request, socket, head) => {
          upgrades += 1;
          sockets.add(socket);
          socket.once("close", () => { sockets.delete(socket); closed(); });
          handleResponsesWebSocketUpgrade(request, socket, head, {
            callerKey: "synthetic-provider-unused-caller",
            authenticateUpgrade: () => "/v1/responses",
            responsesUrl: `http://127.0.0.1:${providerPort}/v1/responses`,
          });
        });
        const generic = service === "generic API forwarder";
        const model = userModelEntry({ providerId: "shutdown-ws", upstreamId: "synthetic-ws-model", priority: 100 });
        writeFileSync(path.join(directory, "generic-providers.json"), JSON.stringify({ version: 1,
          providers: [{ id: "shutdown-ws", displayName: "Synthetic shutdown provider",
            baseUrl: `http://127.0.0.1:${providerPort}/v1`, adapter: "openai-responses", transport: "websocket",
            headers: { "X-Tenant": "synthetic-owned-provider" }, allowPrivate: true, enabled: true }] }));
        writeFileSync(path.join(directory, "user-models.json"), JSON.stringify({ version: 1, models: generic ? [model] : [] }));
        writeFileSync(path.join(directory, "enabled-providers.json"), JSON.stringify({ version: 1, providers: generic ? ["shutdown-ws"] : [] }));
        const port = await openPort();
        const env = { ...process.env };
        for (const name of Object.keys(env)) {
          if (/^(MODEL_ROUTER_|CODEX_ROUTER_|ROUTER_PLANE_)/.test(name) || /^(https?|all|no)_proxy$/i.test(name)) delete env[name];
        }
        Object.assign(env, { CODEX_HOME: codexHome, MODEL_ROUTER_STATE_DIR: directory, CODEX_ROUTER_STATE_DIR: directory,
          MODEL_ROUTER_USER_MODELS: path.join(directory, "user-models.json"),
          MODEL_ROUTER_GENERIC_PROVIDERS: path.join(directory, "generic-providers.json"),
          CODEX_ROUTER_PORT: String(port), MODEL_ROUTER_API_PORT: String(port), CODEX_ROUTER_API_PORT: String(port),
          CODEX_ROUTER_INTERNAL_KEY: internal, MODEL_ROUTER_INTERNAL_KEY: internal, KIMI_INTERNAL_KEY: internal,
          CODEX_ROUTER_CALLER_KEY: caller, CODEX_ROUTER_QUIET: "1", CODEX_ROUTER_NO_DISCOVERY: "0",
          CODEX_ROUTER_SHOW_ALL_MODELS: "1", NODE_USE_ENV_PROXY: "0",
          MODEL_ROUTER_SHUTDOWN_DRAIN_MS: outcome === "completed during drain" ? "1000" : "100",
          CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${providerPort}/backend-api/codex`,
          CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${providerPort}/forbidden-gateway`,
          MODEL_ROUTER_NATIVE_TRANSPORT: "websocket" });
        const script = path.join(root, "src", generic ? "api-forwarder.mjs" : "router.mjs");
        const removeCleanup = outcome === "awaiting event without disconnect cleanup";
        const sourceUrl = pathToFileURL(script).href;
        // Load the real service and all its normal dependencies. The negative
        // control removes only the disconnect hook in this owned process;
        // neither the repository file nor the production runtime is edited.
        const negativeEntry = `
          import { registerHooks } from "node:module";
          registerHooks({ load(url, context, nextLoad) {
            const result = nextLoad(url, context);
            if (url !== ${JSON.stringify(sourceUrl)}) return result;
            const source = Buffer.from(result.source).toString();
            const changed = source.replace(/^process\\.once\\("disconnect", \\(\\) => (nativeWsPools|genericProviderPools)\\.closeAll\\(\\)\\);\\r?$/m, "");
            if (changed === source) throw new Error("The disconnect-hook negative control did not apply.");
            return { ...result, source: changed };
          }});
          await import(${JSON.stringify(sourceUrl)});
        `;
        const child = spawn(process.execPath, removeCleanup ? ["--input-type=module", "-e", negativeEntry] : [script], {
          cwd: root, env, stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true,
        });
        let errors = "";
        child.stderr.on("data", (chunk) => { errors += chunk; });
        const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
        subtest.after(async () => {
          if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
          for (const socket of sockets) socket.destroy();
          provider.closeAllConnections();
          await new Promise((resolve) => provider.close(resolve));
          const resolved = path.resolve(directory);
          assert.ok(resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) &&
            path.basename(resolved).startsWith("graceful-ws-shutdown-"), "cleanup must stay inside the owned fixture");
          rmSync(resolved, { recursive: true, force: true });
        });
        const healthUrl = generic ? `http://127.0.0.1:${port}/health` : `${callerBaseUrl(port, caller)}/models`;
        const deadline = Date.now() + 5_000;
        for (;;) {
          assert.equal(child.exitCode, null, errors);
          try {
            const response = await fetch(healthUrl, { headers: { authorization: `Bearer ${internal}` }, signal: AbortSignal.timeout(500) });
            await response.arrayBuffer();
            if (response.ok) break;
          } catch { /* The owned listener may still be starting. */ }
          assert.ok(Date.now() < deadline, `fixture did not start: ${errors}`);
          await delay(25);
        }
        const target = new URL(generic ? `http://127.0.0.1:${port}/v1/responses` : `${callerBaseUrl(port, caller)}/responses`);
        const payload = JSON.stringify({ model: generic ? model.gatewayModel : "gpt-6.1-sol", stream: true,
          input: [{ type: "message", role: "user", content: "Synthetic graceful WebSocket generation" }] });
        const pending = new Promise((resolve, reject) => {
          const request = http.request(target, { method: "POST", agent: false,
            headers: { "content-type": "application/json", authorization: `Bearer ${generic ? internal : nativeCredential}` } }, resolve);
          request.once("error", reject);
          request.end(payload);
        });
        let response;
        let body;
        if (!awaitingEvent) {
          response = await within(pending, 3_000, `provider response did not begin: ${errors}`);
          body = observeBody(response);
          await within(body.first, 3_000, "the real WebSocket turn never reached the caller");
        }
        const submittedBody = await within(turnArrived, 3_000, "no complete upstream WebSocket request");
        assert.equal(submittedBody.model, generic ? "synthetic-ws-model" : "gpt-6.1-sol");
        assert.equal(upgrades, 1, "the tested service must acquire one actual upstream WebSocket");
        assert.equal(sockets.size, 1, "the generation must still own an open upstream socket at shutdown");
        await new Promise((resolve, reject) => child.send({ type: "model-router:shutdown" }, (error) => error ? reject(error) : resolve()));
        const drainDeadline = Date.now() + 2_000;
        while (!errors.includes("shutting down with") && Date.now() < drainDeadline) await delay(5);
        assert.match(errors, /shutting down with 1 request\(s\) in flight/);
        if (outcome === "completed during drain") {
          assert.equal(sockets.size, 1, "IPC must not close a leased upstream socket before the HTTP drain finishes");
          const item = { id: messageId, type: "message", role: "assistant", status: "completed",
            content: [{ type: "output_text", text: answer, annotations: [] }] };
          providerResponse.write(frame({ type: "response.output_item.done", sequence_number: 3, output_index: 0, item }));
          providerResponse.end(frame({ type: "response.completed", sequence_number: 4,
            response: { id: responseId, object: "response", status: "completed", output: [item],
              usage: { input_tokens: 4, output_tokens: 8, total_tokens: 12 } } }));
        }
        if (awaitingEvent) {
          response = await within(pending, 3_000, `IPC did not answer the pending prelude: ${errors}`);
          body = observeBody(response);
        }
        const text = await within(body.done, 3_000, "IPC drain reset or held the caller response");
        assert.equal(response.complete, true, "the HTTP response must reach clean EOF");
        const output = awaitingEvent ? [] : events(text);
        if (awaitingEvent) {
          assert.equal(response.statusCode, 503);
          assert.equal(JSON.parse(text).error.type, "local_router_restarting");
          assert.match(text, /restarting/);
        } else if (outcome === "completed during drain") {
          assert.ok(output.some((event) => event.type === "response.completed"), text);
          assert.ok(!output.some((event) => event.type === "error" || event.type === "response.failed"), text);
        } else {
          assert.ok(output.some((event) => event.type === "error" || event.type === "response.failed"), text);
          assert.ok(!output.some((event) => event.type === "response.completed"), text);
          assert.match(text, /restarting/);
        }
        if (removeCleanup) {
          const exitedNaturally = await Promise.race([exited.then(() => true), delay(500).then(() => false)]);
          assert.equal(exitedNaturally, false, "the negative control must expose the referenced leased socket");
          assert.equal(sockets.size, 1, "removing cleanup must retain the real upstream socket after caller EOF");
        } else {
          assert.deepEqual(await within(exited, 2_000, `the drained process retained a leased WebSocket: ${errors}`), { code: 0, signal: null });
          await within(socketClosed, 1_000, "natural shutdown did not close the upstream WebSocket");
          assert.equal(sockets.size, 0);
        }
        assert.equal(rawHttpCalls, 0, "these assertions must not pass through HTTP fallback or another gateway");
      });
    }
  }
});
