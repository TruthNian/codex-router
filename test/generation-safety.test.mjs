import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import test from "node:test";
import { GenerationSafetyTransform, prepareGenerationInput, repetitiveText } from "../src/generation-safety.mjs";

const event = (type, rest = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...rest })}\n\n`;
const completed = event("response.completed", { response: { status: "completed", output: [] } });
async function transform(raw, options = {}, bytewise = false) {
  let result = "";
  const bytes = Buffer.from(raw);
  await pipeline(Readable.from(bytewise ? [...bytes].map((v) => Buffer.from([v])) : [bytes]),
    new GenerationSafetyTransform(options), new Writable({ write(chunk, encoding, cb) { result += chunk; cb(); } }));
  return result;
}

test("clean reasoning, UTF-8, tool lifecycle and usage survive arbitrary packet boundaries", async () => {
  const raw = event("response.reasoning_text.delta", { delta: "分析中。" }) +
    event("response.output_item.done", { item: { type: "function_call", name: "exec", arguments: JSON.stringify({ code: "a".repeat(9000) }) } }) + completed;
  assert.equal(await transform(raw, { repetition: true }, true), raw);
});
test("completed/incomplete contradiction and missing terminal fail before success", async () => {
  await assert.rejects(transform(event("response.completed", { response: { status: "incomplete" } })), { code: "router_incomplete_response" });
  await assert.rejects(transform(event("response.output_text.delta", { delta: "partial" }) + "data: [DONE]\n\n"), { code: "router_missing_terminal" });
  const raw = event("response.incomplete", { response: { status: "incomplete" } });
  assert.equal(await transform(raw), raw);
  await assert.rejects(transform(event("response.completed", { response: { status: "completed", output: [{ type: "reasoning", content: [{ type: "output_text", text: "thinking" }] }] } })), { code: "router_empty_generation" });
});
test("repeated prose stops, including a large single delta; unrelated models remain unchanged", async () => {
  const raw = event("response.output_text.delta", { delta: "我会继续检查并修复这个错误，然后验证结果。".repeat(500) }) + completed;
  await assert.rejects(transform(raw, { repetition: true }), { code: "router_repetitive_generation" });
  assert.equal(await transform(raw), raw);
  const unique = Array.from({ length: 1800 }, (_, i) => `${i.toString(36)}: ${Math.sin(i)} variable content;`).join("\n");
  assert.equal(repetitiveText(unique), false);
  assert.equal(await transform(event("response.output_text.delta", { delta: unique }) + completed, { repetition: true }), event("response.output_text.delta", { delta: unique }) + completed);
});
test("request recovery does not mutate original history, user text or tool evidence", () => {
  const text = "重复状态，没有新的操作。".repeat(800);
  const input = [{ role: "user", content: text }, { role: "assistant", content: text },
    { type: "function_call", name: "exec", call_id: "a", arguments: "{}" }, { type: "function_call_output", call_id: "a", output: text }];
  const before = structuredClone(input);
  const next = prepareGenerationInput(input);
  assert.deepEqual(input, before);
  assert.equal(next[0], input[0]);
  assert.equal(next[2], input[2]);
  assert.equal(next[3], input[3]);
  assert.match(next[1].content[0].text, /original remains/);
  assert.ok(next[1].content[0].text.length < 1000);
  const paragraph = "This prior assistant paragraph announced the next step but executed no tool, then was accidentally copied twice. ";
  const shortCorruption = [{ role: "assistant", content: paragraph.repeat(2).trim() }];
  // Preserve the paragraph's internal spacing at the duplicate boundary.
  shortCorruption[0].content = paragraph.trim().repeat(2);
  assert.match(prepareGenerationInput(shortCorruption)[0].content[0].text, /quarantined/);
  const healthy = [{ role: "assistant", content: paragraph }];
  assert.equal(prepareGenerationInput(healthy), healthy);
});
test("only repeated automatic goal replies trip stagnation; new users and tools reset it", () => {
  const goal = { role: "user", content: '<codex_internal_context source="goal">\nContinue working toward the active thread goal.' };
  const answer = { role: "assistant", content: "已暂停测试，保存的证据和脚本可以在下一次任务继续使用。" };
  const input = [goal, answer, goal, answer, goal, answer, goal];
  assert.throws(() => prepareGenerationInput(input), { code: "router_goal_no_progress" });
  assert.doesNotThrow(() => prepareGenerationInput([...input, { role: "user", content: "继续" }]));
  assert.doesNotThrow(() => prepareGenerationInput([...input.slice(0, -1), { type: "function_call_output", output: "fresh evidence" }, goal]));
  const chapters = ["第一章：群星在夜幕中闪耀，船员离开码头前往遥远的海岸。", "第二章：清晨的花园飘散着桂花香气，小女孩找到了走失的小猫。", "第三章：工程师解释了电路的工作原理，并详细介绍电阻和电容的区别。"];
  let chapter = 0;
  assert.doesNotThrow(() => prepareGenerationInput(input.map((item) => item === answer ? { ...answer, content: chapters[chapter++] } : item)));
  assert.doesNotThrow(() => prepareGenerationInput([goal, answer, answer, answer, goal]), "three messages inside one turn are not three goal turns");
});
