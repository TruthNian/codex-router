import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PROVIDERS } from "../src/model-registry.mjs";
import { classifyRoutedFailure } from "../src/model-failover.mjs";
import { PROVIDER_DELIVERY_STATE_HEADER } from "../src/transport-failure.mjs";
import { openPort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const internalKey = "synthetic-delivery-proof-service-capability-123456";

test("only the local forwarder's own transport failure mints delivery evidence", async () => {
  const provider = PROVIDERS.get("deepseek");
  assert.equal(typeof provider?.baseUrlEnv, "string", "the fixture must control the exact provider endpoint");
  let mode = "spoof";
  let executed = 0;
  const origin = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume the actual POST */ }
    executed += 1;
    if (mode === "reset") return request.socket.destroy();
    response.writeHead(500, { "Content-Type": "application/json", [PROVIDER_DELIVERY_STATE_HEADER]: "not_sent" });
    response.end(JSON.stringify({ error: { type: "provider_transport_error", code: "ECONNREFUSED", deliveryState: "not_sent" } }));
  });
  await new Promise((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const originPort = origin.address().port;
  const port = await openPort();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "provider-delivery-proof-"));
  const child = spawn(process.execPath, [path.join(root, "src/api-forwarder.mjs")], {
    cwd: root,
    env: { ...process.env, MODEL_ROUTER_STATE_DIR: stateDir, MODEL_ROUTER_API_PORT: String(port),
      MODEL_ROUTER_INTERNAL_KEY: internalKey, MODEL_ROUTER_QUIET: "1",
      DEEPSEEK_API_KEY: "synthetic-provider-key", [provider.baseUrlEnv]: `http://127.0.0.1:${originPort}/v1` },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let errors = "";
  child.stderr.setEncoding("utf8").on("data", (part) => { errors += part; });
  const headers = { Authorization: `Bearer ${internalKey}`, "Content-Type": "application/json" };
  const post = () => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST", headers,
    body: JSON.stringify({ model: "deepseek-v4-pro", stream: false, messages: [{ role: "user", content: "synthetic input" }] }),
  });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 200 && !ready; attempt += 1) {
      if (child.exitCode !== null) throw new Error(errors);
      try { ready = (await fetch(`http://127.0.0.1:${port}/health`, { headers })).ok; } catch {}
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(ready, true, errors);
    const spoof = await post();
    const spoofText = await spoof.text();
    assert.equal(spoof.status, 500, spoofText);
    assert.equal(spoof.headers.get(PROVIDER_DELIVERY_STATE_HEADER), null);
    assert.equal(classifyRoutedFailure({ status: spoof.status, bodyText: spoofText }).swap, false);
    assert.equal(executed, 1);

    mode = "reset";
    const reset = await post();
    const resetText = await reset.text();
    assert.equal(reset.status, 502, resetText);
    assert.equal(reset.headers.get(PROVIDER_DELIVERY_STATE_HEADER), "possibly_sent");
    assert.equal(classifyRoutedFailure({ status: reset.status, bodyText: resetText,
      trustedDeliveryState: reset.headers.get(PROVIDER_DELIVERY_STATE_HEADER) }).swap, false);
    assert.equal(executed, 2, "an executed generation is submitted once");

    origin.closeAllConnections();
    await new Promise((resolve) => origin.close(resolve));
    const refused = await post();
    const refusedText = await refused.text();
    assert.equal(refused.status, 502, refusedText);
    assert.equal(refused.headers.get(PROVIDER_DELIVERY_STATE_HEADER), "not_sent");
    assert.equal(classifyRoutedFailure({ status: refused.status, bodyText: refusedText }).swap, false);
    assert.equal(classifyRoutedFailure({ status: refused.status, bodyText: refusedText,
      trustedDeliveryState: refused.headers.get(PROVIDER_DELIVERY_STATE_HEADER) }).swap, true);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    if (origin.listening) {
      origin.closeAllConnections();
      await new Promise((resolve) => origin.close(resolve));
    }
    rmSync(stateDir, { recursive: true, force: true });
  }
});
