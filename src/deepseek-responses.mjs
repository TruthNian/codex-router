import { agentMessagesAsUserMessages } from "./namespace-relay.mjs";

// Reseller compatibility is an explicit per-model opt-in, never inferred from
// an upstream name alone. Other custom endpoints retain their own contracts.
export function isBoyueDeepSeekResponses(model) {
  return model?.provider === "custom" &&
    model.requestProfile === "boyue-deepseek-responses" &&
    model.upstreamModel === "deepseek/deepseek-flash" &&
    model.endpoint?.protocol === "openai-responses";
}

// The current direct Flash endpoint and the explicitly tested Boyue profile
// share native Responses tools and reasoning replay. Legacy routes keep Chat.
export function usesDeepSeekResponses(model) {
  return (model?.provider === "deepseek" && model?.upstreamModel === "deepseek-flash") ||
    isBoyueDeepSeekResponses(model);
}

function boyueRequestError(message, code, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

// Boyue forwards the native endpoint's stateless contract. Never make an
// unknown response id look like a successful continuation with lost history.
// WebSocket continuations are reconstructed by responses-websocket before this
// boundary, and ordinary HTTP clients must resend their complete input.
export function boyueDeepSeekResponsesRequest(payload) {
  if (payload.previous_response_id != null && payload.previous_response_id !== "") {
    throw boyueRequestError("Previous response is unavailable on this stateless route; resend the full input history.",
      "previous_response_not_found", 409);
  }
  let next = { ...payload };
  const choice = next.tool_choice;
  if (choice?.type === "allowed_tools") {
    const allowed = choice.tools;
    if (!["auto", "required"].includes(choice.mode) || !Array.isArray(allowed) || !allowed.length ||
        !allowed.every((tool) => ["function", "custom"].includes(tool?.type) &&
          typeof tool.name === "string" && tool.name)) {
      throw boyueRequestError("Invalid allowed-tools restriction.", "invalid_boyue_tool_choice");
    }
    const keys = allowed.map((tool) => `${tool.type}\0${tool.name}`);
    const matches = allowed.map((tool) => next.tools?.filter((candidate) =>
      candidate.type === tool.type && candidate.name === tool.name));
    if (new Set(keys).size !== keys.length || !matches.every((group) => group?.length === 1)) {
      throw boyueRequestError("Allowed tools must identify unique declared tools.", "invalid_boyue_tool_choice");
    }
    next.tools = matches.map((group) => group[0]);
    next.tool_choice = choice.mode;
  }
  const forced = next.tool_choice === "required" ||
    (["function", "custom"].includes(next.tool_choice?.type) &&
      typeof next.tool_choice.name === "string" && next.tool_choice.name);
  if (forced) {
    // Do not change required to auto: that silently weakens the caller's
    // contract. This upstream cannot think and force a tool in the same call.
    next.reasoning = { ...(next.reasoning || {}), effort: "none" };
  }
  if (Array.isArray(next.input)) {
    next.input = next.input.flatMap((item) => {
      if (item?.role !== "developer") return [item];
      // DeepSeek treats developer as user. Promote instructions, but never
      // move images into system: the upstream explicitly rejects that role.
      if (typeof item.content === "string") return [{ ...item, role: "system" }];
      if (!Array.isArray(item.content)) return [item];
      const text = item.content.filter((part) => ["input_text", "output_text"].includes(part?.type));
      if (!text.length) return [item];
      const other = item.content.filter((part) => !["input_text", "output_text"].includes(part?.type));
      if (!other.length) return [{ ...item, role: "system" }];
      return [{ type: "message", role: "system", content: text }, { ...item, content: other }];
    });
    // A forced/nonthinking call has no reasoning to replay. When thinking is
    // re-enabled, mark that absence truthfully rather than fabricate a chain
    // of thought, then reuse the existing turn/parallel exchange normalizer.
    if (next.reasoning?.effort !== "none" && next.tools?.length &&
        !next.input.some((item) => item?.type === "reasoning")) {
      const first = next.input.findIndex((item) => isAssistantMessage(item) || TOOL_CALL_TYPES.has(item?.type));
      if (first >= 0) next.input.splice(first, 0, {
        type: "reasoning",
        content: [{ type: "reasoning_text", text: "(prior reasoning unavailable: preceding response ran without thinking)" }],
      });
    }
    next.input = deepSeekResponsesInput(next.input);
  }
  return next;
}

// Current native endpoint aliases, documented in DeepSeek's thinking guide.
// In particular xhigh maps to high; it is not the legacy Chat profile's max.
export function deepSeekResponsesEffort(value) {
  if (value === "none") return "none";
  if (["minimal", "low"].includes(value)) return "low";
  return ["max", "ultra"].includes(value) ? "max" : "high";
}

function reasoningContent(value) {
  const texts = typeof value === "string" ? [value]
    : Array.isArray(value)
      ? value.map((part) => (typeof part === "string" ? part : part?.text))
      : [];
  return texts.filter((text) => typeof text === "string" && text)
    .map((text) => ({ type: "reasoning_text", text }));
}

// Codex replays a turn's reasoning immediately before the message that
// followed it, but a model that thinks between issuing a tool call and the
// result arriving leaves reasoning items inside the call/output exchange.
// DeepSeek pairs every tool_calls message with its outputs directly, so a
// reasoning_text part in between is rejected as "No tool output found for
// tool call ...". Hoist displaced reasoning to the head of the assistant
// turn that owns the exchange (its message, or the first call when the turn
// has no message), preserving item order otherwise. Idempotent: hoisted
// reasoning sits outside any open exchange, so a second pass moves nothing.
const TOOL_CALL_TYPES = new Set(["function_call", "custom_tool_call"]);
const TOOL_OUTPUT_TYPES = new Set(["function_call_output", "custom_tool_call_output"]);

function isAssistantMessage(item) {
  return item?.role === "assistant" || (item?.type === "message" && item?.role === "assistant");
}

function relocateReasoningOutOfToolExchanges(items) {
  const result = [];
  const openCalls = new Set();
  let exchangeStart = -1;
  let hoistAt = -1;
  for (const item of items) {
    const type = item?.type;
    if (isAssistantMessage(item)) {
      if (openCalls.size === 0) {
        exchangeStart = result.length;
        hoistAt = -1;
      }
      result.push(item);
      continue;
    }
    if (TOOL_CALL_TYPES.has(type)) {
      if (openCalls.size === 0 && exchangeStart === -1) exchangeStart = result.length;
      // Outputs reference their call by call_id only, so tracking both the
      // item id and the call_id would leave the exchange open forever on
      // calls whose ids differ.
      const callKey =
        typeof item?.call_id === "string" && item.call_id
          ? item.call_id
          : typeof item?.id === "string" && item.id
            ? item.id
            : null;
      if (callKey) openCalls.add(callKey);
      result.push(item);
      continue;
    }
    if (TOOL_OUTPUT_TYPES.has(type)) {
      if (typeof item?.call_id === "string") openCalls.delete(item.call_id);
      result.push(item);
      if (openCalls.size === 0) exchangeStart = -1;
      continue;
    }
    if (type === "reasoning" && openCalls.size > 0 && exchangeStart >= 0) {
      const at = hoistAt >= 0 ? hoistAt : exchangeStart;
      result.splice(at, 0, item);
      hoistAt = at + 1;
      continue;
    }
    result.push(item);
  }
  return result;
}

// DeepSeek's thinking contract is all-or-nothing across a replayed history:
// once any turn carries reasoning_text, every bare assistant turn is rejected
// ("The `reasoning_text` in the thinking mode must be passed back to the
// API"). Histories mixed across providers, or compacted, lose some turns'
// reasoning entirely, so those turns get an explicit placeholder instead of
// staying bare. A history with no reasoning at all is left untouched:
// DeepSeek accepts it, and fake reasoning would only cost prompt quality.
const PLACEHOLDER_REASONING_TEXT = "(prior reasoning unavailable)";

function placeholderReasoning() {
  return { type: "reasoning", content: [{ type: "reasoning_text", text: PLACEHOLDER_REASONING_TEXT }] };
}

function ensureReasoningForAssistantTurns(items) {
  if (!items.some((item) => item?.type === "reasoning")) return items;
  const result = [];
  const openCalls = new Set();
  for (const item of items) {
    const type = item?.type;
    if (TOOL_CALL_TYPES.has(type)) {
      if (openCalls.size === 0 && result[result.length - 1]?.type !== "reasoning") {
        result.push(placeholderReasoning());
      }
      // Outputs reference their call by call_id only, so tracking both the
      // item id and the call_id would leave the exchange open forever on
      // calls whose ids differ.
      const callKey =
        typeof item?.call_id === "string" && item.call_id
          ? item.call_id
          : typeof item?.id === "string" && item.id
            ? item.id
            : null;
      if (callKey) openCalls.add(callKey);
      result.push(item);
      continue;
    }
    if (TOOL_OUTPUT_TYPES.has(type)) {
      if (typeof item?.call_id === "string") openCalls.delete(item.call_id);
      result.push(item);
      continue;
    }
    if (
      isAssistantMessage(item) &&
      openCalls.size === 0 &&
      result[result.length - 1]?.type !== "reasoning"
    ) {
      result.push(placeholderReasoning());
    }
    result.push(item);
  }
  return result;
}

// Plaintext reasoning uses an array of reasoning_text parts, not a JSON string.
// DeepSeek ignores summary/encrypted_content; older Chat-bridged turns can have
// only a summary, and native Codex turns carry the same text as summary_text /
// raw_content instead. Replay whichever shape is present, preserving part
// boundaries, then keep every replayed part out of tool-call exchanges.
export function deepSeekResponsesInput(input) {
  if (!Array.isArray(input)) return input;
  // The task text is already recovered; expose Codex handoffs as ordinary
  // messages because the public endpoint does not understand agent_message.
  const mapped = agentMessagesAsUserMessages(input).flatMap((item) => {
    if (item?.type !== "reasoning") return [item];
    let content = reasoningContent(item.content);
    if (!content.length) content = reasoningContent(item.summary);
    if (!content.length) content = reasoningContent(item.summary_text);
    if (!content.length) content = reasoningContent(item.raw_content);
    return content.length ? [{ type: "reasoning", content }] : [];
  });
  return ensureReasoningForAssistantTurns(relocateReasoningOutOfToolExchanges(mapped));
}

// Only apply_patch has a native custom-tool contract at this endpoint. Other
// Codex freeform tools use the existing reversible function-tool bridge.
export function deepSeekCustomToolNames(tools, input, choice) {
  const names = new Set();
  const add = (type, name) => {
    if ((type === "custom" || type === "custom_tool_call") &&
        typeof name === "string" && name && name !== "apply_patch") names.add(name);
  };
  for (const tool of Array.isArray(tools) ? tools : []) add(tool?.type, tool?.name);
  for (const item of Array.isArray(input) ? input : []) add(item?.type, item?.name);
  add(choice?.type, choice?.name);
  for (const tool of choice?.type === "allowed_tools" && Array.isArray(choice.tools)
    ? choice.tools : []) add(tool?.type, tool?.name);
  return [...names];
}
