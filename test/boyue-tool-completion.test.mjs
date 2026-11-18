import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import test from "node:test";
import { createBoyueToolCompletionTransform, createBoyueToolCompletionJsonTransform } from "../src/boyue-tool-completion.mjs";
import { flattenNamespaceTools, NamespaceToolCallTransform } from "../src/namespace-relay.mjs";

// Exact synthetic-provider response captured 2026-11-18; no original task text,
// auth headers or credentials. Keep the invalid argument bytes for the control.
const raw = readFileSync(new URL("./fixtures/boyue-truncated-tool.sse", import.meta.url));
const frames = bytes => bytes.toString().split(/\r?\n\r?\n/).filter(Boolean).map(s => JSON.parse(s.split(/\r?\n/).find(l => l.startsWith("data:")).slice(5)));
const events = frames(raw);
const frame = event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
const { namespaces } = flattenNamespaceTools([{ type: "namespace", name: "web", tools: [{ type: "function", name: "run" }] }]);
async function collect(stream) { let result = ""; for await (const b of stream) result += b; return result; }
const relay = (bytes, fixed = true) => {
  let stream = Readable.from([bytes]);
  if (fixed) stream = stream.pipe(createBoyueToolCompletionTransform());
  return collect(stream.pipe(new NamespaceToolCallTransform(namespaces, "text/event-stream")));
};

test("captured Boyue truncation reproduces the exact production error without the fix", async () => {
  await assert.rejects(relay(raw, false), error => error.code === "ERR_NAMESPACE_RELAY_COMMITTED_STREAM" && /ambiguous function arguments/.test(error.message));
});
test("captured truncation preserves the terminal reason and usage with zero tool dispatch events", async () => {
  const output = frames(await relay(raw));
  assert.equal(output.some(e => e.type.startsWith("response.function_call") || e.item?.type === "function_call"), false);
  const terminal = output.at(-1);
  assert.equal(terminal.type, "response.incomplete");
  assert.equal(terminal.response.incomplete_details.reason, "max_output_tokens");
  assert.deepEqual(terminal.response.usage, events.at(-1).response.usage);
  assert.deepEqual(terminal.response.output, []);
});
test("byte-split UTF-8 and CRLF transport keep the same truncation result", async () => {
  const wire = Buffer.from(raw.toString().replaceAll('\n', '\r\n'));
  const output = await collect(Readable.from([...wire].map(b => Buffer.from([b]))).pipe(createBoyueToolCompletionTransform()));
  assert.deepEqual(frames(output).at(-1).response.output, []);
});
test("ordinary completed tools retain namespace and exact arguments", async () => {
  const valid = events.map(e => JSON.parse(JSON.stringify(e)));
  for (const e of valid) {
    if (e.type === "response.function_call_arguments.done") e.arguments = '{"url":"https://example.com/中文"}';
    if (e.item?.type === "function_call" && e.type === "response.output_item.done") Object.assign(e.item, {status:"completed",arguments:'{"url":"https://example.com/中文"}'});
    if (e.type === "response.incomplete") {e.type="response.completed";e.response.status="completed";e.response.incomplete_details=null;e.response.output=[valid.find(v=>v.type==='response.output_item.done').item];}
  }
  const result=frames(await relay(Buffer.from(valid.map(frame).join(''))));
  const done=result.find(e=>e.type==='response.output_item.done');
  assert.equal(done.item.namespace,'web');assert.equal(done.item.name,'run');
  assert.equal(done.item.arguments,'{"url":"https://example.com/中文"}');
});
test("a completed tool with malformed or duplicate JSON remains rejected", async () => {
  for(const args of ['{"url"','{"url":"a","url":"b"}']) {
    const bad=events.map(e=>JSON.parse(JSON.stringify(e)));
    for(const e of bad){if(e.type==='response.function_call_arguments.done')e.arguments=args;if(e.item?.type==='function_call'&&e.type==='response.output_item.done')Object.assign(e.item,{status:'completed',arguments:args});if(e.type==='response.incomplete'){e.type='response.completed';e.response.status='completed';e.response.output=[bad.find(v=>v.type==='response.output_item.done').item];}}
    await assert.rejects(relay(Buffer.from(bad.map(frame).join(''))),{code:'ERR_NAMESPACE_RELAY_COMMITTED_STREAM'});
  }
});
test("non-streaming truncation removes incomplete tools while retaining usage", async () => {
  const response=events.at(-1).response;
  const output=JSON.parse(await collect(Readable.from([Buffer.from(JSON.stringify(response))]).pipe(createBoyueToolCompletionJsonTransform())));
  assert.deepEqual(output.output,[]);assert.deepEqual(output.usage,response.usage);
});
test("missing terminal and buffer overflow never release tools", async () => {
  for(const [bytes,options] of [[Buffer.from(events.slice(0,-1).map(frame).join('')),{}],[raw,{maxBytes:64}]]){
    const transform=createBoyueToolCompletionTransform(options);let output='';transform.on('data',b=>{output+=b;});
    await assert.rejects(collect(Readable.from([bytes]).pipe(transform)),{code:'ERR_BOYUE_TOOL_COMPLETION'});
    assert.equal(output.includes('response.output_item.added'),false);
  }
});
test("cancellation drops the buffered call without releasing dispatch events", async () => {
  const transform=createBoyueToolCompletionTransform();let output='';transform.on('data',b=>{output+=b;});
  transform.write(Buffer.from(events.slice(0,-1).map(frame).join('')));transform.destroy();
  assert.equal(output.includes('response.output_item.added'),false);
});
test("text-only stream remains byte-identical", async () => {
  const wire='event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"中文"}\n\n';
  assert.equal(await collect(Readable.from([Buffer.from(wire)]).pipe(createBoyueToolCompletionTransform())),wire);
});
test("discarding a partial tool preserves and remaps later text", async () => {
  const source=events.map(e=>JSON.parse(JSON.stringify(e)));
  const terminal=source.pop();
  const message={id:'msg_after_partial',type:'message',status:'completed',role:'assistant',content:[{type:'output_text',text:'preserved'}]};
  source.push({type:'response.output_item.added',output_index:1,item:{...message,status:'in_progress',content:[]}});
  source.push({type:'response.output_item.done',output_index:1,item:message});
  terminal.response.output.push(message);source.push(terminal);
  const out=frames(await relay(Buffer.from(source.map(frame).join(''))));
  assert.equal(out.find(e=>e.type==='response.output_item.done').output_index,0);
  assert.deepEqual(out.at(-1).response.output,[message]);
});
test("contradictory completion and snapshot identities fail closed", async () => {
  for(const change of [e=>{e.item.status='completed';},e=>{e.item.name='different_tool';}]){
    const source=events.map(e=>JSON.parse(JSON.stringify(e)));
    change(source.find(e=>e.type==='response.output_item.done'));
    await assert.rejects(collect(Readable.from([Buffer.from(source.map(frame).join(''))]).pipe(createBoyueToolCompletionTransform())),{code:'ERR_BOYUE_TOOL_COMPLETION'});
  }
});
test("outer terminal and nested status must agree before incomplete tools can be discarded", async () => {
  for (const type of ['response.completed', 'response.failed']) {
    const source = events.map(e => JSON.parse(JSON.stringify(e)));
    source.at(-1).type = type;
    await assert.rejects(collect(Readable.from([Buffer.from(source.map(frame).join(''))]).pipe(createBoyueToolCompletionTransform())), {code:'ERR_BOYUE_TOOL_COMPLETION'});
  }
});
test("explicit provider and normalizer errors preserve their code without dispatching staged calls", async () => {
  for (const code of ['upstream_stream_incomplete', 'provider_overloaded']) {
    const error = {type:'error',code,message:'Synthetic provider failure'};
    const source = Buffer.from(events.slice(0,-1).map(frame).join('') + frame(error));
    const result = frames(await collect(Readable.from([source]).pipe(createBoyueToolCompletionTransform())));
    assert.deepEqual(result.at(-1),error);
    assert.equal(result.some(e=>e.item?.type==='function_call'||e.type==='response.function_call_arguments.done'),false);
  }
});
