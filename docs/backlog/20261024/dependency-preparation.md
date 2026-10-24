# Prepare only selected runtime dependencies

Archival draft only. Do not merge this archive into personal or main.

- Source commit: `4c3097d08c2a863771a5d13e5119ca280162b0e8`
- Patch comparison base: `9945d74354ab07942f171be329cf81c9478fc5e2`
- SHA-256: `9bdee90f843bc53cea35394db5145e46ce8333d93fcc8428e69bbc13092ed696`
- Intended behavior: Prepare dependencies before adoption; preserve repair and installer behavior on every platform.
- Candidate dependencies: selected-services
- Upstream prerequisites: #1015, #1054

The patch stores exact source fragments, not a ready-to-merge implementation.
Imports, combined adjacent hunks and shared test changes may require other
archive items. Hunk ownership is for preservation, not proof of independence.
The original 18-item history is recorded in the inventory.

All integrated fragments together were reconstructed in an isolated Git index
and matched the exact source tree. That integrity check does not prove any
one extracted feature works. Existing integrated CI must not be attributed to
this individual archive. No production files or services were changed.

Before proposing upstream: inspect current main, remove already-merged code
and historical experiments, extract the smallest coherent implementation,
review all hunks, run meaningful failure controls and appropriate platform CI.
Close this backup PR only after its upstream replacement is recorded and its
published head verified; keep the branch and links for traceability.
