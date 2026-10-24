import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { userModelEntry } from "../src/user-models.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const genericSlug = "example-ai/tool-model";

function explain({
  slug = genericSlug,
  providers = [],
  generic = {},
  hidden = [],
  settings = {},
  definition = true,
} = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "control-subagent-explain-"));
  const stateDir = path.join(directory, "state");
  const codexHome = path.join(directory, "codex");
  const agentsDir = path.join(codexHome, "agents");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(agentsDir, { recursive: true });
  const documents = {
    "enabled-providers.json": { version: 1, providers },
    "generic-providers.json": {
      version: 1,
      providers: [{
        id: "example-ai",
        displayName: "Example AI",
        baseUrl: "https://inference.example.test/v1",
        adapter: "openai-responses",
        enabled: true,
        ...generic,
      }],
    },
    "user-models.json": {
      version: 1,
      models: [userModelEntry({
        providerId: "example-ai",
        upstreamId: "tool-model",
        priority: 10,
      })],
    },
    "model-picker.json": { version: 1, hidden, seeded: hidden },
    "multi-agent-settings.json": {
      version: 2,
      mode: "selected",
      enabled: [slug],
      disabled: [],
      ...settings,
    },
  };
  for (const [name, document] of Object.entries(documents)) {
    writeFileSync(path.join(stateDir, name), `${JSON.stringify(document)}\n`);
  }
  if (definition) {
    const stem = slug.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    writeFileSync(path.join(agentsDir, `router-model-${stem}.toml`), "# Managed by Codex Router.\n");
  }
  try {
    const output = execFileSync(process.execPath, [
      path.join(root, "src", "control.mjs"), "subagents", "explain", slug, "--json",
    ], {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        HOME: directory,
        USERPROFILE: directory,
        CODEX_HOME: codexHome,
        MODEL_ROUTER_TARGET: "codex",
        MODEL_ROUTER_STATE_DIR: stateDir,
        CODEX_ROUTER_STATE_DIR: stateDir,
        MODEL_ROUTER_USER_MODELS: path.join(stateDir, "user-models.json"),
        MODEL_ROUTER_GENERIC_PROVIDERS: path.join(stateDir, "generic-providers.json"),
        MODEL_ROUTER_PROVIDER_CREDENTIAL_STORE: path.join(stateDir, "provider-credentials.json"),
        MODEL_ROUTER_SHOW_ALL_MODELS: "0",
        CODEX_ROUTER_SHOW_ALL_MODELS: "0",
      },
    });
    for (const [name, document] of Object.entries(documents)) {
      assert.deepEqual(JSON.parse(readFileSync(path.join(stateDir, name), "utf8")), document);
    }
    return JSON.parse(output);
  } finally {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  }
}

test("subagents explain recognizes an enabled generic provider outside built-in selection", () => {
  const result = explain();
  assert.equal(result.spawnable, true);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.agentName, "router_example_ai_tool_model");
  assert.deepEqual(result.notes.map(note => note.code), ["selected_not_certified"]);
});

test("subagents explain refuses a disabled generic provider", () => {
  const result = explain({ generic: { enabled: false } });
  assert.equal(result.spawnable, false);
  assert.deepEqual(result.blockers.map(block => block.code), ["unknown_route"]);
});

test("subagents explain refuses a generic provider with a missing credential reference", () => {
  const result = explain({ generic: { credentialRef: "cred_missing_example_01" } });
  assert.equal(result.spawnable, false);
  assert.deepEqual(result.blockers.map(block => block.code), ["provider_disabled"]);
});

test("subagents explain preserves built-in provider family selection", () => {
  const result = explain({
    slug: "commandcode-messages/claude-sonnet-5",
    providers: ["commandcode"],
  });
  assert.equal(result.spawnable, true);
  assert.deepEqual(result.blockers, []);
});

test("subagents explain keeps an unselected built-in provider disabled", () => {
  const result = explain({ slug: "commandcode-messages/claude-sonnet-5" });
  assert.equal(result.spawnable, false);
  assert.deepEqual(result.blockers.map(block => block.code), ["provider_disabled"]);
});

test("generic provider readiness does not bypass hidden or disabled subagent settings", () => {
  const result = explain({ hidden: [genericSlug], settings: { disabled: [genericSlug] } });
  assert.equal(result.spawnable, false);
  assert.deepEqual(result.blockers.map(block => block.code), ["model_hidden", "explicitly_off"]);
});

test("generic provider readiness does not replace a missing agent definition", () => {
  const result = explain({ definition: false });
  assert.equal(result.spawnable, false);
  assert.deepEqual(result.blockers.map(block => block.code), ["agent_definition_missing"]);
});
