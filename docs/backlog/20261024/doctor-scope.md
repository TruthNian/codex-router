# Scope doctor to selected provider readiness

Archival draft only. Do not merge this archive into personal or main.

- Source commit: `4c3097d08c2a863771a5d13e5119ca280162b0e8`
- Patch comparison base: `9945d74354ab07942f171be329cf81c9478fc5e2`
- SHA-256: `d6e7442216c95be36481c54faa43b00e3b74c6f4ee0b414fef3b4d3d7fc3b7a9`
- Intended behavior: Avoid inspecting unused credentials by default; retain --all, generic providers, protocol variants and authoritative key-pool checks.
- Candidate dependencies: selected-services
- Upstream prerequisites: #1015

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
