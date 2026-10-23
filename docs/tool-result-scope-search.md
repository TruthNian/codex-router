# Exact lookup without guessing archive handles

The existing reader accepts `--scope-search --find 'literal identifier'` with
any valid reference handle. It returns exact excerpts only from archives with
the same signed conversation/permission scope. It reuses the original reader's
integrity, signature, expiry, regular-file and directory checks. It does not
execute source commands or summarize the evidence.

Output is bounded (at most 16,000 UTF-16 characters of excerpts, 32 matching
archives, and a 16MiB/one-second scan budget between files). `complete: false`
must never be treated as absence. Continue with `--cursor N --index HASH` when
`nextCursor` is present; a changed directory index requires restarting the
search. Corrupt or expired entries report an incomplete search without exposing
unknown-scope handles. Each matching archive supplies its first occurrence;
use the ordinary reader's `--offset` for further occurrences or context.
