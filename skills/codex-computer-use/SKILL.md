---
name: codex-computer-use
description: Control local apps and browsers through the Codex app's Computer Use runtime. Use when the session uses a custom (non-OpenAI) model, for example deepseek-v4-flash or mimo-v2.5, and the user asks to control the computer, operate a desktop app's UI, use Chrome, click or type in an app, or inspect a screenshot. Prefer purpose-built connectors, APIs, or CLIs when they exist.
---

# Codex Computer Use

Use the app-provided `mcp__cua_repl__js` tool. It exposes the current `cua`
API directly. Its live tool instructions and returned documentation are
authoritative; do not bootstrap another runtime or import a browser client.

## Initialize or recover the runtime

On the first call or after a reset, execute exactly one entry-point call
listed in the live tool instructions, optionally assigning its result. Do not
add other calls, waits, output helpers, or snapshots to that invocation.
Read the returned documentation before continuing.

Choose the first matching entry point from the live instructions: a tab
mention, an existing tab's URL or ID and browser, or a new browser tab. Honor
the user's named browser. If they named Chrome or Edge and want a new tab,
call `cua.createBrowserTab(...)` directly; do not inventory browsers first.
For an inventory of enabled surfaces when that is what the task needs:

```js
await cua.getState();
```

If context begins with a summary of existing computer-use work, first call:

```js
await cua.rewriteDocumentation();
```

Read that documentation before continuing. Reuse bindings while they exist;
after reset or process recovery, reacquire the relevant tab with a documented
entry point and observed tab metadata. A variable name is not a durable tab ID.

## Rules

- Use only APIs described in the live tool instructions or returned
  documentation. Native-app control may be disabled; do not infer support
  from this skill or another machine's capabilities.
- When creating a Chrome or Edge tab, pass a short emoji-prefixed
  `sessionName`. For the in-app browser (`iab`), use its documented `visible`
  option. Do not carry options from one browser type to another.
- The entry points display their documentation or initial UI state already;
  do not wrap them in `nodeRepl.write` or `nodeRepl.emitImage`. For other
  methods, follow their live output contract instead of assuming they emit.
- Keep one CUA JavaScript session for the task. Request only the page state
  or screenshot needed for the next decision; avoid reprinting large results.
  Use targeted read-only inspection where the documented API supports it.
- Verify autofill or form completion from read-only field state or visual
  evidence; focus, a click, or a missing error does not prove a value exists.
  Autofill can hide values from page JavaScript. Do not expose secret values.
- If task authorization and tool permissions allow CAPTCHA transcription,
  preserve the observed case and character count. Corroborate uncertain OCR
  with independent evidence; variants from one recognizer are not independent.
  Use existing OCR only if the current tool instructions permit that workflow.
  If evidence remains unclear, request a fresh challenge or user assistance
  through supported interactions; do not guess or invent a handoff API.
- Respect tab ownership and failed bindings. Recovery does not authorize
  taking another active task's tab. Use a documented transfer mechanism only
  when one is available and the task permits it.
- Prefer purpose-built connectors, APIs, and CLIs when available. Never start
  a side-channel REPL, driver process, or browser-control script.

## If the tool is missing

Report that `mcp__cua_repl__js` is unavailable for this session. Do not claim
UI access or build a replacement driver.
