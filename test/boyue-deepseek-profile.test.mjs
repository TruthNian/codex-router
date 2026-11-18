import assert from "node:assert/strict";
import test from "node:test";
import { boyueDeepSeekResponsesRequest } from "../src/deepseek-responses.mjs";
import { flattenNamespaceTools, flattenToolSearchHistory } from "../src/namespace-relay.mjs";

const tool = { type: "function", name: "read", parameters: { type: "object", properties: {} } };

test("Boyue discovered custom children require an actual string identity", () => {
  const flat = flattenNamespaceTools([{ type: "tool_search", execution: "client", parameters: { type: "object" } }]);
  for (const name of [123, {}, [], null, ""]) {
    const history = [
      { type: "tool_search_call", execution: "client", call_id: "discover", arguments: { query: "lookup" } },
      { type: "tool_search_output", execution: "client", status: "completed", call_id: "discover",
        tools: [{ type: "namespace", name: "mcp__fixture", tools: [{ type: "custom", name, format: { type: "text" } }] }] },
    ];
    const found = flattenToolSearchHistory(history, flat.tools, flat.namespaces, { allowCustomTools: true });
    assert.equal(found.tools.some((candidate) => candidate.type === "custom"), false);
  }
});

test("Boyue preserves required, named, none and explicitly restricted tool permissions", () => {
  for (const choice of ["required", { type: "function", name: "read" }, { type: "custom", name: "apply_patch" }]) {
    const payload = { tools: [tool], tool_choice: choice, reasoning: { effort: "max" } };
    const original = structuredClone(payload);
    const result = boyueDeepSeekResponsesRequest(payload);
    assert.deepEqual(result.tool_choice, choice);
    assert.equal(result.reasoning.effort, "none");
    assert.deepEqual(payload, original);
  }
  for (const mode of ["auto", "required"]) {
    const payload = { tools: [tool, { ...tool, name: "ungranted" }],
      tool_choice: { type: "allowed_tools", mode, tools: [{ type: "function", name: "read" }] },
      reasoning: { effort: "high" } };
    const result = boyueDeepSeekResponsesRequest(payload);
    assert.deepEqual(result.tools, [tool]);
    assert.equal(result.tool_choice, mode);
    assert.equal(result.reasoning.effort, mode === "required" ? "none" : "high");
  }
  for (const choice of ["none", "auto", undefined]) {
    const payload = { tool_choice: choice, tools: [tool], reasoning: { effort: "high" } };
    assert.deepEqual(boyueDeepSeekResponsesRequest(payload), payload);
  }
  for (const allowed of [[], [{ type: "function", name: "unknown" }],
    [{ type: "function", name: "read" }, { type: "function", name: "read" }], [{ type: "namespace", name: "read" }]]) {
    assert.throws(() => boyueDeepSeekResponsesRequest({ tools: [tool],
      tool_choice: { type: "allowed_tools", mode: "required", tools: allowed } }),
    (error) => error.status === 400 && error.code === "invalid_boyue_tool_choice");
  }
  assert.throws(() => boyueDeepSeekResponsesRequest({ tools: [tool, tool],
    tool_choice: { type: "allowed_tools", mode: "auto", tools: [{ type: "function", name: "read" }] } }), /unique/);
});

test("Boyue does not silently accept server-side response-id continuation", () => {
  for (const input of [undefined, [], "only the latest question", [{ role: "user", content: "suffix" }]]) {
    assert.throws(() => boyueDeepSeekResponsesRequest({ previous_response_id: "unknown", input }),
      (error) => error.status === 409 && error.code === "previous_response_not_found");
  }
});

test("Boyue raises developer text priority while preserving images and caller data", () => {
  const image = { type: "input_image", file_id: "file_synthetic_image" };
  const payload = { input: [
    { type: "message", id: "developer_mixed", role: "developer", content: [{ type: "input_text", text: "Follow this contract." }, image] },
    { role: "developer", content: "Second contract." },
    { role: "developer", content: [image] },
    { role: "user", content: "Question" },
  ] };
  const original = structuredClone(payload);
  const result = boyueDeepSeekResponsesRequest(payload);
  assert.deepEqual(result.input.map((item) => item.role), ["system", "developer", "system", "developer", "user"]);
  assert.deepEqual(result.input[1].content, [image]);
  assert.deepEqual(result.input[3].content, [image]);
  assert.equal(result.input.filter((item) => item.id === "developer_mixed").length, 1);
  assert.deepEqual(payload, original);
  assert.deepEqual(boyueDeepSeekResponsesRequest(result), result);
});

test("Boyue thinking resumes after a nonthinking custom exchange without inventing reasoning", () => {
  const payload = { tools: [tool], reasoning: { effort: "high" }, input: [
    { role: "user", content: "Read" },
    { type: "function_call", call_id: "call_read", name: "read", arguments: "{}" },
    { type: "function_call_output", call_id: "call_read", output: "exact result" },
    { role: "assistant", content: "Read complete." },
    { role: "user", content: "Continue" },
  ] };
  const original = structuredClone(payload);
  const result = boyueDeepSeekResponsesRequest(payload);
  assert.deepEqual(result.input.filter((item) => item.type !== "reasoning"), payload.input);
  assert.ok(result.input.some((item) => item.content?.[0]?.text?.includes("prior reasoning unavailable")));
  assert.equal(result.input.findIndex((item) => item.type === "function_call_output") -
    result.input.findIndex((item) => item.type === "function_call"), 1);
  assert.deepEqual(boyueDeepSeekResponsesRequest(result), result);
  assert.deepEqual(payload, original);
  const nonthinking = boyueDeepSeekResponsesRequest({ ...payload, tool_choice: "required" });
  assert.equal(nonthinking.input.some((item) => item.type === "reasoning"), false);
});
