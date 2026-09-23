---
name: codex-in-app-browser
description: Drive the Codex in-app browser to open, navigate, click, type, inspect, or screenshot pages. Use when the session uses a custom (non-OpenAI) model, for example deepseek-v4-flash or mimo-v2.5, and the user asks to use the in-app browser or test a page in the Codex browser panel.
---

# Codex In-App Browser

Use the app-provided `mcp__cua_repl__js` tool. Its live tool instructions and
returned documentation define the `cua` API; do not import a browser client
or bootstrap another runtime.

## Open or recover a tab

On the first call or after a reset, execute exactly one entry-point call
listed in the live tool instructions, optionally assigning its result. Do not
add other calls, waits, output helpers, or snapshots to that invocation.
Read the returned documentation before continuing.

Follow the live entry-point priority: recover a user-mentioned or existing
tab through `cua.getTab(...)` before creating a replacement. For a new URL
in the requested in-app browser, create the tab directly:

```js
let tab = await cua.createBrowserTab("iab", "https://example.com", { visible: true });
```

Use `visible: false` only when a hidden tab suits the task. If an inventory
of enabled surfaces is needed instead:

```js
await cua.getState();
```

If context begins with a summary of existing browser work, first call:

```js
await cua.rewriteDocumentation();
```

Read that documentation before continuing. Reuse a tab binding while it
exists; after reset or process recovery, reacquire it through a documented
entry point using observed tab metadata. Do not assume JavaScript bindings
survive a new process or that a tab is available to a different active task.

## Rules

- Use only APIs described in the live tool instructions or returned
  documentation, including any mechanism for continuing work across turns.
- The entry points display documentation or initial UI state already; do not
  wrap them in `nodeRepl.write` or `nodeRepl.emitImage`. For other methods,
  follow their documented output contract.
- Keep one CUA JavaScript session for the task. Avoid duplicate state output;
  request screenshots only when visual evidence helps the next decision and
  prefer targeted read-only inspection when the documented API supports it.
- If `iab` is unavailable, report that condition. Honor the user's browser
  choice rather than silently switching to another browser.
- Verify autofill and form completion from field state or visual evidence,
  without exposing secret values; a click or missing error is insufficient.
- `open_in_codex` opens a panel; it does not inspect or interact with content.
  Use `mcp__cua_repl__js` for browser interaction.
- Never start a side-channel REPL, driver process, or browser-control script.

## If the tool is missing

Report that `mcp__cua_repl__js` is unavailable for this session. Do not claim
browser access or build a replacement driver.
