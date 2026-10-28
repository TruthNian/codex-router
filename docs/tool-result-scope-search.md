# Exact lookup without guessing archive handles

English · [简体中文](zh-CN/tool-result-scope-search.md) · [日本語](ja/tool-result-scope-search.md)

The existing reader accepts `--scope-search --find 'literal identifier'` with
any valid reference handle. It returns exact excerpts only from archives with
the same signed conversation/permission scope. It reuses the original reader's
integrity, signature, expiry, regular-file and directory checks. It does not
execute source commands or summarize the evidence.

Output is bounded (a configurable excerpt limit of 1–16,000 UTF-16 code units,
32 matching archives, and a 16MiB/one-second scan budget checked between files).
As with the single-archive reader, preserving a surrogate pair may add one code
unit to the excerpt limit. This is a local CLI operation, not an HTTP endpoint.
`complete: false`
must never be treated as absence. Continue with `--cursor N --index HASH` when
`nextCursor` is present; a changed directory index requires restarting the
search. Corrupt or expired entries report an incomplete search without exposing
unknown-scope handles. Each matching archive supplies its first occurrence;
use the ordinary reader's `--offset` for further occurrences or context.

The index covers sorted immutable archive names. A page's `searched` and
`unavailable` counts describe that page only; callers must retain earlier
matches and incomplete-evidence reports while following `nextCursor`. Reaching
the last page does not erase an unavailable entry reported on an earlier page.
