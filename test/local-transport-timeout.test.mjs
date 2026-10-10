import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { localTimeoutSeconds, localTransportIdleTimeoutMs } from "../src/local-timeouts.mjs";

test("local timeout defaults and overrides remain in seconds with a transport margin", () => {
  assert.equal(localTimeoutSeconds({}), 600);
  assert.equal(localTransportIdleTimeoutMs({}), 660_000);
  assert.equal(localTimeoutSeconds({ MODEL_ROUTER_LOCAL_TIMEOUT: "2400" }), 2400);
  assert.equal(localTransportIdleTimeoutMs({ MODEL_ROUTER_LOCAL_TIMEOUT: "2400" }), 2_460_000);
});

test("router routes only local and Grok through long-idle fetch", async () => {
  const source = readFileSync(new URL("../src/router.mjs", import.meta.url), "utf8");
  const block = source.match(/(?:async )?function fetchForRoute\(route, url, init\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(block);
  assert.match(source, /const LOCAL_TRANSPORT_IDLE_TIMEOUT_MS = localTransportIdleTimeoutMs\(\);/);
  const calls = [];
  const sent = (kind) => async (url, init, options) => {
    const response = { kind };
    calls.push({ kind, url, init, options, response });
    return response;
  };
  // Execute the actual route dispatcher with confined transport substitutes.
  // Distinct deadlines prove which transport each route selects.
  const dispatch = new Function(
    "isGrokOauthRoute", "canonicalProviderId", "longIdleStreamFetch", "fetch",
    "rejectGenerationRedirect", "GROK_TRANSPORT_IDLE_TIMEOUT_MS", "LOCAL_TRANSPORT_IDLE_TIMEOUT_MS",
    `return (${block});`,
  )((route) => route?.provider === "grok-oauth", (id) => id,
    sent("long-idle"), sent("ordinary"), (response) => response, 456_000, 660_000);
  for (const provider of ["grok-oauth", "local", "deepseek"]) {
    const result = await dispatch({ provider }, "http://127.0.0.1/synthetic", { method: "POST" });
    assert.equal(result, calls.at(-1).response);
  }
  assert.deepEqual(calls.map(({ kind, options }) => [kind, options?.bodyTimeoutMs]), [
    ["long-idle", 456_000], ["long-idle", 660_000], ["ordinary", undefined],
  ]);
  assert.ok(calls.every(({ init }) => init.redirect === "manual"));
});
