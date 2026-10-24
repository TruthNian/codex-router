import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { rejectGenerationRedirect } from "../src/generation-redirect.mjs";
import { localTimeoutSeconds, localTransportIdleTimeoutMs } from "../src/local-timeouts.mjs";

test("local timeout defaults and overrides remain in seconds with a transport margin", () => {
  assert.equal(localTimeoutSeconds({}), 600);
  assert.equal(localTransportIdleTimeoutMs({}), 660_000);
  assert.equal(localTimeoutSeconds({ MODEL_ROUTER_LOCAL_TIMEOUT: "2400" }), 2400);
  assert.equal(localTransportIdleTimeoutMs({ MODEL_ROUTER_LOCAL_TIMEOUT: "2400" }), 2_460_000);
});

test("router preserves transport selection and rejects generation redirects on every path", async () => {
  const source = readFileSync(new URL("../src/router.mjs", import.meta.url), "utf8");
  const block = source.match(/(?:async )?function fetchForRoute\(route, url, init\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(block);
  assert.match(source, /const LOCAL_TRANSPORT_IDLE_TIMEOUT_MS = localTransportIdleTimeoutMs\(\);/);
  // Load only the real transport selector: importing router.mjs starts a server.
  for (const [route, transport, timeout] of [
    [undefined, "ordinary", undefined],
    [{ provider: "custom" }, "ordinary", undefined],
    [{ provider: "local" }, "long-idle", 660_000],
    [{ provider: "grok-oauth" }, "long-idle", 300_000],
  ]) {
    for (const status of [200, 307]) {
      const calls = [];
      let canceled = false;
      const upstream = new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode("local control")); controller.close(); },
        cancel() { canceled = true; },
      }), { status });
      const send = kind => async (url, init, options) => {
        calls.push({ kind, url, init, options });
        return upstream;
      };
      const fetchForRoute = runInNewContext(`(${block})`, {
        fetch: send("ordinary"), longIdleStreamFetch: send("long-idle"),
        isGrokOauthRoute: model => model?.provider === "grok-oauth",
        canonicalProviderId: provider => provider,
        GROK_TRANSPORT_IDLE_TIMEOUT_MS: 300_000, LOCAL_TRANSPORT_IDLE_TIMEOUT_MS: 660_000,
        rejectGenerationRedirect,
      });
      const init = Object.freeze({ method: "POST", body: "synthetic generation", redirect: "follow" });
      const result = fetchForRoute(route, "http://127.0.0.1/synthetic", init);
      if (status === 307) {
        await assert.rejects(result, error => error.code === "upstream_redirect_refused");
        assert.equal(canceled, true, "refused redirect body is released");
      } else {
        assert.equal(await result, upstream);
        assert.equal(await upstream.text(), "local control");
        assert.equal(canceled, false);
      }
      assert.equal(calls.length, 1);
      assert.equal(calls[0].kind, transport);
      assert.equal(calls[0].options?.bodyTimeoutMs, timeout);
      assert.equal(calls[0].init.redirect, "manual");
      assert.equal(init.redirect, "follow", "the caller's init stays unchanged");
    }
  }
});
