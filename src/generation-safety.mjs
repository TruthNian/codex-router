import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";

export class GenerationSafetyError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.status = 400;
    this.name = "GenerationSafetyError";
  }
}

// Enable degeneration recovery for the measured affected model family. This
// does not change the caller's effort, token budget, or tools.
export function generationSafetyEnabled(model) {
  return /(?:^|\/)glm-5\.3(?:$|[-:])/i.test(model?.upstreamModel || "");
}

function shingles(text, width = 24) {
  const set = new Set();
  for (let i = 0; i + width <= text.length; i++) set.add(text.slice(i, i + width));
  return set;
}

// A long tail made almost entirely of already repeated phrases is evidence
// of degeneration, unlike response length alone. Bound both work and memory.
export function repetitiveText(text) {
  if (text.length < 4096) return false;
  const tail = text.slice(-8192).replace(/\s+/g, " ");
  if (tail.length < 4096) return false;
  // Use every offset so arbitrary token/chunk boundaries do not change the
  // score for a repeated sentence whose length is not divisible by four.
  const grams = new Set();
  for (let i = 0; i + 32 <= tail.length; i++) grams.add(tail.slice(i, i + 32));
  return grams.size / (tail.length - 31) < 0.2;
}

function corruptedNarration(text) {
  if (repetitiveText(text)) return true;
  // The 03 incident started with a 128-character paragraph emitted twice,
  // before any long loop existed. Match whole duplicated paragraphs, not
  // repeated words or ordinary short acknowledgements.
  const value = text.trim();
  if (value.length < 160 || value.length > 4096) return false;
  const period = value.indexOf(value.slice(0, 80), 80);
  return period >= 80 && value.length % period === 0 &&
    value === value.slice(0, period).repeat(value.length / period);
}

function messageText(item) {
  if (typeof item?.content === "string") return item.content;
  return (item?.content || []).map((part) => part.text || "").join("\n");
}

function goalContinuation(item) {
  return item?.role === "user" &&
    /^<codex_internal_context source="goal">\s*Continue working toward the active thread goal\./.test(messageText(item));
}

function similar(a, b) {
  const left = shingles(a.replace(/\s+/g, ""), 3);
  const right = shingles(b.replace(/\s+/g, ""), 3);
  if (!left.size || !right.size) return a.trim() === b.trim();
  let common = 0;
  for (const value of left) if (right.has(value)) common++;
  return common / Math.max(left.size, right.size) >= 0.6;
}

function pausedAcknowledgement(text) {
  return /(?:已.{0,12}(?:暂停|停止|收尾)|不再.{0,8}(?:测试|执行)|\b(?:paused|stopped|wrapped up)\b)/i.test(text);
}

export function prepareGenerationInput(input) {
  if (!Array.isArray(input)) return input;
  // Derive stagnation from the supplied transcript, not an in-memory counter
  // that disappears on restart or mixes unrelated tasks. Only an internal goal
  // continuation can trip this gate; an actual user turn always resets it.
  if (goalContinuation(input.at(-1))) {
    const answers = [];
    let answer = "";
    const objective = messageText(input.at(-1)).match(/<objective>([\s\S]*?)<\/objective>/)?.[1];
    for (let i = input.length - 2; i >= 0; i--) {
      const item = input[i];
      if (item.role === "user" && !goalContinuation(item)) break;
      if (item.type && item.type !== "message" && item.type !== "reasoning") break;
      if (item.role === "assistant") answer = messageText(item) + answer;
      if (goalContinuation(item)) {
        if (messageText(item).match(/<objective>([\s\S]*?)<\/objective>/)?.[1] !== objective) break;
        answers.unshift(answer);
        answer = "";
      }
      if (answers.length === 3) break;
    }
    if (answers.length === 3 && answers.every((answer) => answer.trim() && answer.length <= 512) &&
        ((similar(answers[0], answers[1]) && similar(answers[1], answers[2])) ||
          answers.every(pausedAcknowledgement))) {
      throw new GenerationSafetyError("router_goal_no_progress",
        "Stopped automatic goal continuation after three repeated replies without tool activity. Review the saved state and resume with a new user instruction.");
    }
  }
  // Historical A/B probes showed that retaining even the start of corrupted
  // narration can seed another loop. Quarantine ordinary assistant narration
  // only after positive evidence of degeneration. Preserve user instructions,
  // tool calls/results, refusal and multimodal content, and the durable log.
  const narration = (item) => item.role === "assistant" &&
    (!item.type || item.type === "message") && !item.tool_calls &&
    (typeof item.content === "string" || (Array.isArray(item.content) &&
      item.content.every((part) => ["output_text", "text"].includes(part.type))));
  if (!input.some((item) => narration(item) && corruptedNarration(messageText(item)))) return input;
  let marked = false;
  return input.flatMap((item) => {
    if (!narration(item)) return [item];
    if (marked) return [];
    marked = true;
    return [{ ...item, content: [{ type: "output_text", text:
      "[Router recovery: prior assistant narration quarantined after repeated-generation corruption. User instructions and tool evidence are retained; original remains in the task transcript.]" }] }];
  });
}

// Runs before compatibility transforms, so an incomplete terminal cannot be
// swallowed by the empty-completion retry path. Failure throws through pipeline
// to cancel the upstream; the HTTP owner emits a non-retryable incomplete event.
export class GenerationSafetyTransform extends Transform {
  #decoder = new StringDecoder("utf8");
  #pending = "";
  #terminal = false;
  #text = "";
  #checked = 0;
  #repetition;
  #visible = false;
  constructor({ repetition = false } = {}) {
    super();
    this.#repetition = repetition;
  }
  _transform(chunk, encoding, callback) {
    try {
      this.#pending += this.#decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      this.#drain(false);
      if (this.#pending.length > 8 * 1024 * 1024) {
        throw new GenerationSafetyError("router_invalid_stream", "Upstream SSE frame exceeded the parser bound.");
      }
      callback();
    } catch (error) { callback(error); }
  }
  _flush(callback) {
    try {
      this.#pending += this.#decoder.end();
      this.#drain(true);
      if (!this.#terminal) throw new GenerationSafetyError("router_missing_terminal", "Upstream ended without a Responses terminal event.");
      callback();
    } catch (error) { callback(error); }
  }
  #drain(final) {
    while (this.#pending.length) {
      const match = /\r?\n\r?\n/.exec(this.#pending);
      if (!match && !final) return;
      const end = match ? match.index + match[0].length : this.#pending.length;
      const block = this.#pending.slice(0, end);
      this.#pending = this.#pending.slice(end);
      this.#frame(block);
    }
  }
  #frame(block) {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, "")).join("\n");
    if (!data || data === "[DONE]") { this.push(block); return; }
    let event;
    try { event = JSON.parse(data); } catch { this.push(block); return; }
    const contentfulPart = (part) =>
      (part?.type === "output_text" && typeof part.text === "string" && part.text.length > 0) ||
      (part?.type === "refusal" && typeof part.refusal === "string" && part.refusal.length > 0);
    const contentfulItem = (item) => /_call$/.test(item?.type || "") ||
      (item?.type === "message" && (item?.content || []).some(contentfulPart));
    if ((["response.output_text.delta", "response.refusal.delta"].includes(event.type) && event.delta) ||
        (event.type === "response.output_text.done" && typeof event.text === "string" && event.text.length > 0) ||
        (event.type === "response.refusal.done" && typeof event.refusal === "string" && event.refusal.length > 0) ||
        (["response.content_part.added", "response.content_part.done"].includes(event.type) && contentfulPart(event.part)) ||
        contentfulItem(event.item) || (event.response?.output || []).some(contentfulItem)) this.#visible = true;
    if (this.#repetition) {
      const texts = [event.type === "response.output_text.done" ? event.text : "",
        event.part?.type === "output_text" ? event.part.text : "",
        event.item?.type === "message" ? messageText(event.item) : "",
        ...(event.response?.output || []).filter((item) => item.type === "message").map(messageText)];
      if (texts.some((text) => typeof text === "string" && repetitiveText(text))) {
        throw new GenerationSafetyError("router_repetitive_generation", "Upstream returned repetitive assistant output. Generation stopped without retry.");
      }
    }
    if (event.type === "response.completed" || event.type === "response.done") {
      if (event.response?.status && event.response.status !== "completed") {
        throw new GenerationSafetyError("router_incomplete_response", "Upstream reported an incomplete or failed response inside a completion event.");
      }
      if (!this.#visible && Array.isArray(event.response?.output)) {
        throw new GenerationSafetyError("router_empty_generation", "Upstream reported success with no answer, refusal or tool call. Generation stopped without retry.");
      }
      this.#terminal = true;
    }
    if (["response.failed", "response.incomplete", "error"].includes(event.type)) this.#terminal = true;
    if (this.#repetition && event.type === "response.output_text.delta") {
      const delta = typeof event.delta === "string" ? event.delta : "";
      // Inspect a large single delta in bounded steps as well as normal token
      // streams, before forwarding that delta to the caller.
      for (let offset = 0; offset < delta.length; offset += 512) {
        const part = delta.slice(offset, offset + 512);
        this.#text = (this.#text + part).slice(-8192);
        this.#checked += part.length;
        if (this.#checked >= 512) {
          this.#checked = 0;
          if (repetitiveText(this.#text)) throw new GenerationSafetyError("router_repetitive_generation",
            "Upstream generation repeated without meaningful new text. Generation was stopped; no automatic retry was made. Resume from the saved task state.");
        }
      }
    }
    this.push(block);
  }
}

export function endGenerationSafetyResponse(response, error) {
  if (response.writableEnded || response.destroyed) return;
  // Codex treats response.incomplete as a terminal TurnError (which also stops
  // an active goal). Generic stream-disconnected errors can be retried instead.
  if (!response.headersSent) response.removeHeader?.("content-length");
  const event = { type: "response.incomplete", response: {
    object: "response", status: "incomplete", output: [],
    incomplete_details: { reason: error.code },
    error: { code: error.code, message: error.message },
  } };
  response.end(`\n\nevent: response.incomplete\ndata: ${JSON.stringify(event)}\n\n`);
}
