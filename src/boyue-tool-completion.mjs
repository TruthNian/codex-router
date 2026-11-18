import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";

const MAX_BYTES = 4 * 1024 * 1024;
// Native custom-tool input is raw text and already has cancellation semantics;
// only JSON function arguments (including bridged custom/discovery tools) need
// this barrier. Holding native apply_patch deltas would break desktop progress.
const TOOL_TYPES = new Set(["function_call"]);
const TERMINALS = new Set(["response.completed", "response.incomplete", "response.failed"]);
function failure() {
  return Object.assign(new Error("Boyue returned an inconsistent or oversized tool completion lifecycle."), {
    code: "ERR_BOYUE_TOOL_COMPLETION", status: 502,
  });
}

// A token-limited Responses turn may close arguments with an unfinished JSON
// string before declaring the item incomplete. Codex dispatches output_item.done,
// so none of that tool's lifecycle may be released speculatively. Text before
// the first tool remains streamed; bounded tool lifecycles wait for the terminal.
// This is deliberately profile-scoped, not a general malformed-JSON repair.
export function completedBoyueOutput(response) {
  if (response?.status !== "incomplete" || response?.incomplete_details?.reason !== "max_output_tokens" ||
      !Array.isArray(response.output)) return { response, dropped: new Set(), indices: new Map() };
  const dropped = new Set();
  const indices = new Map();
  const ids = new Set();
  let next = 0;
  response.output.forEach((item, index) => {
    for (const value of [item?.id, item?.call_id].filter(v => typeof v === "string" && v)) {
      if (ids.has(value)) throw failure();
      ids.add(value);
    }
    if (TOOL_TYPES.has(item?.type) && item.status === "incomplete") {
      if (typeof item.id !== "string" || !item.id) throw failure();
      dropped.add(item.id);
      if (typeof item.call_id === "string") dropped.add(item.call_id);
      indices.set(index, undefined);
    } else indices.set(index, next++);
  });
  return { response: dropped.size ? { ...response, output: response.output.filter(item => !dropped.has(item?.id)) } : response,
    dropped, indices };
}

export function createBoyueToolCompletionTransform({ maxBytes = MAX_BYTES } = {}) {
  const decoder = new StringDecoder("utf8");
  let pending = "", buffered = [], bytes = 0, gated = false;
  const clear = () => { pending = ""; buffered = []; bytes = 0; gated = false; };
  function consume(frame, output) {
    const lines = frame.trimEnd().split(/\r?\n/);
    const data = lines.filter(line => line.startsWith("data:"));
    let event;
    if (data.length === 1) {
      try { event = JSON.parse(data[0].slice(5).trimStart()); } catch { /* downstream owns invalid frames */ }
    }
    if (!gated && event?.type === "response.output_item.added" && TOOL_TYPES.has(event.item?.type)) gated = true;
    if (!gated) { output.push(frame); return; }
    if (event?.type === "error") {
      // The Responses normalizer also emits this on a truncated transport.
      // Keep its actual failure code; staged calls have not been dispatched.
      buffered = []; bytes = 0; gated = false;
      output.push(frame); return;
    }
    bytes += Buffer.byteLength(frame, "utf8");
    if (bytes > maxBytes) throw failure();
    buffered.push({ frame, event });
    if (!TERMINALS.has(event?.type)) return;
    const expectedStatus = event.type.slice("response.".length);
    if (event.response?.status !== undefined && event.response.status !== expectedStatus) throw failure();
    const { response, dropped, indices } = completedBoyueOutput(event.response);
    for (const value of buffered) {
      const e = value.event;
      if (!e) { output.push(value.frame); continue; }
      const itemId = e.item?.id || e.item_id;
      if (dropped.has(itemId) || dropped.has(e.item?.call_id || e.call_id)) {
        // Require both identity and index to agree before discarding any event.
        if (!indices.has(e.output_index) || indices.get(e.output_index) !== undefined) throw failure();
        const original = event.response.output[e.output_index];
        if (itemId && itemId !== original.id) throw failure();
        if ((e.call_id || e.item?.call_id) && (e.call_id || e.item?.call_id) !== original.call_id) throw failure();
        if (e.item && (e.item.name !== original.name || e.item.type !== original.type ||
            e.item.status !== (e.type === "response.output_item.added" ? "in_progress" : "incomplete"))) throw failure();
        continue;
      }
      if (indices.has(e.output_index) && indices.get(e.output_index) === undefined) throw failure();
      let changed = false;
      let next = e;
      if (dropped.size && indices.has(e.output_index) && indices.get(e.output_index) !== e.output_index) {
        next = { ...next, output_index: indices.get(e.output_index) }; changed = true;
        if (Number.isInteger(e.item?.output_index)) next.item = { ...e.item, output_index: next.output_index };
      }
      if (e === event && response !== event.response) { next = { ...next, response }; changed = true; }
      if (changed) output.push(`event: ${next.type}\ndata: ${JSON.stringify(next)}\n\n`);
      else output.push(value.frame);
    }
    buffered = []; bytes = 0; gated = false;
  }
  return new Transform({
    transform(chunk, _, callback) {
      try {
        pending += typeof chunk === "string" ? chunk : decoder.write(chunk);
        if (Buffer.byteLength(pending, "utf8") + bytes > maxBytes) throw failure();
        let match;
        while ((match = /\r?\n\r?\n/.exec(pending))) {
          const end = match.index + match[0].length;
          const frame = pending.slice(0, end); pending = pending.slice(end);
          consume(frame, this);
        }
        callback();
      } catch (error) { clear(); callback(error); }
    },
    flush(callback) {
      try {
        pending += decoder.end();
        if (pending) consume(pending, this);
        if (gated) throw failure();
        clear(); callback();
      } catch (error) { clear(); callback(error); }
    },
    destroy(error, callback) { clear(); callback(error); },
  });
}

export function createBoyueToolCompletionJsonTransform({ maxBytes = MAX_BYTES } = {}) {
  let chunks = [], bytes = 0;
  return new Transform({
    transform(chunk, _, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes) { chunks = []; callback(failure()); return; }
      chunks.push(Buffer.from(chunk)); callback();
    },
    flush(callback) {
      try {
        const raw = Buffer.concat(chunks); chunks = [];
        const parsed = JSON.parse(raw.toString("utf8"));
        const { response, dropped } = completedBoyueOutput(parsed);
        this.push(dropped.size ? JSON.stringify(response) : raw); callback();
      } catch (error) { callback(error); }
    },
    destroy(error, callback) { chunks = []; callback(error); },
  });
}
