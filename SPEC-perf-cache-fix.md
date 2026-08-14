# Spec: fast-path snapshot for `codeburn status --format menubar-json`

## Problem

`PERF-DEFECT-FINDINGS.md` reports `codeburn status` taking 25-90+ seconds per
call, with **no speedup on a repeat call against an unchanged, freshly-warmed
cache** (finding "Test 5"). The findings doc's working hypothesis was a
missing mtime/size gate ahead of per-file content hashing.

Direct re-investigation on the reporter's own machine (live `sample`
profiling of the installed `codeburn status --format menubar-json` binary
against the real ~386MB `session-cache.v7.json`) found:

- The per-source-file change-detection gate the findings doc hypothesized as
  missing **already exists and is correct**: `reconcileFile`/`fingerprintFile`
  in `src/session-cache.ts` compare `dev/ino/mtimeMs/sizeBytes` and skip
  re-reading/re-hashing any unchanged source transcript. There is no
  content-hashing step anywhere in that gate.
- The actual dominant, reproducible cost on a repeat call is **re-parsing the
  entire monolithic on-disk session cache file itself** (`JSON.parse` of the
  ~386MB blob showed as ~20% of sampled CPU time in isolation) plus **re-running
  the full aggregation pipeline** (`buildMenubarPayloadForRange` in
  `src/usage-aggregator.ts`: day-aggregation, optimize scan, PR/branch
  attribution, model efficiency) over the entire requested period on every
  call.
- Every existing in-memory reuse layer (`parser.ts`'s `sessionCache` Map +
  `CACHE_TTL_MS`, `session-cache.ts`'s `cacheMemo`) is process-local. The
  menubar app spawns a **fresh CLI process per poll**, so none of those layers
  ever pay off for this command — each poll starts cold regardless of how
  recently the identical query was answered.

## Fix

Add a small, disk-persisted **status snapshot** keyed by (a) a cheap,
content-free **corpus fingerprint** and (b) a serialization of the resolved
query.

The corpus fingerprint is a stat-only pass (`discoverAllSessions` +
`fingerprintFile` per discovered source — the exact same `dev/ino/mtimeMs/
sizeBytes` signal `reconcileFile` already uses per source transcript) hashed
into one string, with **no** `session-cache.json` read/parse and no
transcript content read. This is deliberately NOT a fingerprint of the
on-disk `session-cache.v*.json` file itself — that file only gets rewritten
*after* a real parse runs, so gating on its own fingerprint would only ever
change in response to a parse the gate is supposed to be allowed to skip,
permanently masking real source-file changes behind a stale snapshot (caught
by a first implementation attempt's own test: appending new session content
between two identical-query calls did not change the result). Fingerprinting
the discoverable sources directly avoids that trap.

`codeburn status --format menubar-json` computes this fingerprint before
doing any parse/aggregation work; on a fingerprint+query match (or a
still-settling match, see Debounce below) it serves the persisted payload
directly (a handful of `stat()` calls, no `JSON.parse` of the corpus, no
aggregation). On any real mismatch (settled new session activity, or a
different query) it falls through to today's full computation and then
persists the new result for the next poll.

One correctness subtlety caught while implementing this: Claude
`SessionSource.path` (from `discoverAllSessions`) is a **project directory**,
not a leaf transcript file — every other provider's `path` IS the leaf
file/DB it parses. A directory's own mtime only moves when an entry is
added/removed, not when an existing file inside it is rewritten in place, so
fingerprinting Claude sources at the directory level would miss real content
changes to files that already existed at discovery time. `computeCorpusFingerprint`
expands each Claude source to its actual `.jsonl` files first (the same
`collectJsonlFiles` walk `scanProjectDirs` already uses) before fingerprinting.

## Debounce design decision

Per operator direction: once a real corpus change is detected, don't
recompute/re-hash immediately — coalesce a rapidly-churning file (a streaming
assistant turn can touch its transcript many times a second) into one
recompute once things go quiet, rather than paying the full parse+aggregation
cost on every single poll of a burst.

**Existing patterns checked first, as directed**, before inventing a new one:
- `parser.ts`'s `PROGRESS_SAVE_THROTTLE_MS` (5s) throttles partial-cache
  saves during a cold hydration — a *throttle* (rate-limit repeated writes),
  not a settle/debounce (wait for quiet before trusting a value). Different
  problem shape.
- `parser.ts`'s `parseBurstWindowMs()` / `CODEBURN_PARSE_BURST_MS` — the
  closest match in spirit and the one this fix's `statusSnapshotSettleMs()`
  mirrors directly: a small, capped, env-overridable numeric knob computed
  fresh from `process.env` on each call.
- `dashboard.tsx` has a UI-input debounce, but it's a `setTimeout`-based
  interaction debounce scoped to one long-lived TUI process. `codeburn
  status` is a fresh, short-lived CLI process per poll (that's the whole
  reason the in-memory caches don't help it) — a `setTimeout` cannot survive
  across separate process invocations, so a wall-clock **age** check (`Date.now()
  - lastTouchedMs < window`) is the only mechanism that composes with a
  stateless CLI. This is also exactly the idiom `cache-refresh-lock.ts`
  already uses for lock staleness (`age = wallNow() - mtimeMs`), so it's a
  mirror of that pattern, not a new one.

**Where it was NOT put:** the first implementation attempt added the settle
check directly inside `reconcileFile` (deferring an 'appended'/'modified'
verdict on a fresh mtime by returning 'unchanged'). That combination has a
correctness bug: once the outer status-snapshot layer sees a real corpus
fingerprint change, it recomputes via the full pipeline — but if
`reconcileFile` itself defers and reports 'unchanged' for the still-fresh
file, the recompute produces the SAME (stale) result, which then gets
persisted under the NEW corpus fingerprint. Because the outer snapshot only
ever compares fingerprints (not wall-clock time), that stale result would
then be served **forever** for that fingerprint — the settle window would
never get a chance to expire and trigger a real re-read, since nothing
would make the fingerprint change again without a further write. Caught by
this fix's own test before landing. `reconcileFile` was reverted to its
original, unmodified form.

**Where it actually lives:** entirely inside the status-snapshot layer this
fix already introduces, which is the one place with the wall-clock context
needed to expire correctly:
- `computeCorpusFingerprint` now also returns `newestMtimeMs` — the newest
  mtime observed across every discovered source in that pass (0 when there
  are none).
- `session-cache.ts`'s `loadStatusSnapshot(corpusFingerprint, newestMtimeMs,
  queryKey)`: on a fingerprint mismatch (real change detected), if
  `Date.now() - newestMtimeMs < statusSnapshotSettleMs()` it still returns
  the stored (pre-change) payload — deferred, not stale-forever, because the
  caller is told NOT to persist a new snapshot in that case (the old
  baseline survives on disk). The very next poll after writes actually
  stop — once the freshest file's mtime ages past the window — sees the
  same fingerprint mismatch with no grace period left, recomputes for real,
  and persists the settled result. No update is ever masked permanently, it
  is only ever delayed by at most the window.
- **Interval chosen: 2000ms**, env-overridable via
  `CODEBURN_STATUS_SNAPSHOT_SETTLE_MS` (capped at 60_000ms, mirroring
  `CODEBURN_PARSE_BURST_MS`'s cap). Rationale: long enough to coalesce a
  streaming turn's rapid successive appends into one recompute; short enough
  that the menubar's displayed numbers don't visibly lag a user's real
  activity by more than ~2s. This is a tunable UX judgment call, not hard
  science — flagged explicitly for review.

## Scope

- `src/parser.ts`: add `computeCorpusFingerprint(providerFilter?)` — reuses
  the already-imported `discoverAllSessions` and `fingerprintFile`, plus the
  already-defined `collectJsonlFiles` for the Claude directory-expansion
  case above. Returns `{ hash, newestMtimeMs }`.
- `src/session-cache.ts`: add `loadStatusSnapshot(corpusFingerprint,
  newestMtimeMs, queryKey)` / `saveStatusSnapshot(corpusFingerprint,
  newestMtimeMs, queryKey, payload)` and the `statusSnapshotSettleMs()` knob
  (new `status-snapshot.json` file in the cache dir, atomic temp+rename
  write, best-effort — a failed read/write just falls back to a full
  recompute). `reconcileFile` is unchanged.
- `src/main.ts`: in the `status` command's `--format menubar-json` branch,
  build a query key from the resolved period/day/days range, provider,
  project/exclude filters, optimize/timeline flags, and Claude config source;
  check the snapshot before calling `buildMenubarPayloadForRange`, and save
  after a real (non-deferred) compute. The `--scope combined` device-pull
  enrichment stays live (uncached) on every call — it is not the reported
  bottleneck and already has its own best-effort fallback.
- Not touched: `buildMenubarPayloadForRange` internals, `reconcileFile`, the
  `devices` command (different call site, not the reported symptom),
  `--format json`/`terminal` status output (not the menubar's polled path).

## Acceptance

- Given an unchanged on-disk session corpus and an identical query, a second
  `codeburn status --format menubar-json` call returns byte-identical output
  to the first, sourced from the snapshot (no corpus re-parse).
- Given new session activity between two calls, a call made while the change
  is still within the settle window is deferred (serves the last settled
  snapshot); a call made once the change has aged past the window reflects
  the new data. The snapshot never serves stale results indefinitely.
- `--scope combined` vs `--scope local` from the same underlying query still
  differ only in the `combined` field; `local` never gains a stray `combined`
  key from a prior `combined` call's snapshot (the snapshot never stores the
  live device-enrichment result).

## Secondary finding: dual kqueue watches on `/`

Scoping call: **out of scope for this fix, filed as a separate follow-up.**
The findings doc could not confirm this as a cause of the latency (flat FD
count over an 8s observation window) and it is orthogonal to the cache
read/write path this fix touches — it would live in whichever file-watch
setup code owns the fs-watcher init (not `session-cache.ts`), and needs its
own `fs_usage`/`dtrace` reproduction under `sudo`, which wasn't available in
this session either. No code change made for it here.
