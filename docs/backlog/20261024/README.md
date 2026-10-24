# Preserved Codex Router backlog — 2026-10-24

This inventory reconciles the original 18-feature history, later fixes, existing
fork PRs and actual latest-main differences. All new PRs in this series are
fork-only archival drafts. They do not change executable source and must not
be merged into personal/main. An archival patch is not proof of correctness or
independent applicability. Follow dependencies, re-extract, review and test
before any upstream proposal.

The original 18-item turn: `01a128f1-1de8-7780-af15-7ba609758e20`.
Implemented snapshot: `4c3097d08c2a863771a5d13e5119ca280162b0e8`.
Comparison main: `9945d74354ab07942f171be329cf81c9478fc5e2`.

All 200 differing files and 1110 hunks are accounted for exactly once in the
integrated reconstruction. Combining the preserved fragments in original
file/hunk order reproduces the exact original tree. The three small focused
extractions are additional snapshots and may overlap the integrated fragments.

See inventory.json for every hunk, dependency, hash and PR link.

| Topic | Archive / existing PR |
|---|---|
| Routed failover delivery evidence | `archive/20261024/routed-delivery` |
| Reject API and vision generation redirects | `archive/20261024/generation-redirect` |
| Vision retry delivery and completion semantics | `archive/20261024/vision-delivery` |
| Use direct Responses routes while retaining compatibility | `archive/20261024/direct-responses` |
| Start services from the selected execution plan | `archive/20261024/selected-services` |
| Prepare only selected runtime dependencies | `archive/20261024/dependency-preparation` |
| Scope doctor to selected provider readiness | `archive/20261024/doctor-scope` |
| Adopt configuration before publishing client models | `archive/20261024/overlay-adoption` |
| Reserve a separate configuration rollback budget | `archive/20261024/rollback-budget` |
| Publish installed clients after service readiness | `archive/20261024/installer-publication` |
| Apply credential mutations through adoption transactions | `archive/20261024/credential-transactions` |
| Verify offline native profile catalog adoption | `archive/20261024/profile-offline` |
| Validate adopted routes before catalog-only refresh | `archive/20261024/adopted-catalog` |
| Refresh native models from identity events with daily fallback | `archive/20261024/catalog-events` |
| Finalize readiness from current owned children | `archive/20261024/recovery-readiness` |
| Drain frontend before stopping owned dependencies | `archive/20261024/service-shutdown` |
| Consolidate callers on the private file boundary | `archive/20261024/private-writers` |
| Record ingress preparation and upstream-header timing | `archive/20261024/request-timing` |
| Preserve bounded native macOS launch diagnostics | `archive/20261024/macos-diagnostics` |
| Select manual runtime CI without reducing automatic coverage | `archive/20261024/manual-ci-scope` |
| Isolate runtime and provider test fixtures | `archive/20261024/runtime-fixtures` |
| Isolate catalog tests from operator compatibility policy | `archive/20261024/catalog-fixture-isolation` |
| Keep the retention contention test clock deterministic | `archive/20261024/retention-clock` |
| Persist native catalog client version metadata | `archive/20261024/cache-version-metadata` |

Existing tool-history PRs: [#4](https://github.com/TruthNian/codex-router/pull/4),
[#5](https://github.com/TruthNian/codex-router/pull/5),
[#6](https://github.com/TruthNian/codex-router/pull/6). Do not duplicate them.
The adapted Desktop fix is upstream #1062; cache-version metadata is #1063.
AppData is tracked by upstream #1058. Closed status alone never establishes
that code landed.

Already-merged foundations (including #1015 compiler, #1009 ownership and
#1013 native replay) do not imply every consumer optimization was merged.
No duplicate runtime PR is opened for the already-merged foundation itself.

Historical context fragments preserve residual documentation/comments and
already-covered test differences. They are provenance, not a new feature PR.
Old corrupted-history stripping stays deferred because it can remove valid
context. GLM task orchestration suggestions without implemented Router code
are not invented as completed features.
