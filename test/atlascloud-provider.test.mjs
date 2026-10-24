import assert from "node:assert/strict";
import test from "node:test";

import { LISTED_MODELS, PROVIDERS } from "../src/model-registry.mjs";

test("Atlas Cloud is a credentialed catalog-only OpenAI-compatible provider", () => {
  const provider = PROVIDERS.get("atlascloud");
  assert.equal(provider.displayName, "Atlas Cloud");
  assert.equal(provider.baseUrl, "https://api.atlascloud.ai/v1");
  assert.equal(provider.baseUrlEnv, "ATLASCLOUD_API_BASE_URL");
  assert.deepEqual(provider.credential.environment, ["ATLASCLOUD_API_KEY"]);
  assert.equal(provider.credential.file, "atlascloud-api-key.secret");
  assert.deepEqual(provider.credential.keychainServices, ["codex-router-atlascloud"]);
  assert.equal(LISTED_MODELS.some(({ provider: id }) => id === "atlascloud"), false);
});
