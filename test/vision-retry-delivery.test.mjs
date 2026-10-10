import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { describeImage, localVisionEngine } from "../src/vision-bridge.mjs";
import { PROVIDER_DELIVERY_STATE_HEADER } from "../src/transport-failure.mjs";

const imageUrl = "data:image/png;base64,c3ludGhldGljLWltYWdl";
const registryEngine = {
  slug: "custom/synthetic-vision", gatewayModel: "synthetic-vision", displayName: "Synthetic vision",
  inputModalities: ["text", "image"],
};

async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  return server.address().port;
}

async function close(server) {
  server.closeAllConnections();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
}

function successfulResponse(response, shape) {
  if (shape === "local") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "## Summary\nSynthetic evidence." } }] }));
  } else if (shape === "native") {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "## Summary\nSynthetic evidence." }] },
    ] } })}\n\n`);
  } else {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ output: [{ type: "message", role: "assistant", content: [
      { type: "output_text", text: "## Summary\nSynthetic evidence." },
    ] }] }));
  }
}

function callOptions(base, shape) {
  return {
    engine: shape === "local" ? localVisionEngine({ local: { model: "synthetic-local", baseUrl: `${base}/v1` } }) :
      { ...registryEngine, ...(shape === "native" ? { native: true } : {}) },
    imageUrl,
    gatewayBase: `${base}/unused-gateway`,
    responsesTarget: `${base}/v1/responses`,
    headers: { "Content-Type": "application/json", Authorization: "Bearer synthetic-internal-capability" },
    nativeCall: { baseUrl: `${base}/native`, headers: { Authorization: "Bearer synthetic-native-session" } },
    timeoutMs: 2_000,
    retryDelaysMs: [1, 1],
  };
}

test("vision POST delivery policy uses real local sockets for all three call shapes", async (t) => {
  for (const shape of ["registry", "native", "local"]) {
    for (const failure of ["reset", "503"]) {
      for (const deliveryPolicy of ["at-most-once", "availability"]) {
        await t.test(`${shape}: ${failure}, ${deliveryPolicy}`, async () => {
          const received = [];
          const server = http.createServer(async (request, response) => {
            const chunks = [];
            for await (const chunk of request) chunks.push(chunk);
            received.push({ url: request.url, body: Buffer.concat(chunks).toString("utf8") });
            // This records a complete generation POST before failure. There is
            // deliberately no client byte proving whether it executed.
            if (received.length === 1) {
              if (failure === "reset") { request.socket.destroy(); return; }
              response.writeHead(503, { "Content-Type": "application/json" });
              response.end(JSON.stringify({ error: { message: "synthetic-private-provider-error" } }));
              return;
            }
            successfulResponse(response, shape);
          });
          const port = await listen(server);
          try {
            const call = describeImage({ ...callOptions(`http://127.0.0.1:${port}`, shape), deliveryPolicy });
            if (deliveryPolicy === "availability") {
              assert.match(await call, /Synthetic evidence/);
              assert.equal(received.length, 2, "the explicit policy permits one ambiguous replay");
              assert.equal(received[0].body, received[1].body);
            } else {
              await assert.rejects(call, (error) => {
                assert.doesNotMatch(error.message, /synthetic-private-provider-error/);
                assert.equal(error.retryable, false);
                assert.equal(error.deliveryState, failure === "reset" ? "possibly_sent" : "response_started");
                return true;
              });
              assert.equal(received.length, 1, "an accepted POST must not be silently replayed");
            }
            const body = JSON.parse(received[0].body);
            assert.equal(body.model, shape === "local" ? "synthetic-local" : "synthetic-vision");
            assert.ok(received.every(({ url }) => url === (shape === "local" ? "/v1/chat/completions" :
              shape === "native" ? "/native/responses" : "/v1/responses")));
            assert.ok(received[0].body.includes(imageUrl));
          } finally {
            await close(server);
          }
        });
      }
    }
  }
});

test("a positively refused connection can be retried without sending two POSTs", async () => {
  const reserved = http.createServer();
  const port = await listen(reserved);
  await close(reserved);
  const received = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push(Buffer.concat(chunks).toString("utf8"));
    successfulResponse(response, "registry");
  });
  let attempts = 0;
  try {
    const text = await describeImage({
      ...callOptions(`http://127.0.0.1:${port}`, "registry"), deliveryPolicy: "at-most-once",
      fetchImpl: async (...args) => {
        attempts += 1;
        try { return await fetch(...args); } catch (error) {
          if (attempts === 1) {
            assert.equal(error.cause?.code, "ECONNREFUSED");
            await listen(server, port);
          }
          throw error;
        }
      },
    });
    assert.match(text, /Synthetic evidence/);
    assert.equal(attempts, 2);
    assert.equal(received.length, 1, "only the connected attempt reaches the server");
  } finally {
    await close(server);
  }
});

test("positive pre-send retries stay bounded and cancellation interrupts backoff", async () => {
  const refusal = () => new TypeError("fetch failed", { cause: Object.assign(new Error("refused"), {
    code: "ECONNREFUSED", syscall: "connect",
  }) });
  let attempts = 0;
  await assert.rejects(describeImage({
    ...callOptions("http://127.0.0.1:1", "registry"), deliveryPolicy: "at-most-once",
    fetchImpl: async () => { attempts += 1; throw refusal(); },
  }), (error) => error.deliveryState === "not_sent");
  assert.equal(attempts, 3);

  const controller = new AbortController();
  let canceledAttempts = 0;
  const call = describeImage({
    ...callOptions("http://127.0.0.1:1", "registry"), deliveryPolicy: "at-most-once",
    retryDelaysMs: [60_000], signal: controller.signal,
    fetchImpl: async () => { canceledAttempts += 1; setImmediate(() => controller.abort()); throw refusal(); },
  });
  await assert.rejects(call, { name: "AbortError" });
  assert.equal(canceledAttempts, 1);
});

test("vision trusts delivery provenance only for an explicitly identified local API reply", async () => {
  for (const shape of ["registry", "native", "local"]) {
    for (const trustedTransportResponse of [false, true]) {
      let attempts = 0;
      const call = describeImage({
        ...callOptions("http://127.0.0.1:1", shape), deliveryPolicy: "at-most-once", trustedTransportResponse,
        fetchImpl: async () => {
          attempts += 1;
          return attempts === 1 ? new Response(JSON.stringify({ error: {
            type: "provider_transport_error", code: "ECONNREFUSED", deliveryState: "not_sent",
          } }), { status: 502, headers: { [PROVIDER_DELIVERY_STATE_HEADER]: "not_sent" } }) :
            new Response(JSON.stringify({ output: [{ type: "message", role: "assistant", content: [
              { type: "output_text", text: "## Summary\nSynthetic evidence." },
            ] }] }));
        },
      });
      if (shape === "registry" && trustedTransportResponse) {
        assert.match(await call, /Synthetic evidence/);
        assert.equal(attempts, 2);
      } else {
        await assert.rejects(call, /answered HTTP 502/);
        assert.equal(attempts, 1, `${shape} origin cannot claim local forwarder provenance`);
      }
    }
  }
});

test("a failure after real response headers never replays a partially read generation", async () => {
  let accepted = 0;
  let originResponse;
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume the entire submitted POST */ }
    accepted += 1;
    originResponse = response;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.write('{"output":[');
  });
  const port = await listen(server);
  try {
    await assert.rejects(describeImage({
      ...callOptions(`http://127.0.0.1:${port}`, "registry"), deliveryPolicy: "at-most-once",
      fetchImpl: async (...args) => {
        const upstream = await fetch(...args);
        // The actual fetch has resolved its headers before the owned origin
        // closes its unfinished body, independently of machine scheduling.
        setImmediate(() => originResponse.destroy());
        return upstream;
      },
    }), (error) => error.deliveryState === "response_started" && error.retryable === false);
    assert.equal(accepted, 1);
  } finally {
    await close(server);
  }
});

test("explicit failed and incomplete JSON generations are neither empty-repaired nor quoted", async () => {
  for (const status of ["failed", "incomplete"]) for (const partial of [false, true]) {
    let attempts = 0;
    await assert.rejects(describeImage({
      ...callOptions("http://127.0.0.1:1", "registry"), deliveryPolicy: "at-most-once",
      fetchImpl: async () => {
        attempts += 1;
        return new Response(JSON.stringify({ object: "response", status,
          ...(status === "failed" ? { error: { message: "synthetic-private-failure-detail" } } : {}),
          output: partial ? [{ type: "message", role: "assistant", content: [
            { type: "output_text", text: "synthetic-private-partial-transcript" },
          ] }] : [],
        }), { status: 200 });
      },
    }), (error) => {
      assert.equal(error.deliveryState, "response_started");
      assert.equal(error.retryable, false);
      assert.doesNotMatch(error.message, /synthetic-private/);
      return true;
    });
    assert.equal(attempts, 1, `${status} is an explicit failure, not an observed completed-empty repair`);
  }
});
