# GLM cost optimization backlog — deferred pending validation

Recorded 2026-10-27 at the owner's request. These are discussion items, not approved implementations or proven savings. Finish validation of existing AGENTS.md Tool efficiency guidance and windows-literal-payloads first. Do not change Router behavior as part of that validation.

## Deferred candidates

1. **Old tool-call arguments and patch bodies.** Measure repeated argument tokens (especially apply_patch); consider reversible archival or compact references only after preserving call/result pairing, source provenance and recovery. Current output archival does not solve this.
2. **Completed-stage checkpoints.** Reduce repeated completed-stage history while retaining decisions, constraints, evidence pointers and unresolved work. Requires supported client/orchestration integration; do not assume Router alone can safely trigger this.
3. **On-demand tool definitions and skill metadata.** Verify actual eagerly transmitted metadata first; native tool search already exists. Preserve discoverability, names, schemas and complete instruction access.
4. **Cache effectiveness and stable request prefixes.** Reconcile provider cache tokens and charges against real request changes before changing request assembly. Never reorder instruction authority or conversation chronology solely for caching.
5. **Failure/retry overhead.** Attribute avoidable tool errors, provider retries and recovery calls after the instruction-retention fix. Fix demonstrated causes; do not remove recovery paths merely to reduce call counts.
6. **Local batch/workflow helpers.** Consider only where they preserve model-guided decisions, intermediate failure handling and task quality. Replacing adaptive work with a fixed script has no established quality guarantee.
7. **Further wait-policy changes.** No evidence yet supports waiting longer than the existing bounded 30/45/60-second policy. Revisit only with real empty-poll and response-latency evidence.

## Closed or parked investigations

- **Duplicate skill catalogs:** investigation stopped at the owner's request. Duplication was demonstrated in restored benchmark history, not established as a general production problem. Flattened copied skill folders also broke relative dependencies; do not merge by short name or delete old catalogs indiscriminately.
- **Stronger precision-read prompting:** three additional JSON/CSV/source-read rules were removed after five-round model-dependent results. GLM mean input increased about 1.6%, GPT-6.1 increased about 15.4%, GPT-5.6 decreased about 69.9%. Do not reinstate globally on intuition.
- **Further skill-budget reduction:** 10000→8000 did not shorten the observed catalog. No measured benefit supports further reduction.
- **Server-side search observability:** provider internals are unavailable; do not infer unobserved server-side token work as proven waste or promise a fix without telemetry.

## Evidence standard for reopening

Separate functional correctness from task-level savings. Freeze model, task, quality checks and Router version; compare actual provider debits, requests, cached/uncached input, output, failures and quality. Retain unfavorable runs. A smaller prompt or one cheaper task is not proof of stable end-to-end improvement.
