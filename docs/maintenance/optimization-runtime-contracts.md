# Optimization runtime contracts

This reference describes the current implementation boundaries. It supplements
[AGENTS.md](../../AGENTS.md), rather than introducing a separate maintenance workflow.

## Adopted routes determine dependencies

[route-execution-plan.mjs](../../src/route-execution-plan.mjs) consumes an already
loaded registry and explicit provider selection. Its frozen plan includes every
selected callable route, including picker-hidden and `listed: false` models.
Credential readiness and picker visibility do not remove required listeners:
an unavailable credential should produce the provider's actionable error.
Enabled generic descriptors participate through the same effective-provider
resolver, including per-model protocols and verified overrides.

| Effective route | Required execution services |
| --- | --- |
| Native GPT | No routed dependency |
| Actual OpenAI Responses protocol | API forwarder |
| Chat Completions or Anthropic Messages | API forwarder and LiteLLM |
| Keyless Ollama adapter | Ollama and LiteLLM |
| Supported OAuth adapter | Its forwarder and LiteLLM |

An HTTP or WebSocket Responses endpoint can skip LiteLLM. A Chat or Messages
endpoint does not become a Responses endpoint by removing its translator.
Mixed selections retain every required service. A pending Antigravity proof
adds its temporary listener before selection, without publishing its models or
adding a gateway dependency merely for the proof. Proof promotion does not
change an otherwise unchanged route fingerprint.

The fingerprint covers explicit routing, provider, endpoint, and client
capability metadata. It excludes credential/header values, URL credentials,
and independently stored state such as Vertex project/location or overlay files.
[start.mjs](../../src/start.mjs) and [router.mjs](../../src/router.mjs) adopt it
at process startup; staged state cannot make an old process report new routes.

## Liveness, readiness, and installation

The frontend boots first. `/health/live` confirms its listener; `/health`
returns 200 only when all adopted dependencies are reachable, otherwise 503
with fixed dependency names and the adopted fingerprint. Unused dependencies
are disabled. Missing Python or an exhausted dependency restart allowance can
leave independent native/direct routes serving with degraded readiness.
Full readiness still gates publication and pending-proof activation.

[runtime-dependency-preparation.mjs](../../src/runtime-dependency-preparation.mjs)
prepares missing Node dependencies before importing route requirements and
prepares Python only when those routes need LiteLLM. Matching dependency trees
are reused. The two installer modes have different mutation boundaries:

| Mode in [bin/install](../../bin/install) / [install.ps1](../../install.ps1) | Mutation boundary |
| --- | --- |
| `--dependencies-only` / `-CheckoutInstall -DependenciesOnly` | Dependency trees and their fingerprints; no authentication, provider-selection, generated gateway/client, service, or ownership-transfer writes |
| `--prepare-only` / `-CheckoutInstall -PrepareOnly` | Dependencies, router keys, and required gateway inputs; no client configuration/catalog publication, service installation, or ownership handoff |

Prepare-only is not read-only. Explicit `--force-deps`, `-ForceDeps`, and
checkout `doctor --fix` retain their full Node **and Python** rebuild contract,
including on a native/Responses-only installation. Package-managed dependency
trees remain the package manager's responsibility.

## Prepare, adopt, then publish clients

[model-overlay-publication.mjs](../../src/model-overlay-publication.mjs) captures
the previous state only after acquiring the publication lock, mutates it,
prepares dependencies and gateway inputs in fresh processes, and obtains the
candidate fingerprint. It then restarts/adopts the candidate where requested,
verifies the healthy running router's fingerprint, and publishes installed
clients from a fresh registry that still matches that fingerprint.

[router-restart.mjs](../../src/router-restart.mjs) permits offline publication
only after confirmed connection refusal, a known absent/unloaded managed
service, and a second refusal check. A stopped installed service, unknown
owner, degraded router, or mismatched fingerprint is not that offline case.
Native profile switching explicitly permits this confirmed offline boundary
for its read-only guards, compares the fresh and already loaded route
fingerprints, and publishes inside its account/model/catalog locks. Event-driven
refresh still requires healthy adoption. Failed OS service queries remain
unknown; they cannot establish absence. Managed restart progress is relayed to
stderr so JSON command output remains parseable.

A failed transaction restores the exact durable snapshot and repeats
preparation/adoption/publication for the previous state with a reserved rollback
budget. Successful rollback preserves the original failure; failed rollback
produces an aggregate error. Irreversible physical operations can report
publication warnings, but rollback itself does not downgrade errors to warnings.

The transaction ceiling is 45 minutes. Before mutation it reserves the full
forward and rollback preparation/adoption/publication epochs plus restoration
of the actual prior private files. A transaction that cannot fit is rejected
before mutation. The 60-second mutation allowance is checked when synchronous
I/O returns; it is not preemptive cancellation of that I/O. Desktop and control
owners reserve their cleanup time outside the inner transaction deadline.

[provider-key.mjs](../../src/provider-key.mjs) uses this transaction for ordinary
installed credential set/remove operations. Guided setup explicitly passes
`--stage` to store credentials and selections before installer finalization;
staging does not prepare dependencies, restart a service, or publish clients.
Automated secret input uses bounded `--stdin`, keeping the value out of argv.
Environment-backed key-pool changes likewise stage metadata until installation
persists the service environment or the foreground process is restarted and
applied. OAuth disconnection keeps its irreversible fence rather than restoring
old credentials after a publication warning.

## Delivery evidence differs from generation success

[upstream-retry.mjs](../../src/upstream-retry.mjs) defaults to `at-most-once`
**transport replay**. A generation POST may repeat only with positive
`not_sent` evidence and before caller output, within attempt/time limits that
are rechecked after backoff and response cancellation. A connection reset,
headers timeout, or 5xx can follow origin execution. Explicit
`CODEX_ROUTER_NATIVE_RETRY_POLICY=availability` accepts ambiguous delivery;
GET/HEAD/OPTIONS use the safe-method retry allowance.

For routed transport failover, the default policy trusts pre-send evidence only
from the confined local API-forwarder header. Provider headers are stripped;
body markers alone are diagnostic. Availability policy can permit an ambiguous
marked transport failure. See [transport-failure.mjs](../../src/transport-failure.mjs)
and [model-failover.mjs](../../src/model-failover.mjs).

These gates do not imply one generation attempt per user turn. Semantic repairs
(such as an empty completion or context adjustment), quota failover, client
retries, and LiteLLM/provider retry layers retain separate rules. Vision retries
and fallback also stop on ambiguous delivery under the default policy. There
is no end-to-end exactly-once guarantee without origin idempotency.

[response-outcome.mjs](../../src/response-outcome.mjs) records `completed`,
`failed`, `incomplete`, `canceled`, or `indeterminate` separately from HTTP
status. When a protocol observer expects a terminal event, its absence is
indeterminate even after HTTP 200.
The [Control Center presentation](../../apps/control-center/src/generation-outcome.ts)
keeps historical HTTP-only rows distinct from recorded generation outcomes.

## Responses interruption keeps the connection usable

[responses-websocket.mjs](../../src/responses-websocket.mjs) accepts Codex's
`response.interrupt` with `response_id` and `mode: discard_partial_items`.
Control messages bypass the generation queue. Acceptance cancels the local
HTTP request, discards pending items, and finishes with `response.incomplete`
whose reason is `interrupted`. Completed items and observed usage survive;
usage is not invented for an origin that never reported it. A completed origin
JSON response retains its output and usage even while client writes wait.

Completion can win an interruption race; late duplicates do not leave an error
for the next turn. A retained continuation permits the next `response.create`
on the same connection. When its bounded cache cannot hold that context,
`previous_response_not_found` requires the client to resend full context.
The interruption snapshot and pending-item tracker have separate bounds.
Canceling the local transport does not establish that the origin stopped
executing or charging. The [WebSocket tests](../../test/responses-websocket.test.mjs)
exercise live socket reuse, cancellation, completion races, cache overflow,
and deterministic write backpressure.

## One catalog owner, event notifications, daily fallback

Initial readiness and dependency recovery share one serialized finalizer.
Readiness uses each required service's current, individually checked child;
historical child handles are retained only for shutdown ownership. A missing,
dead, or replaced required child cannot be omitted to pass aggregate health.
Pending Antigravity activation retains the captured proof/session generation
and rechecks current children after promotion. An unconfirmed exact rollback
reaches the service owner and stops its children; it is not swallowed as a
dependency restart failure. Degraded startup also retires bootstrap allowances.

The ready supervisor owns the single background catalog watcher; the router
frontend and Control Center do not start competing watchers.
[native-catalog-events.mjs](../../src/native-catalog-events.mjs) watches account
and installed-binary identity changes through parent directories, debounces
events, and keeps identities only in memory. Bearer rotation alone is not an
account change; missing/unreadable identity is not proof of logout.

[native-catalog-drift.mjs](../../src/native-catalog-drift.mjs) serializes refreshes
and retains events received during an active refresh. Boot forces account
revalidation. Account changes do not reuse the previous account's conditional
cache; binary changes trigger a fresh check. Generated model caches/catalogs
and staged selections are not watched, preventing self-triggered publication.
The default fallback is daily because remote entitlement changes need not
produce local events. [native-catalog-settings.mjs](../../src/native-catalog-settings.mjs)
validates interval overrides. Discovery-off suppresses account reads and event
notifications; shutdown closes watchers and timers.

## Private replacement and shutdown ownership

Twenty-four consumer writer implementations use the shared private boundary
in [file-security.mjs](../../src/file-security.mjs). On Windows, same-directory
rename preserves the already hardened temporary file's DACL, removing the
second default ACL-helper launch. This reduces ordinary writes from two launches
to one and caller-key swaps from three to two; backup protection remains.
POSIX chmod behavior, custom temporary/final protection callbacks, Kimi fsync,
exact Buffer bytes, exclusive copying, symlink guards, and rollback generations
remain distinct contracts.

Failed exclusive creation grants no cleanup ownership. Cleanup compares the
created file's identity before unlinking and preserves a substituted object
with `cleanupError: ESTALE`. A displaced owned temporary can remain as recovery
evidence; the helper does not guess another path or claim to solve every
malicious publication race. These guarantees have actual Windows DACL,
collision, fsync/close, rename-failure, and junction/leaf-substitution coverage
in the [private-writer tests](../../test/private-writer-specialized.test.mjs)
and [cleanup ownership tests](../../test/private-writer-cleanup-ownership.test.mjs).

[service-shutdown.mjs](../../src/service-shutdown.mjs) uses only supervisor-owned
child handles. The frontend drains and flushes before downstream hops stop.
Owned Node children receive `model-router:shutdown` through IPC, which invokes
the same bounded handler on Windows, where `kill("SIGTERM")` is abrupt.
[http-utils.mjs](../../src/http-utils.mjs) stops accepting requests, ends remaining
streams with a terminal error, allows a flush interval, and disconnects IPC
before normal exit. Each phase and the absolute force-stop backstop are bounded;
the result reports the shutdown attempt, not proof that every OS process exited.
