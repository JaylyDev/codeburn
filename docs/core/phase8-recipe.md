# Phase 8 fan-out recipe: bridge a provider's pure decode into `@codeburn/core`

Phase 8 of the `@codeburn/core` extraction (issue #809) moves each provider's
**pure record decode** into `packages/core/src/providers/<name>/` while the CLI
keeps discovery, file/DB I/O, caching, and pricing. A thin **bridge** wraps the
core decoder so every existing consumer — the `parser.ts` scan loop, `doctor`
probeRoots, `--provider` filters, tool/model display names — sees the exact same
`Provider` interface as before.

The seam and one exemplar (`qwen`) shipped in **phase 8.1**. This document is the
mechanical recipe for the remaining providers. **Follow it per-provider; each
provider is one small PR.** It mirrors the structure of
[`phase0-recipe.md`](./phase0-recipe.md); read that first if you have not.

> **Prerequisite:** every provider you bridge here must already be **Phase 0**
> converted (emits `costBasis` instead of calling `calculateCost`). If it still
> prices itself, do the Phase 0 conversion first — the bridge assumes cost has
> already left the decoder.

---

## The seam (already in place — do not re-add)

`packages/cli/src/providers/bridge.ts` exposes two things:

- **`BridgedProviderSpec<TRich>`** — how you express a core-migrated provider:
  `{ name, displayName, modelDisplayName, toolDisplayName, discoverSessions,
  probeRoots?, readRecords, decode, toProviderCall }`.
- **`createBridgedProvider(spec)`** — wraps that spec into the `Provider`
  interface. The generated `createSessionParser` calls `readRecords` (CLI I/O),
  runs `decode` (core, threading the shared `seenKeys` dedup set), and yields
  each `toProviderCall(rich)`.

**You never edit `bridge.ts`, `parser.ts`, `pricing-pass.ts`, or
`session-cache.ts`.** The registry (`providers/index.ts`) already resolves
bridged and legacy providers uniformly — a bridged provider is registered exactly
like any other (`import { foo } from './foo.js'`, add to `coreProviders`), because
`createBridgedProvider` returns a plain `Provider`.

This **generalizes** the bespoke adapters claude/codex wrote in phases 3/4 (each
reads its file, calls its core decoder, and maps the rich result) for the
**simple** case: one whole-file pass, a live cross-file dedup set, **no
incremental cache and therefore no serializable resume state**. Providers that
cache/resume (codex) or hold a stateful multi-store cache (antigravity/kiro) keep
their bespoke adapters — the bridge is deliberately not built to cover them (see
DO-NOT list).

### What the two layers look like in core (the qwen shape)

`packages/core/src/providers/<name>/`:

- **`types.ts`** — raw record types (moved verbatim from the CLI) + the rich
  `…DecodedCall` (mirrors `ParsedProviderCall` **minus** cost fields) + any
  `…ToolCall` used for `toolSequence`.
- **`decode.ts`** — `decode<Name>({ records, context, seenKeys? })` returning
  `{ calls, diagnostics }`. **Pure**: no `fs`/env/clock, no pricing, no
  `strip-ansi`/bash base-name extraction (that stays CLI-side). Dedup threads the
  live `seenKeys` set. The tool-name map moves here too.
- **`observations.ts`** — `toObservations(decode, ctx)` mapping the rich decode
  into the strict `SessionObservation[]`. This is where the content-smuggling
  guarantees bind: only fingerprints, enums, numbers, timestamps, dedup keys, and
  canonical tool names cross the boundary. Fingerprint file paths through
  `extractResourceRefs` from `../resource-refs.js`.
- **`index.ts`** — barrel re-exporting decode + observations + types.

Then wire the build/exports (three edits, all add-only):

1. `packages/core/tsup.config.ts` — add `'src/providers/<name>/index.ts'` to `entry`.
2. `packages/core/package.json` — add the `"./providers/<name>"` exports entry
   (`types` + `import` pointing at `dist/providers/<name>/index.*`). The
   import-smoke guardrail auto-discovers this subpath from `package.json`.
3. `packages/core/tests/architecture-gate.test.ts` — if the rich decode carries
   `userMessage`, add `src/providers/<name>/decode.ts` and `…/types.ts` to
   `USER_MESSAGE_ALLOWLIST` (they are legitimate host-side carriers, exactly like
   claude/codex/qwen).

---

## Before you start — classify the provider

Each provider falls into exactly one bucket. **Only Category A is the cheap
tail.** The full classification of the current tail is the table at the end.

| Bucket | Signal | This recipe? |
|--------|--------|--------------|
| **A. Simple file-based (JSONL/JSON)** | `readSessionFile`/`readFile`, one file (or a few) per session, no sqlite, no cache resume | **Yes — the cheap tail.** |
| **B. sqlite-rowed** | imports `better-sqlite3`/`node:sqlite` or `sqlite-session-parser` | Yes, but the **sqlite driver + query stay CLI-side**; only the row→observation decode moves. Bigger PR — see "sqlite variant". |
| **C. shared-module consumers** | imports `vscode-cline-parser` / `opencode-file-parser` / `session-message` / `sqlite-session-parser` | Migrate the **shared decode module once** into core, then wire every consumer to it. One PR for the module, then trivial per-consumer. |
| **D. stateful multi-store** | a session cache with `byteOffset`/resume, or several on-disk stores stitched with in-memory `Map`s | **No — judgment-tier (Opus).** Do not force it into the simple bridge. |

Run this to place a provider yourself:

```
grep -n "better-sqlite3\|node:sqlite\|sqlite-session-parser" packages/cli/src/providers/<name>.ts   # B
grep -n "byteOffset\|-cache.js\|CacheEntry\|new Map(" packages/cli/src/providers/<name>.ts           # D signals
grep -n "vscode-cline-parser\|opencode-file-parser\|session-message" packages/cli/src/providers/<name>.ts # C
```

---

## Category A — the move checklist (simple file-based)

1. **Create the core module** (`types.ts`, `decode.ts`, `observations.ts`,
   `index.ts`) as above. Move the raw record types, the tool-name map, the
   line-parse, and the per-record decode **verbatim**. Strip anything host-side:
   pricing (already gone post-Phase 0), and bash base-name extraction — the
   decoder emits **raw** command strings (`rawBashCommands`), the CLI reduces them.
2. **Wire build/exports** (tsup entry, package.json exports, arch-gate allowlist).
3. **Rebuild core** so the CLI resolves the new dist: `npm run build -w @codeburn/core`.
4. **Convert the CLI provider** to `createBridgedProvider`:
   - Keep `discoverSessions` / `probeRoots` unchanged (discovery stays CLI-side).
   - Add `readRecords(source)` — the file read + line split that used to live
     inside `createSessionParser`.
   - `decode: decode<Name>` (the core ref).
   - `toProviderCall(rich)` — map the rich call to `ParsedProviderCall`, add
     `costBasis: 'estimated'` (or `'measured'` per Phase 0 Pattern B), and run any
     CLI-only reduction (`extractBashCommands`).
5. **Add tests** (below).
6. **Verify parity**, then revert `src/data`.

### Parity is the gate

- **Fixture golden (always).** Capture the pre-migration `parse()` output for a
  representative fixture **before** you touch the provider, commit it as the
  expected array, and assert the bridged provider reproduces it **byte-for-byte**
  (`toEqual`). This is exactly what `packages/cli/tests/providers/qwen-bridge.test.ts`
  does. Because `priceProviderCall` is deterministic, byte-identical raw output
  guarantees byte-identical priced output.
- **Frozen-corpus compare (conditional — DO NOT SKIP when it applies).** qwen has
  **no** data in the frozen corpus, so a fixture golden was sufficient. **Any
  provider that IS present in the frozen corpus (e.g. `cursor`, `gemini`, and the
  others listed in the corpus manifest) MUST run the frozen-corpus compare** as
  part of its migration PR — the corpus is the byte-level parity oracle for real
  data and a fixture cannot substitute for it. Check membership first:

  ```
  grep -rl "<name>" packages/cli/tests/fixtures/**/frozen* 2>/dev/null   # adjust to the corpus path
  ```

  If the provider appears, the frozen-corpus test is a required, non-negotiable
  gate alongside the fixture golden.

### Test wiring (Category A)

Add two test files:

- `packages/core/tests/providers/<name>-decode.test.ts` — unit-tests the rich
  decode (dedup, skips, token buckets, tool mapping, model fallback) **and** that
  `toObservations` produces a schema-valid, secret-free envelope.
- extend `packages/core/tests/content-smuggling.test.ts` — one hostile-transcript
  block planting every `SECRETS.*` value in the free-text fields the decode
  captures (user prompt, command, file path, a tool NAME carrying a command line)
  and asserting the minimized envelope surfaces none of them. Copy the qwen block.
- `packages/cli/tests/providers/<name>-bridge.test.ts` — the fixture-golden parity
  test above.

Import-smoke needs **no** manual edit — it enumerates `package.json` exports, so
the new subpath is covered the moment you add it there.

---

## The sqlite variant (Category B)

Same shape, one rule: **the sqlite driver and the SQL query never leave the CLI.**
`readRecords` runs the query host-side and returns the **rows** (plain objects);
`decode<Name>` is pure over those rows. Do not move `better-sqlite3` into core
(it would break the import-smoke I/O guardrail instantly). Everything else —
types, row→call decode, tool map, `toObservations` — moves exactly as Category A.

`readRecords` returns `Row[]`; the core decoder's `records: unknown[]` are those
rows. That is the only difference from the JSONL case.

---

## The shared-module variant (Category C)

`vscode-cline-parser`, `opencode-file-parser`, `sqlite-session-parser`, and
`session-message` are decode logic shared by several providers. **Migrate the
shared module into core once** (as its own `core/src/providers/<shared>/` or a
shared decode under the consuming provider), then point each consumer's `decode`
at it. Do the module PR first; the per-consumer PRs after are trivial rewires.
Keep the sqlite driver (for `sqlite-session-parser`) CLI-side per Category B.

---

## Per-provider acceptance checklist

1. `grep -n "decode logic markers" packages/cli/src/providers/<name>.ts` → the CLI
   file has **no** record parsing / token extraction / tool-map left (discovery +
   I/O + `toProviderCall` only). The decode logic exists in **exactly one**
   package (core).
2. Core: `npm run -w @codeburn/core typecheck` clean; `npm test -w @codeburn/core`
   green (new `<name>-decode` + smuggling tests pass; import-smoke covers the new
   subpath).
3. Rebuild core dist, then root `npm test` green — count unchanged except the new
   bridge test(s). The provider's own CLI tests pass **unchanged**.
4. `npx tsc --noEmit` clean in both packages; `npm run build` ok.
5. **Fixture golden byte-identical.** If the provider is in the frozen corpus,
   **frozen-corpus compare green too.**
6. No `PROVIDER_PARSE_VERSIONS` / `parse-versions` change (grep the diff).
7. `git checkout -- packages/cli/src/data` before committing (the build refreshes
   the litellm/pricing snapshots).

---

## The DO-NOT list

- **Never touch `claude`, `codex`, `session-cache`, or `parse-versions`.** claude
  and codex already have bespoke adapters (phases 3/4); the bridge generalizes
  their shape for simple providers, it does **not** rework them. `session-cache.ts`
  and `parse-versions` are host infrastructure — off limits.
- **sqlite driver + DB reads stay CLI-side.** Only the row→observation decode
  moves. Moving `better-sqlite3`/`node:sqlite` into core breaks the import-smoke
  I/O guardrail.
- **Stateful providers (antigravity/kiro-style caches) are judgment-tier, not the
  cheap tail.** They stitch multiple stores with resume offsets / in-memory maps;
  hand them to Opus, do not force them through `createBridgedProvider`.
- **No pricing in core.** The decoder emits token buckets + (host-side)
  `costBasis`; `priceProviderCall` fills `costUSD`. No `calculateCost` in core.
- **No free text in the envelope.** `toObservations` emits only fingerprints,
  enums, numbers, timestamps, dedup keys, and canonical tool names. The
  architecture gate + content-smuggling tests enforce this.

---

## Worked diff — the `qwen` exemplar (phase 8.1)

**Core, new file `packages/core/src/providers/qwen/decode.ts`** (the moved decode,
pure; tool map + line parse + per-record decode; raw commands, no base-name
extraction):

```ts
export const qwenToolNameMap: Record<string, string> = { read_file: 'Read', execute_command: 'Bash', /* … */ }

export function decodeQwen({ records, seenKeys: liveSeen }: QwenDecodeInput): QwenDecodeResult {
  const seen = liveSeen ?? new Set<string>()
  const calls: QwenDecodedCall[] = []
  let pendingUserMessage = ''
  for (const rawLine of records) {
    const entry = typeof rawLine === 'string' ? parseQwenLine(rawLine) : (rawLine as QwenEntry | null)
    if (!entry) continue
    if (entry.type === 'user' && entry.message) { /* set pendingUserMessage (thought parts filtered) */; continue }
    if (entry.type !== 'assistant' || !entry.usageMetadata) continue
    // …zero-token skip, `qwen:<sessionId>:<uuid>` dedup against `seen`…
    calls.push({ provider: 'qwen', model, inputTokens, /* buckets */, tools: [...new Set(tools)],
      rawBashCommands, timestamp, speed: 'standard', deduplicationKey, userMessage: pendingUserMessage, sessionId, ...(toolSequence.length ? { toolSequence } : {}) })
    pendingUserMessage = ''
  }
  return { calls, diagnostics: [] }
}
```

**CLI, `packages/cli/src/providers/qwen.ts`** — the whole file becomes discovery +
I/O + map, wrapped by the bridge:

```diff
-import { readSessionFile } from '../fs-utils.js'
-import { extractBashCommands } from '../bash-utils.js'
-import type { Provider, SessionSource, SessionParser, ParsedProviderCall } from './types.js'
-
-const toolNameMap: Record<string, string> = { read_file: 'Read', /* … */ }
-type QwenPart = { /* … */ }
-type QwenEntry = { /* … */ }
-function extractTools(parts) { /* … */ }
-function createParser(source, seenKeys): SessionParser { /* JSON.parse loop, token extraction, yield */ }
+import { decodeQwen, qwenToolNameMap } from '@codeburn/core/providers/qwen'
+import type { QwenDecodedCall } from '@codeburn/core/providers/qwen'
+import { readSessionFile } from '../fs-utils.js'
+import { extractBashCommands } from '../bash-utils.js'
+import { createBridgedProvider } from './bridge.js'
+import type { Provider, SessionSource, ParsedProviderCall } from './types.js'
+
+function toProviderCall(rich: QwenDecodedCall): ParsedProviderCall {
+  return { provider: 'qwen', model: rich.model, /* buckets */,
+    costBasis: 'estimated',
+    tools: rich.tools,
+    bashCommands: [...new Set(rich.rawBashCommands.flatMap(c => extractBashCommands(c)))],
+    /* timestamp, speed, deduplicationKey, userMessage, sessionId */ }
+}

 export function createQwenProvider(overrideDir?: string): Provider {
   const projectsDir = overrideDir ?? getQwenProjectsDir()
-  return { name: 'qwen', displayName: 'Qwen',
-    modelDisplayName(m) { return m },
-    toolDisplayName(t) { return toolNameMap[t] ?? t },
-    async discoverSessions() { /* … unchanged … */ },
-    createSessionParser(source, seenKeys) { return createParser(source, seenKeys) },
-  }
+  return createBridgedProvider<QwenDecodedCall>({
+    name: 'qwen', displayName: 'Qwen',
+    modelDisplayName(m) { return m },
+    toolDisplayName(t) { return qwenToolNameMap[t] ?? t },
+    async discoverSessions() { /* … unchanged … */ },
+    async readRecords(source) {
+      const raw = await readSessionFile(source.path)
+      if (raw === null) return null
+      return raw.split('\n').filter(l => l.trim())
+    },
+    decode: decodeQwen,
+    toProviderCall,
+  })
 }
```

Discovery is untouched. The `JSON.parse` loop + token extraction moved to core.
Bash base-name extraction (`extractBashCommands`, with its `strip-ansi` dep) stays
CLI-side and runs in `toProviderCall`. `costBasis: 'estimated'` (from Phase 0) is
priced downstream by `parser.ts`, byte-identical.

---

## Tail classification (as of phase 8.1)

35 provider identities remain after `claude`/`codex`/`qwen` (done). Counts:

| Category | Count | Providers |
|----------|-------|-----------|
| **A. Simple file-based (cheap tail)** | **15** | codebuff, codewhale, droid, gemini, grok, kimi, kimicode, lingtai-tui, mistral-vibe¹, mux, open-design, openclaw, pi, omp, zerostack |
| **B. sqlite-rowed** | **11** | copilot, crush, cursor-agent, devin, forge, goose, hermes, quickdesk, warp, zcode, zed |
| **C. shared-module consumers** | **5** | cline, ibm-bob, roo-code (`vscode-cline-parser`); kilo-code, opencode (`sqlite-session-parser`/`opencode-file-parser`) — plus the shared modules themselves: `vscode-cline-parser`, `sqlite-session-parser`, `opencode-file-parser`, `session-message` |
| **D. stateful multi-store (judgment-tier — NOT the cheap tail)** | **3** | antigravity, cursor, kiro |
| **Network (special: no on-disk file, re-fetch each run)** | **1** | vercel-gateway |

¹ `mistral-vibe` is decode-simple (JSONL, file-based) but a **Phase 0 pricing
misfit** (session-cost allocation, whitelisted). Its decode move is Category A;
its pricing was handled separately in Phase 0. Bridge the decode; do not touch its
cost path.

`pi` and `omp` share `pi.ts` (one file, two registered providers) — one PR covers
both. `antigravity`/`cursor` are sqlite **and** stateful; classified D because the
stateful cache dominates. `kilo-code`/`opencode` are sqlite **and** shared-module;
classified C because the shared decode module should move first.

**Recommended order:** Category A first (highest confidence, smallest PRs), then
the Category C shared modules (one module PR unblocks several consumers), then
Category B (sqlite), and finally hand Category D to Opus.
