import { createHash } from "node:crypto";

// Tool results are replayed on every following turn. A single large command
// output can therefore cost its full size many times after the model has
// already acted on it. Keep the policy deliberately narrow: only old, textual
// results above this floor qualify, and the newest result frontier stays
// byte-for-byte intact on ordinary turns. RTK-style shaping is reserved for an
// actual routed compaction request, after the client has decided it needs one.
export const TOOL_RESULT_AGING_MIN_BYTES = 32 * 1024;
export const TOOL_RESULT_AGING_FRONTIER = 4;
export const DENSE_SHAPING_MIN_BYTES = 8 * 1024;

const PREVIEW_CODE_UNITS = 1_024;
const DENSE_SHAPING_MIN_SAVED_BYTES = 1_024;
const DENSE_SHAPING_RECEIPT_PREFIX =
  "[Tool result shaped by Codex Router RTK-style compaction:";
const LEGACY_TOKEN_MAXXING_RECEIPT_PREFIX =
  "[Tool result shaped by Codex Router token maxxing:";
const OUTPUT_TYPES = new Set(["function_call_output", "custom_tool_call_output"]);
const MODEL_ACTION_TYPES = new Set([
  "function_call",
  "custom_tool_call",
  "reasoning",
]);

function modelActed(item) {
  if (MODEL_ACTION_TYPES.has(item?.type)) return true;
  return item?.type === "message" && item.role === "assistant";
}

function textualOutput(item) {
  if (!OUTPUT_TYPES.has(item?.type)) return undefined;
  if (typeof item.output === "string") return item.output;
  if (!Array.isArray(item.output)) return undefined;
  const text = [];
  for (const part of item.output) {
    if (
      !part ||
      typeof part !== "object" ||
      !["input_text", "text"].includes(part.type) ||
      typeof part.text !== "string"
    ) {
      return undefined;
    }
    text.push(part.text);
  }
  return text.join("");
}

function safeHead(value) {
  let end = Math.min(value.length, PREVIEW_CODE_UNITS);
  if (end < value.length && /[\uD800-\uDBFF]/u.test(value[end - 1])) end -= 1;
  return value.slice(0, end);
}

function safeTail(value) {
  let start = Math.max(0, value.length - PREVIEW_CODE_UNITS);
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(value[start])) start += 1;
  return value.slice(start);
}

function leadingIndent(value) {
  const match = /^( *)\S/u.exec(value);
  return match ? match[1].length : 0;
}

const IMPORTANT_LINE =
  /\b(error|failed?|failure|exception|fatal|panic|traceback|warning|denied|invalid|security)\b/iu;

function collapseTerminalRewrites(value) {
  return value
    .replace(/\r\n/gu, "\n")
    .split("\n")
    .map((line) => {
      if (!line.includes("\r")) return line;
      const rewrites = line.split("\r");
      const final = rewrites.findLast((entry) => entry.length > 0) ?? "";
      const important = rewrites.filter(
        (entry) => entry !== final && IMPORTANT_LINE.test(entry),
      );
      return [...important, final].join("\n");
    })
    .join("\n");
}

function collapseRepeatedLines(lines) {
  const compacted = [];
  for (let index = 0; index < lines.length; ) {
    const line = lines[index];
    let end = index + 1;
    while (end < lines.length && lines[end] === line) end += 1;
    const count = end - index;
    if (count >= 3 && line.trim()) {
      const marker = `[same line repeated ${count - 1} more times]`;
      const replacement = `${line}\n${marker}`;
      const originalLength = line.length * count + count - 1;
      if (replacement.length < originalLength) {
        compacted.push(line, marker);
      } else {
        compacted.push(...lines.slice(index, end));
      }
    } else if (!line.trim() && count > 1) {
      compacted.push(line);
    } else {
      compacted.push(...lines.slice(index, end));
    }
    index = end;
  }
  return compacted;
}

function collapseDeeplyIndentedBlocks(lines) {
  const compacted = [];
  for (let index = 0; index < lines.length; ) {
    if (leadingIndent(lines[index]) < 8 || IMPORTANT_LINE.test(lines[index])) {
      compacted.push(lines[index]);
      index += 1;
      continue;
    }
    let end = index + 1;
    while (
      end < lines.length &&
      leadingIndent(lines[end]) >= 8 &&
      !IMPORTANT_LINE.test(lines[end])
    ) {
      end += 1;
    }
    const count = end - index;
    if (count >= 8) {
      const marker = `[${count - 2} deeply indented lines omitted]`;
      const replacement = `${lines[index]}\n${marker}\n${lines[end - 1]}`;
      let originalLength = count - 1;
      for (let cursor = index; cursor < end; cursor += 1) {
        originalLength += lines[cursor].length;
      }
      if (replacement.length < originalLength) {
        compacted.push(lines[index], marker, lines[end - 1]);
      } else {
        compacted.push(...lines.slice(index, end));
      }
    } else {
      compacted.push(...lines.slice(index, end));
    }
    index = end;
  }
  return compacted;
}

// A deliberately small, deterministic RTK-style shaper. It removes terminal
// progress rewrites, exact repetition, blank-line runs, and deep boilerplate,
// while preserving error-bearing lines. The caller keeps a digest and readback
// instruction because this is a lossy compaction optimization.
export function shapeToolResult(value) {
  if (typeof value !== "string" || !value) return value;
  const normalized = collapseTerminalRewrites(value);
  const repeated = collapseRepeatedLines(normalized.split("\n"));
  const shaped = collapseDeeplyIndentedBlocks(repeated).join("\n");
  return shaped.length < value.length ? shaped : value;
}

function shapedResult(value, recovery) {
  if (
    value.startsWith(DENSE_SHAPING_RECEIPT_PREFIX) ||
    value.startsWith(LEGACY_TOKEN_MAXXING_RECEIPT_PREFIX)
  ) {
    return undefined;
  }
  const shaped = shapeToolResult(value);
  if (shaped === value) return undefined;
  const before = Buffer.byteLength(value, "utf8");
  const shapedBytes = Buffer.byteLength(shaped, "utf8");
  const digest = createHash("sha256").update(value, "utf8").digest("hex");
  const receipt = [
    `${DENSE_SHAPING_RECEIPT_PREFIX} ${before} -> ${shapedBytes} bytes, sha256:${digest}.`,
    `${recovery} Only this routed copy was shaped.]`,
    "",
    shaped,
  ].join("\n");
  const after = Buffer.byteLength(receipt, "utf8");
  return before - after >= DENSE_SHAPING_MIN_SAVED_BYTES ? receipt : undefined;
}

function resultReceipt(value, recovery) {
  const bytes = Buffer.byteLength(value, "utf8");
  const digest = createHash("sha256").update(value, "utf8").digest("hex");
  return [
    `[Older tool result compacted by Codex Router after the model acted on it: ${bytes} bytes, sha256:${digest}.`,
    `${recovery} Only this routed copy was compacted.]`,
    "",
    "--- beginning of original result ---",
    safeHead(value),
    "--- omitted middle of original result ---",
    safeTail(value),
    "--- end of original result ---",
  ].join("\n");
}

function callNames(input) {
  const names = new Map();
  for (const item of input) {
    if (
      ["function_call", "custom_tool_call"].includes(item?.type) &&
      typeof item.call_id === "string" &&
      typeof item.name === "string"
    ) {
      names.set(item.call_id, item.name);
    }
  }
  return names;
}

// Cua bootstraps its API contract in a tool result. It is still needed after
// later actions, unlike an old page snapshot. Match both the originating tool
// and documentation headings; ordinary Cua results remain eligible for aging.
function cuaDocumentationCalls(input) {
  return new Set(input.filter((item) =>
    ["function_call", "custom_tool_call"].includes(item?.type) &&
    ((item.namespace === "mcp__cua_repl" && item.name === "js") ||
      item.name === "mcp__cua_repl__js" || item.name === "mcp__cua_repl.js")
  ).map((item) => item.call_id));
}

function isCuaDocumentation(value) {
  return (/^## Computer Use\r?$/mu.test(value) && /^## API\r?$/mu.test(value)) ||
    (/^# Other Browser APIs\r?$/mu.test(value) && /^# API Reference\r?$/mu.test(value));
}

const INSTRUCTION_REFERENCE = /(?:^|[^\w.-])(?:AGENTS|SKILL|CLAUDE|GEMINI)\.md(?![\w.-])|skill:\/\//iu;
const instructionPath = value => typeof value === "string" &&
  /(?:^|[\\/])(?:AGENTS|SKILL|CLAUDE|GEMINI)\.md$|^skill:\/\//iu.test(value);
const readPaths = args => typeof args === "string" ? [args] : Array.isArray(args) ? args :
  [args?.path, args?.paths, args?.file_path, args?.filePath, args?.file, args?.filename, args?.resource, args?.uri].flat();

function readKind(name) {
  if (/(?:^|[_.])skills?[_.]+read(?:$|[_.])|(?:^|[_.])(?:read|rewrite|get)[_]?documentation$/iu.test(name)) return "documentation";
  if (/(?:^|[_.])(?:read_(?:file|text_file|multiple_files|files)|readFileSync|readFile|read_text)$/u.test(name)) return "file";
  if (/(?:^|[_.])(?:exec_command|shell_command|run_shell_command)$/u.test(name)) return "command";
  if (/(?:^|[_.])functions\.exec$|(?:^|[_.])mcp__cua_repl[_.]+js$/u.test(name)) return "script";
  return undefined;
}

function searchReadsInstructions(words) {
  let pattern = false, glob = false, files = false, options = true;
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index];
    if (options && word === "--") { options = false; continue; }
    if (options && /^(?:--files|--files-with-matches|--files-without-match|--count|--count-matches|-[lLc])$/u.test(word)) return false;
    if (options && /^(?:-e|--regexp|-f|--file|-g|--glob|--iglob)$/u.test(word)) {
      const value = words[++index];
      if (/^(?:-e|--regexp|-f|--file)$/u.test(word)) pattern = true;
      else glob ||= instructionPath(value);
    } else if (options && /^(?:--regexp=|--file=|-[ef].)/u.test(word)) {
      pattern = true;
    } else if (options && /^(?:--(?:i?glob)=|-g.)/u.test(word)) {
      glob ||= instructionPath(word.replace(/^(?:--(?:i?glob)=|-g)/u, ""));
    } else if (options && /^(?:-[ABCm]|--(?:after-context|before-context|context|max-count))$/u.test(word)) {
      index += 1;
    } else if (options && /^(?:-[ABCm]\d+|--(?:after-context|before-context|context|max-count)=\d+)$/u.test(word)) {
      continue;
    } else if (options && word.startsWith("-")) {
      if (!/^(?:-[niNHhUuv]+|--hidden|--no-ignore|--line-number|--column|--heading|--no-heading)$/u.test(word)) return undefined;
    } else if (!pattern) pattern = true;
    else files ||= instructionPath(word);
  }
  return glob || files;
}

// This is a bounded recognizer, not a shell interpreter. Quoted data remains
// one word; unknown commands/expansions involving instruction files stay intact.
function shellReadsInstructions(command) {
  if (typeof command !== "string") return false;
  const tokens = command.match(/"(?:`[\s\S]|\\[\s\S]|[^"\\])*"|'(?:''|[^'])*'|[|;&\r\n]+|[<>]+|[^\s"'|;&<>]+/gu) ?? [];
  const segments = [[]];
  for (const token of tokens) {
    if (/^[|;&\r\n]+$/u.test(token)) segments.push([]);
    else segments.at(-1).push(token);
  }
  let uncertain = false;
  for (const segment of segments) {
    const comment = segment.findIndex(word => word.startsWith("#"));
    const raw = comment < 0 ? segment : segment.slice(0, comment);
    if (!raw.length) continue;
    if (raw.some(word => !word.startsWith("'") && /\$\(|`/u.test(word))) { uncertain = true; continue; }
    const words = raw.map(word => /^["']/u.test(word) ? word.slice(1, -1).replaceAll("''", "'") : word);
    const name = words[0].toLowerCase();
    if (["echo", "printf", "write-output", "write-host"].includes(name)) continue;
    const redirect = words.findIndex(word => word.startsWith(">"));
    const args = redirect < 0 ? words : words.slice(0, redirect);
    if (name === "rg" || name === "rg.exe") {
      const result = searchReadsInstructions(args);
      if (result === true) return true;
      uncertain ||= result === undefined;
    } else if (["get-content", "gc", "cat", "head", "tail", "type", "sed"].includes(name)) {
      const paths = args.slice(1).filter(word => !word.startsWith("-"));
      if (name === "sed") paths.shift(); // The first positional argument is a script.
      if (paths.some(instructionPath)) return true;
    } else uncertain = true;
  }
  return uncertain && INSTRUCTION_REFERENCE.test(command);
}

function scriptString(token) {
  if (!token || !/^["'`]/u.test(token) || (token.startsWith("`") && token.includes("${"))) return undefined;
  try {
    return token.slice(1, -1).replace(/\\(u[\da-fA-F]{4}|x[\da-fA-F]{2}|[\s\S])/gu, (_, escape) => {
      if (/^[ux]/u.test(escape) && escape.length > 1) return String.fromCharCode(parseInt(escape.slice(1), 16));
      return ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0" })[escape] ?? escape;
    });
  } catch { return undefined; }
}

// Inspect call tokens, never execute wrapper code. Strings and comments cannot
// turn a printed code example into a read. Dynamic read arguments fail closed.
function scriptReadsInstructions(code) {
  if (typeof code !== "string") return false;
  const tokens = (code.match(/\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|[A-Za-z_$][\w$]*|[^\s]/gu) ?? [])
    .filter(token => !token.startsWith("//") && !token.startsWith("/*"));
  let uncertain = tokens.some(token => token.startsWith("`") && token.includes("${"));
  for (let index = 1; index < tokens.length; index += 1) {
    if (tokens[index] === "(" && ["]", ")"].includes(tokens[index - 1])) uncertain = true;
    if (tokens[index] !== "(" || !/^[A-Za-z_$][\w$]*$/u.test(tokens[index - 1])) continue;
    let start = index - 1;
    while (start >= 2 && tokens[start - 1] === "." && /^[A-Za-z_$][\w$]*$/u.test(tokens[start - 2])) start -= 2;
    const name = tokens.slice(start, index).join("");
    const kind = readKind(name);
    if (kind === "documentation") return true;
    if (kind === "file" || kind === "command") {
      let args = scriptString(tokens[index + 1]);
      if (tokens[index + 1] === "{") {
        args = {};
        let depth = 1;
        for (let field = index + 2; field < tokens.length && depth > 0; field += 1) {
          if (tokens[field] === "{") depth += 1;
          else if (tokens[field] === "}") depth -= 1;
          else if (depth === 1 && tokens[field + 1] === ":") args[scriptString(tokens[field]) ?? tokens[field]] = scriptString(tokens[field + 2]);
        }
      }
      if (kind === "command") {
        const command = typeof args === "string" ? args : args?.cmd ?? args?.command;
        if (typeof command === "string") { if (shellReadsInstructions(command)) return true; }
        else uncertain = true;
      } else {
        const paths = readPaths(args);
        if (paths.some(instructionPath)) return true;
        if (!paths.some(value => typeof value === "string")) uncertain = true;
      }
    } else if (!["text", "notify", "console.log", "nodeRepl.write", "JSON.stringify", "Promise.all", "Promise.allSettled"].includes(name)) uncertain = true;
  }
  return uncertain && INSTRUCTION_REFERENCE.test(code);
}

function instructionReadCalls(input) {
  const ids = new Set();
  for (const item of input) {
    if (!["function_call", "custom_tool_call"].includes(item?.type)) continue;
    const kind = readKind([item.namespace, item.name].filter(Boolean).join("."));
    let args = item.arguments ?? item.input ?? {};
    if (typeof args === "string") { try { args = JSON.parse(args); } catch {} }
    if (kind === "documentation" ||
      (kind === "file" && readPaths(args).some(instructionPath)) ||
      (kind === "command" && shellReadsInstructions(typeof args === "string" ? args : args?.cmd ?? args?.command ?? "")) ||
      (kind === "script" && scriptReadsInstructions(typeof args === "string" ? args : args?.code ?? ""))) ids.add(item.call_id);
  }
  return ids;
}

export function ageToolResults(
  input,
  {
    enabled = true,
    minBytes = TOOL_RESULT_AGING_MIN_BYTES,
    frontier = TOOL_RESULT_AGING_FRONTIER,
    denseShaping = false,
    retain,
  } = {},
) {
  const empty = {
    toolResultsAged: 0,
    toolResultBytesBefore: 0,
    toolResultBytesAfter: 0,
    toolResultBytesSaved: 0,
  };
  // A disabled pass reports nothing beyond the zeroed counters, so "off" stays
  // distinguishable from "on and nothing qualified" -- two states this used to
  // report identically, leaving no way to prove the pass had run at all.
  if (!enabled || !Array.isArray(input)) return { input, stats: empty };

  const outputIndexes = [];
  const actedAfter = new Array(input.length).fill(false);
  let laterModelAction = false;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    actedAfter[index] = laterModelAction;
    if (modelActed(input[index])) laterModelAction = true;
  }
  for (let index = 0; index < input.length; index += 1) {
    if (OUTPUT_TYPES.has(input[index]?.type)) outputIndexes.push(index);
  }
  const protectedIndexes = new Set(frontier > 0 ? outputIndexes.slice(-frontier) : []);
  const names = callNames(input);
  const cuaCalls = cuaDocumentationCalls(input);
  const instructionReads = instructionReadCalls(input);
  let changed = false;
  let toolResultsAged = 0;
  let toolResultsShaped = 0;
  let toolResultBytesBefore = 0;
  let toolResultBytesAfter = 0;
  let toolResultShapeBytesSaved = 0;
  // What the pass looked at, recorded whether or not anything qualified. A
  // session can spend its whole context on results that each sit under the
  // floor, and without these the outcome is indistinguishable from the pass
  // never running. The largest result seen says which it was: compare it
  // against minBytes.
  let toolResultsEvaluated = 0;
  let toolResultBytesLargest = 0;
  const replacements = new Map();
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    const protectedResult = protectedIndexes.has(index);
    if (protectedResult && !denseShaping) continue;
    const value = textualOutput(item);
    if (value === undefined) continue;
    // Preserve the original item, including structured parts, for both ordinary
    // aging and dense compaction. Do not archive or rewrite runtime instructions.
    if (instructionReads.has(item.call_id) ||
        (cuaCalls.has(item.call_id) && isCuaDocumentation(value))) continue;
    if (value.startsWith("[Older tool result compacted by Codex Router") ||
        value.startsWith(DENSE_SHAPING_RECEIPT_PREFIX) ||
        value.startsWith(LEGACY_TOKEN_MAXXING_RECEIPT_PREFIX)) continue;
    const size = Buffer.byteLength(value, "utf8");
    if (!protectedResult) {
      toolResultsEvaluated += 1;
      if (size > toolResultBytesLargest) toolResultBytesLargest = size;
    }
    const canAge = !protectedResult && size > minBytes && actedAfter[index];
    // A digest and a rerun suggestion are not recovery. Without an actually
    // committed snapshot and a usable readback path, leave the result intact.
    const eligibleShape = denseShaping && size > DENSE_SHAPING_MIN_BYTES &&
      !value.startsWith(DENSE_SHAPING_RECEIPT_PREFIX) &&
      !value.startsWith(LEGACY_TOKEN_MAXXING_RECEIPT_PREFIX) &&
      shapeToolResult(value) !== value;
    if ((!canAge && !eligibleShape) || typeof retain !== "function") continue;
    let recovery;
    try {
      recovery = retain(value, { callId: item.call_id, tool: names.get(item.call_id), index });
    } catch {
      continue;
    }
    if (typeof recovery !== "string" || !recovery) continue;
    let receipt;
    let shaped = false;
    if (canAge) {
      receipt = resultReceipt(value, recovery);
    } else if (denseShaping && size > DENSE_SHAPING_MIN_BYTES) {
      receipt = shapedResult(value, recovery);
      shaped = receipt !== undefined;
    }
    if (!receipt) continue;
    const rewritten = { ...item, output: receipt };
    // Count model-visible text rather than serializing the whole item again.
    // The request path will serialize once later; avoiding a second copy here
    // matters when the result itself is hundreds of megabytes.
    const before = size;
    const after = Buffer.byteLength(receipt, "utf8");
    if (after >= before) continue;
    changed = true;
    if (shaped) {
      toolResultsShaped += 1;
      toolResultShapeBytesSaved += before - after;
    } else {
      toolResultsAged += 1;
    }
    toolResultBytesBefore += before;
    toolResultBytesAfter += after;
    replacements.set(index, rewritten);
  }
  const next = changed
    ? input.map((item, index) => replacements.get(index) ?? item)
    : input;
  const toolResultBytesSaved = toolResultBytesBefore - toolResultBytesAfter;
  return {
    input: next,
    stats: {
      toolResultsAged,
      toolResultsShaped,
      toolResultBytesBefore,
      toolResultBytesAfter,
      toolResultBytesSaved,
      toolResultShapeBytesSaved,
      toolResultsEvaluated,
      toolResultBytesLargest,
    },
  };
}
