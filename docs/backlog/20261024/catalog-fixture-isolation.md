# Isolate catalog tests from operator compatibility policy

Archival draft only. Do not merge this archive into personal or main.

- Source commit: `b9e54fc6b201e68ab5212b279162434561dc8ee7`
- Patch comparison base: `9945d74354ab07942f171be329cf81c9478fc5e2`
- SHA-256: `5cc0f08319ee92fa88bd3769fb44b2cb7aadde2db09abf9d295bc74f5f60676c`
- Intended behavior: Preserve this exact small extraction and its existing local evidence. CI on other snapshots is not this patch CI.
- Candidate dependencies: none recorded; recheck on extraction
- Upstream prerequisites: none recorded; recheck on extraction

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
