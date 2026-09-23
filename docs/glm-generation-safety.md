# GLM-5.3 generation recovery

A custom model's `endpoint.protocol` is its wire protocol. Omitting it keeps
the existing `openai` (Chat Completions) default. `openai-responses` selects
native Responses through the authenticated API forwarder and LiteLLM's native
Responses transport; it does not grant the separate keyless `directResponses`
bridge capability. `anthropic` selects Messages. Unsupported values fail registry
validation instead of silently falling back to Chat Completions. Endpoint
credentials and model identity remain separate from container identity.

Native Responses history retains reasoning items as reasoning. The reasoning
carry into ordinary assistant messages applies only to translated transports.

`generation-safety.mjs` protects the measured GLM-5.3 model family. It does not
lower effort or impose an output-token budget. Other model families retain
their established empty-completion and stream compatibility handling.

The streaming guard rejects contradictory completion status, a missing terminal,
and claimed success containing only reasoning or empty messages. It stops long
repetitive assistant output using a bounded 8,192-character tail and 32-character
substring diversity. Tool arguments are excluded. Partial output is not relabeled
as success. Stream pipeline failure cancels upstream reading; the HTTP owner
emits `response.incomplete`, which Codex treats as a terminal turn error rather
than a retryable disconnection. Before any output is relayed, failure is HTTP 400.
These failures do not trigger router retry or failover.
Answers and refusals delivered only through text-done, refusal-done or content-part
events also count as visible content, matching the upstream empty-response guard.

The request recovery path detects long repetitive assistant messages and exact
whole-paragraph duplication of at least 80 characters per copy (the early signal
in the second incident). Only when this evidence exists, ordinary assistant
narration is quarantined in the outbound request. One recovery marker replaces
it. User/developer messages, tool calls/results, refusals and multimodal content
are preserved, and the durable task transcript is never rewritten. This favors
reconstructing progress from tool evidence over trusting corrupted narration;
assistant-only notes may need to be recovered from the saved task transcript.

Before an internal goal continuation, three consecutive short, tool-free goal
turns with substantially repeated replies or repeated pause acknowledgements
produce `router_goal_no_progress`. A real user turn, tool activity or changed
objective resets the check. It counts goal turns, not individual commentary
messages. No goal is falsely marked complete or blocked. The router does not
write Codex's goal database: Codex's existing TurnError handling owns stopping
the active goal. An explicit new user request remains able to proceed.

These are evidence-based guards, not a general semantic proof of progress.
Long unique reasoning, slightly repeated short text, and unproductive sequences
of different tool calls can require separate diagnosis. Legitimately requested
highly repetitive prose can also trip the guard. An upstream/model defect may
still occur, but the measured failures no longer masquerade as successful turns
or keep replaying the same damaged history automatically.

Request-history recovery is selected for the initial model. A configured failover
to another model reuses that prepared history; entering GLM through failover does
not rerun the history or goal checks. Stream protection follows the actual model.

Regression coverage:

```sh
node --test test/custom-protocol.test.mjs test/generation-safety.test.mjs test/empty-completion-router.test.mjs test/routing.test.mjs test/registry.test.mjs
npm run check
```

Wire tests assert the destination path, request shape, credential isolation,
reasoning preservation, upstream cancellation, zero retry, and a goal request
blocked before contacting the provider. Real-provider checks additionally need
operator authorization and must verify function namespaces, custom tools, tool
result continuation and reasoning usage; an outer `/responses` URL alone is not
evidence of native transport.
