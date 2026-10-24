# Recovered Codex Router backlog — 2026-10-24

All entries below are saved in **TruthNian/codex-router**, as archival drafts.
Do not merge them into personal/main. Each stores exact source patch bytes,
comparison commits, hashes, intent and provisional dependency boundaries.
They preserve code; they do not certify independent applicability or readiness.

The complete current conversation (72 turns across 8 pages) was read, including
the original **18-item** list in turn `01a128f1-1de8-7780-af15-7ba609758e20`.
The GLM consumption conversation was cross-checked for its implemented Router
changes and unimplemented proposals. There are **24 new topic drafts** and
this inventory, in addition to the existing tool-history PRs #4–#6.

| Topic | Backup PR | Dependencies to recheck |
|---|---|---|
| Routed failover delivery evidence | [#8](https://github.com/TruthNian/codex-router/pull/8) | none recorded |
| Reject API and vision generation redirects | [#9](https://github.com/TruthNian/codex-router/pull/9) | none recorded |
| Vision retry delivery and completion semantics | [#10](https://github.com/TruthNian/codex-router/pull/10) | routed-delivery, generation-redirect |
| Use direct Responses routes while retaining compatibility | [#11](https://github.com/TruthNian/codex-router/pull/11) | none recorded |
| Start services from the selected execution plan | [#12](https://github.com/TruthNian/codex-router/pull/12) | direct-responses |
| Prepare only selected runtime dependencies | [#13](https://github.com/TruthNian/codex-router/pull/13) | selected-services |
| Scope doctor to selected provider readiness | [#14](https://github.com/TruthNian/codex-router/pull/14) | selected-services |
| Adopt configuration before publishing client models | [#15](https://github.com/TruthNian/codex-router/pull/15) | dependency-preparation, selected-services |
| Reserve a separate configuration rollback budget | [#16](https://github.com/TruthNian/codex-router/pull/16) | overlay-adoption |
| Publish installed clients after service readiness | [#17](https://github.com/TruthNian/codex-router/pull/17) | overlay-adoption |
| Apply credential mutations through adoption transactions | [#18](https://github.com/TruthNian/codex-router/pull/18) | overlay-adoption, rollback-budget |
| Verify offline native profile catalog adoption | [#19](https://github.com/TruthNian/codex-router/pull/19) | overlay-adoption |
| Validate adopted routes before catalog-only refresh | [#20](https://github.com/TruthNian/codex-router/pull/20) | overlay-adoption |
| Refresh native models from identity events with daily fallback | [#21](https://github.com/TruthNian/codex-router/pull/21) | adopted-catalog |
| Finalize readiness from current owned children | [#22](https://github.com/TruthNian/codex-router/pull/22) | selected-services |
| Drain frontend before stopping owned dependencies | [#23](https://github.com/TruthNian/codex-router/pull/23) | selected-services |
| Consolidate callers on the private file boundary | [#24](https://github.com/TruthNian/codex-router/pull/24) | none recorded |
| Record ingress preparation and upstream-header timing | [#25](https://github.com/TruthNian/codex-router/pull/25) | none recorded |
| Preserve bounded native macOS launch diagnostics | [#26](https://github.com/TruthNian/codex-router/pull/26) | none recorded |
| Select manual runtime CI without reducing automatic coverage | [#27](https://github.com/TruthNian/codex-router/pull/27) | none recorded |
| Isolate runtime and provider test fixtures | [#28](https://github.com/TruthNian/codex-router/pull/28) | selected-services |
| Isolate catalog tests from operator compatibility policy | [#29](https://github.com/TruthNian/codex-router/pull/29) | none recorded |
| Keep the retention contention test clock deterministic | [#30](https://github.com/TruthNian/codex-router/pull/30) | none recorded |
| Persist native catalog client version metadata | [#31](https://github.com/TruthNian/codex-router/pull/31) | none recorded |

The first 18 rows are the historical optimization families. Remaining rows
preserve macOS diagnostics, manual CI scope, runtime fixture isolation, and
three later small extractions. Shared adjacent hunks are retained without
claiming they are independent functional patches; any upstream extraction
must reconcile shared imports, tests and already-merged changes first.

Already tracked: [#4 Desktop proof recognition](https://github.com/TruthNian/codex-router/pull/4)
(adapted upstream as #1062), [#5 scope search](https://github.com/TruthNian/codex-router/pull/5),
[#6 per-model policy](https://github.com/TruthNian/codex-router/pull/6).
The cache metadata extraction is upstream #1063; AppData is tracked by #1058.
No duplicate upstream PR was created in this archival task.

Already-merged foundations such as #1015's compiler, #1009's ownership helper
and #1013's native retry boundary do not imply all consumers landed. The JSON
inventory distinguishes them from remaining behavior and historical context.
Closed status alone is not proof of merge. Residual historical context is kept
for reconstruction and must not be proposed as a new functionality.

Corrupted-history stripping stays deferred because it can lose valid context.
Batch execution, stage memory and lazy tool loading proposed in the GLM task
are not invented as completed Router implementations.

## Preservation verification

Base: `9945d74354ab07942f171be329cf81c9478fc5e2`.
Source: `4c3097d08c2a863771a5d13e5119ca280162b0e8`.
200 changed files, 1110 integrated hunks, no missing or duplicate assignments.
Combining every preserved integrated fragment in original file/hunk order
reconstructs Git tree `99b3c2600cd99fd96c92de70903e3155debae86f` exactly.
The three additional focused extractions may overlap those fragments.

Clone/fetch the fork's archive branches, check out this inventory branch, then:

```text
python docs/backlog/20261024/verify-preservation.py
```

Verification reads the archived Git blobs and uses an isolated temporary index;
it does not alter executable files, the working index, service or credentials.
Archive commits skip CI deliberately. Historical integrated CI does not stand
in for fresh per-feature runtime and cross-platform verification.

## Promotion and closure

First re-extract one coherent feature against current upstream main. Remove
already-landed code and obsolete diagnostics, identify real prerequisites,
review all changes and run meaningful negative controls and relevant CI.
Submit upstream sequentially after the previous applicable CI is stable;
wait for a prerequisite to be MERGED and present in main before dependents.
After a replacement upstream PR and its published head are verified, link it
and close the corresponding backup PR when appropriate. Keep its branch.
Keep this inventory available until every item has an explicit disposition.

## Upstream promotions

| Topic | Upstream PR | Exact published head | Status |
|---|---|---|---|
| catalog-fixture-isolation | [#1064](https://github.com/duolahypercho/codex-router/pull/1064) | `b9e54fc6b201e68ab5212b279162434561dc8ee7` | ci_running |
