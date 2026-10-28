# Per-model history policy

English · [简体中文](zh-CN/tool-result-model-policy.md) · [日本語](ja/tool-result-model-policy.md)

The default remains 32KiB, with native OpenAI aging disabled. Explicit model
settings in the private `tool-result-aging.json` file can opt a routed model
into a smaller size floor and a local readback notice:

```json
{
  "version": 1,
  "enabled": true,
  "nativeEnabled": false,
  "retentionTtlDays": 7,
  "modelMinBytes": {"custom/z-ai/glm-5.3": 16384},
  "readbackHintModels": ["custom/z-ai/glm-5.3"]
}
```

Size floors must be integers between 8192 and 32768 bytes. Invalid entries use
the existing default. Ordinary toggles and retention changes preserve these
model choices. Exported validated setters are `setToolResultAgingMinBytes`
and `setToolResultReadbackHint` in `src/tool-result-aging-state.mjs`; omitting
the size resets that model's floor, and setting the hint to false removes it.
Settings are read for each request after the new runtime has been adopted.
The notice policy falls back to the existing 32KiB behavior when the planned
model-visible text savings are below 128KiB, avoiding a probe for small histories.

The notice is off by default. It adds a wire-only developer message only when
the Router has committed exact original text but has not observed a valid
same-context local readback proof. It asks for one read-only `--limit 1` probe;
it does not bypass proof, force a tool choice, execute a tool, or change the
client's saved history. The
notice is suppressed after an unsuccessful read attempt, including a malformed,
forged, expired or different-scope receipt, so it does not create an automatic
probe loop. Full text and the recovery footer remain available for an explicit
read. Signed proofs in bounded Desktop JSON result
wrappers are decoded and verified with the same signature, expiry and scope
checks as direct exec output; wrapping is never permission to omit data.
Normal function-call arguments remain exact. The
newest four results, unconsumed results, mixed image outputs, tool-less calls,
failed archive writes and unverified access retain the existing protections.

A smaller request is not necessarily cheaper: probes and retrieval add model
calls, and rewriting an old prefix may lose cache hits. Validate real token
usage, settled provider fees and task correctness before enabling a model.

For exact lookup across matching archives, see [scoped archive search](tool-result-scope-search.md).
