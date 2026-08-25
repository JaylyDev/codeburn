# Fork Change Report — `main` vs `origin/main` (Sync Reference)

**Purpose:** Definitive technical inventory of what this fork changed relative to `origin/main`, how those implementations differ, what will conflict on the next upstream merge, and which past claims about this document were wrong. Regenerate/refresh the snapshot numbers in §0 every time you merge from `origin/main`.

**Analysis basis:** three-dot diff `git diff origin/main...HEAD`, full reads of both tree versions (`git show origin/main:<file>`), commit archaeology of all 55 fork commits, empirical verification (`tsc --noEmit`, full `npm test`) run on 2026-08-25. Produced by five parallel deep-analysis passes (copilot provider, antigravity provider, models/pricing, core/config, verification), cross-checked against the actual diffs.

---

## 0. Snapshot

> **2026-08-25 merge executed:** all 61 pending upstream commits merged (`d7e7e8f8`), pre-merge hygiene applied (`ffb7d736`), data regenerated, typecheck green. Numbers below are post-merge.

| Fact | Value |
|---|---|
| Merge base (`git merge-base origin/main HEAD`) | `b305378e351ebb6a401e3de8f48af2565608fd3e` (= origin/main tip; fork is **behind 0**) |
| Fork ahead / behind | **ahead 59 / behind 0** |
| Three-dot delta | **21 files, +2958 / −437** |

Numstat per file (`origin/main...HEAD`, post-merge):

```
 418    0  CHANGES_FORK.md
   0   63  dash/package-lock.json          (libc metadata stripped only)
   6    0  scripts/bundle-litellm.mjs      (+2 MANUAL_ENTRIES rows)
   3    0  src/config.ts                   (+2 config fields)
   1    1  src/data/litellm-snapshot.json  (regenerated bundle)
   1    1  src/data/pricing-fallback.json  (regenerated bundle)
   2    1  src/main.ts                     (setModelNames wiring)
 407  175  src/models.ts
  28   12  src/parser.ts
 340   34  src/providers/antigravity.ts
 924  137  src/providers/copilot.ts        (was +1097/−99 before dead-code purge)
   4    1  src/providers/session-message.ts (namespace peel)
   3    3  src/session-cache.ts            (WHITESPACE ONLY)
   2    0  tests/models-hoist.test.ts
 170    3  tests/models.test.ts
  34    1  tests/pricing-fallback-data.test.ts
 438    4  tests/providers/antigravity.test.ts
 168    0  tests/providers/copilot.test.ts
   7    1  tests/providers/opencode.test.ts
   1    0  tests/setup/env-isolation-vars.ts (+USERPROFILE)
   1    0  tsconfig.json                   ("types": ["node"])
```

> Note: because this fork merges upstream near-weekly, earlier fork work that upstream later adopted (notably the Antigravity Windows process/port discovery) no longer appears in this diff. Sections below describe **what still differs today**, with historical notes where relevant.

---

## 1. Executive summary

The fork is a continuously-merged long-lived branch (~19 feature/fix commits interleaved with ~24 merge commits), not a diverged patch stack. Its substantive deltas:

1. **Copilot provider** (+1097/−99): an entire legacy plain-JSON chat-session parsing subsystem upstream lacks, an auto-mode model-resolution waterfall, transcript `llm_request` extraction, `.json`/`.jsonl` discovery split, Windows JetBrains project attribution.
2. **Antigravity provider** (+340/−35): offline model-attribution overhaul (placeholder/internal-id/opaque-wire tables), Nano Banana image-generation tracking from brain transcripts, transcript-model fallback, CACHE_VERSION bump.
3. **Models & pricing** (+407/−181): a live OpenRouter pricing layer with case-insensitive fallbacks, user-config pricing/display names (`localModelPricing`, `modelNames`), local-GGUF and `-free` suffix normalization, dozens of evidence-backed alias remaps (incl. fixing a ~56M-token Gemini misattribution), dot-version short-name derivations.
4. **Parser/core** (+25/−12): server-billed-provider cost precedence on cache read, empty-timestamp range-slice resilience, negative-cost diagnostics.
5. **Config/build/test infra**: two new config surfaces wired in `preAction`, `"types": ["node"]`, Windows `USERPROFILE` test isolation, lockfile metadata churn.

Cost of the divergence: HEAD currently **fails typecheck** (2 errors), ships one debug `console.log`, carries ~8 dead symbols, and contains two parser regressions (timestamp fallback loss, read-side cost allowlist gap) detailed in §9. Next-merge hot spots are `models.ts` (SEVERE), `parser.ts` (MED-HIGH), `main.ts preAction` (MED), and the regenerated pricing data files (guaranteed conflicts) — see §10.

---

## 2. Copilot provider — `src/providers/copilot.ts` (+1097/−99)

### 2.1 Legacy JSON chat-session pipeline (the core addition)

Upstream parses five source kinds (CLI JSONL, OTel SQLite, session-store SQLite, VS Code chatSessions `.jsonl` journals, JetBrains Nitrite). The fork adds a sixth shape: **legacy monolithic JSON sessions** (top-level object with a `requests[]` array).

Two entry points feed one orchestrator:

- `createJsonlParser` sniffs whole-file JSON via `isChatSessionJsonFormat()` (`copilot.ts:1108`) — extension `.json` + top-level `requests` array sniff. Used for discovered `.json` files (which are pushed **without** `sourceType`).
- `createChatSessionParser` (`:2086`) — after `replayChatSessionJournal(content)` replays the modern `.jsonl` mutation journal into a root object, it delegates the whole request loop to `parseLegacyChatSession(root, …)` (`:2095-2099`), replacing upstream's inline loop entirely.

`parseLegacyChatSession` (`:627-811`) per request:

- **Messages:** `message` as plain string or `{ text }` object (`msgText`, `:661`).
- **Outputs:** `extractLegacyOutputs` (`:498-578`) has two mutually exclusive paths:
  - `result.metadata.toolCallRounds` present → round `.response` strings + `toolCalls[].arguments` + `round.thinking.text` (string or `string[]`, counted as reasoning);
  - otherwise response parts scanned for bare `value` markdown strings, `markdownContent`/`markdownVuln` (string or `{value}`), `thinking` parts, and `textEditGroup` edits (tolerant 1D/2D `{text}` traversal, `:545-560`).
  - A trailing pass appends `invocationMessage` in **both** string and `{value}` object form (`:566-575`). Upstream looked at none of the response content — these restore billable output for edit-heavy/tool-narration turns.
- **Serialized tool invocations:** richer `$mid:21`/`$mid:23` extractor first (`extractToolCallResultContent` `:311-326`, render-tree walk `extractRenderNodeTexts` `:291`); if empty, fallback `extractToolCallResultContentFromParts` (`:462-491`) pulls `toolSpecificData.terminalCommandOutput.text` and decodes `resultDetails.output.base64Data` (`Buffer.from(base64,'base64')` when `output.type === 'data'`).
- **Token accounting:** char estimates at `CHARS_PER_TOKEN_LEGACY = 4` from `renderedGlobalContext`/`renderedUserMessage`; with CacheBreakpoint markers global context is classified cache-read and user attachments cache-creation. Exact-token escalation ladder (`:722-752`): `req.promptTokens/completionTokens` → `resultObj.promptTokens/outputTokens` (+cache fields) → `resultObj.metadata.*` → `resultObj.usage.*` (camel+snake); any hit sets `costIsEstimated=false`. Skip rule only when input, output, cacheCreation **and** reasoning are all zero (upstream skipped any 0/0 request — fork's rule is deliberately more permissive so estimated-only requests surface).

### 2.2 Auto-mode model resolution waterfall

Live chain — `extractModelFromRequest(req, session)` (`:580-625`), in order:

1. `metadata.resolvedModel` / `metadata.model` (rejecting `auto`/`copilot-auto`)
2. `result.resolvedModel` / `result.model`
3. response part `kind === 'autoModeResolution'` → `resolvedModel|model|modelId`
4. JetBrains model token found in `result.details`
5. `req.modelId` (rejecting `auto`/`copilot/auto`)
6. session-level `inferModelFromLegacySession(session)`
7. hard fallback `'claude-sonnet-4-5'`

`inferModelFromLegacySession` (`:411-460`): first usable normalized `modelId` → **`inputState.selectedModel.metadata.version || metadata.family || identifier`** → tool-call-ID prefix hints (`toolu_bdrk_`/`toolu_vrtx_`/`tooluse_`/`toolu_` → `copilot-anthropic-auto`; `call_` → `copilot-openai-auto`) against both `toolCallRounds[].toolCalls[].id` and `response[].toolCallId` → `'copilot-auto'`.

Everything passes through `normaliseLegacyModelId` (`:107-114`): strips a `<provider>/` prefix then folds `4.6`→`4-6` (which is why the hyphenated display entries below exist).

Transcript chain: `inferTranscriptModel` returns `normaliseLegacyModelId(attrs.model)` from the first `llm_request`/`llm.request` event before prefix counting (`:1671-1702`; union member added `:1197`); `inferModelFromToolCallIds` weights any event's `attrs.model`/`data.model` at +100 versus per-tool-call prefix votes at +1 (`:952-985`).

> ⚠️ `modelFromChatSessionRequest` (`:1545`) was rewritten (autoModeResolution scan, `rootModel?` param) but is now **dead code** — its only caller was upstream's inline loop, which the fork replaced. Same for `extractChatSessionTools` (`:1571`). The capability lives in `extractModelFromRequest` step 3 instead.

### 2.3 Discovery: `.json` vs `.jsonl`

`discoverWorkspaceChatSessions` / `discoverEmptyWindowChatSessions` (`:3689-3790`) now probe **five candidate dirs** per hash dir (`chatSessions`, plus `GitHub.copilot-chat/`, `github.copilot-chat/`, `GitHub.copilot/`, `github.copilot/` case variants), defer+cache `resolveWorkspaceProject`, and accept both extensions: `.jsonl` keeps `sourceType: 'chatsession'`; **`.json` is pushed without `sourceType`**, falling through to `createJsonlParser` → `isChatSessionJsonFormat` → `parseLegacyChatSession` with `sessionId = basename(path, '.json')`.

Edge cases: `hasChatSessionFiles` (`:3669`) still only knows `.jsonl`, so transcript-suppression gating ignores legacy `.json` presence; a non-sniffing `.json` continues harmlessly into the JSONL line loop.

### 2.4 Display names and other deltas

- `modelDisplayNames` literal rewritten (`:816-851`): dot/dash pairs `gpt-5.4`/`gpt-5-4`, `gpt-5.3-codex`/`gpt-5-3-codex`, `gpt-5.2-codex`/`gpt-5-2-codex`, `gpt-5.1-codex-max`/`gpt-5-1-codex-max`, `gpt-5.4-mini`/`gpt-5-4-mini`, `gpt-4-1`, Sonnet 4.6, Opus 4.6/4.7, Haiku 4.5, Gemini preview ids, identity pins `o4-mini`/`o3`, `copilot-auto`/`auto`. Lookup changed semantically (`:3903-3908`): exact key match first, and the miss path now returns `getShortModelName(model)` instead of echoing the raw id — a **global** display change for unknown models.
- Routing-order swap in `createSessionParser` (`:4020-4028`): `session-store` checked before `otel`. No behavioral effect today (predicates disjoint) but a guaranteed textual conflict.
- `inferJetBrainsProject` rewritten (`:2189-2221`): accepts `file:///C:\…` and `/C:/…` drive-letter URIs, optional `localhost` host, lookahead terminators, backslash→slash normalization, `dirname()` resolution, and a win32 `/C:/` prefix strip. Upstream's regex matched POSIX-looking URIs only, so Windows JetBrains chats fell into the generic bucket; this fix is fork-only and must be carried forward manually.
- Debug leftover: `console.log('SHUTDOWN AUTO: …')` at `:1980` ships noise to stdout on every auto-model shutdown rollup — remove before any upstream contribution.
- Whitespace churn at `:1361`, `:1442`.

### 2.5 Tests

New describe block "copilot provider - legacy JSON format" (~`:3240-3405`), five tests, zero upstream coverage of this area otherwise:

1. string message + `markdownContent{content:{value}}` → model `gpt-4o` (exercises `normaliseLegacyModelId`), estimated input/output > 0;
2. missing `modelId` + `tooluse_abc123` tool call id → `copilot-anthropic-auto`;
3. `kind:'thinking'` part → `reasoningTokens > 0`;
4. base64 `resultDetails.output{type:'data'}` → exact `inputTokens === 10` (pins decode-and-add);
5. root `promptTokens/completionTokens` → exact 100/200, `costIsEstimated === false`.

Fixtures omit `sourceType` deliberately (locks the discovery-less routing path). Two win32 early-return skip-guards (`:2314`, `:2341`) protect upstream chmod-0o000 permission tests that cannot fail on Windows. Suite result: **115 passed**.

### 2.6 Merge-conflict hot spots (next upstream merge)

1. `createChatSessionParser` body — wholesale replaced; **any upstream bugfix to its inline loop must be re-derived inside `parseLegacyChatSession`** (#1 hazard).
2. `modelDisplayNames` literal + `modelDisplayName()` method (both sides actively edit).
3. Discovery functions (control flow rewritten).
4. `createJsonlParser` head (fork inserts legacy-sniff block).
5. Shutdown-rollup block (the debug log sits on the `calculateCost` line).
6. `CopilotEvent` union (inserted mid-union), `inferJetBrainsProject`, routing order, import header (`getShortModelName`).

---

## 3. Antigravity provider — `src/providers/antigravity.ts` (+340/−35)

### 3.1 Historical arc

Windows support (`15fe8e2c` PowerShell CIM + `Get-NetTCPConnection` port discovery keyed on CSRF token) and the `antigravity-ide` flavor (`7cb19ab1`) were introduced by this fork but have **since been absorbed identically by origin/main** — the remaining diff in `resolveEphemeralPort`/`readProcessCommandLines` is whitespace only. A naive hardcoded `KNOWN_MODEL_IDS` guess table (`3b4bc29e`) was retracted in `cc735899` ("Actually fix antigravity parser"), establishing the current philosophy: *don't invent mappings without evidence/pricing coverage*. Multimodal tracking landed `96bca969`; the final attribution overhaul is `fc923168`.

### 3.2 Offline model-attribution overhaul (the largest correctness work)

- `canonicalizeInternalModelId` (`:354-363`, exported): matches `/^MODEL_[A-Z0-9_]+$/` (excluding `MODEL_PLACEHOLDER_`), strips vendor segment and trailing effort tier, joins/lowercases, and returns the candidate **only if `getModelCosts(candidate)` prices it** — e.g. `MODEL_OPENAI_GPT_OSS_120B_MEDIUM` → `gpt-oss-120b`.
- `PLACEHOLDER_MODEL_IDS` (`:316-329`): 12-entry static table for opaque enum slots (M16/M36/M37→`gemini-3.1-pro`; M18/M47/M84→`gemini-3-flash-preview`; M20/M132/M133/M187→`gemini-3.5-flash`; M26→`claude-opus-4-6`; M35→`claude-sonnet-4-6`), sourced from pinned external references.
- `OPAQUE_WIRE_MODEL_IDS` (`:340-345`): `gemini-default`, `gemini-pro-a/b/c` are role labels; a known placeholder enum outranks the verbatim wire id.
- `antigravitySqliteModel` rewritten (`:880-927`) into a 7-step precedence chain (live modelMap translation → non-internal enum verbatim → placeholder-table → clean raw #19 → placeholder/canonicalized enum → canonicalized raw → displayName), finally re-passed through `getCanonicalModelId`. Upstream's version was enum-first, leaking raw `MODEL_OPENAI_*`/`unknown` whenever the IDE was closed; the fork correctly prices offline sessions.
- `extractAntigravityModelMap` (`:447-465`): placeholder entries with server display names canonicalize off `info.model` rather than the raw config key.
- `CACHE_VERSION` 5 → **6**; persisted `AntigravityCache` gains optional `modelMap?`.
- Display-name prettifier fallback (`:1778-1789`) title-cases unknown ids, strips tier suffixes and `'Claude '`.

### 3.3 Transcript fallback & image tracking

- `inferAntigravityTranscriptModel` (`:969-1000`, async, module-level per-cascade cache with no TTL; `clearAntigravityTranscriptModelCache` exported): when sqlite resolves to `unknown`, scans six brain-transcript candidates under `~/.gemini/{antigravity,antigravity-cli,antigravity-ide}/brain/<cascadeId>/.system_generated/logs/transcript(.full).jsonl` for `changed setting ['"]Model Selection['"] from … to …`, taking the **first** match (earliest, not last setting).
- `parseAntigravityImageToolCalls` (`:1087-1159`): parses `generate_image` tool_calls from the same transcripts. Heuristic token accounting — `promptTokens = max(1, round(len/4))`, `+1024` input if `ImagePaths` (image-to-image), fixed `1024` output, `costUSD = calculateCost(...) || 0.03` floor. Model choice: `nano-banana-pro` if prompt/ImageName contains substring `pro` (case-insensitive — a prompt like "a professional photo" misclassifies), else `nano-banana`. Wired into **both** parse paths (`combinedResults = [...sqliteResults, ...imageCalls]` sqlite path; appended to generator-metadata results on the RPC path).
- Side effect: `detectServer`/`getModelMap` hoisted above the cache-hit check (`:1653-1657`), so even fully cached cascades trigger one process-discovery cycle per run (extra `powershell.exe` spawn; harmless but slower than upstream's skip-on-cache-hit).

### 3.4 Canonical mapping additions

In `getCanonicalModelId` (`:365-445`): Nano Banana labels → pro ? `gemini-3-pro-image` : `gemini-3.1-flash-image`; `imagen` → `imagen-3`; `veo` → `veo-3`/`veo-2`; Claude thinking labels (`claude sonnet 4.6` → `claude-sonnet-4-6`); `3.7 flash` → `gemini-3.7-flash`; image sub-branches for Gemini 3 Pro / 3 Flash / 2.5 Flash labels. `modelDisplayNames` (`:1745-1771`) adds the matching entries.

### 3.5 Known gaps / failure modes

- **Dead plumbing:** `parseSqliteGenMetadataCalls(source.path, cascadeId, cache.modelMap)` reads `cache.modelMap`, which is **never written anywhere** — the freshly fetched map feeds only `buildCallsFromGeneratorMetadata`. The sqlite path works solely via the static tables.
- Unknown placeholder + displayName can slugify into an invented name (contradicts the "stays unknown" comment, which only holds sans displayName).
- **Video (Veo) has no invocation parser at all** — mapping/display names only; video generations remain invisible to spend tracking.
- Whole-file transcript reads (no size cap); earliest-match transcript regex; scans all three app dirs regardless of the row's source dir.
- Missing final newline at EOF (cosmetic conflict bait).

### 3.6 Tests (+438/−4)

Replaced upstream's single no-leak test with four; new `encodeGenMetadataRow` helper hand-builds real-shaped protobuf blobs; a describe for internal-id canonicalization; **11 integration tests constructing real node:sqlite DBs** through the full parser (offline raw-id precedence, gpt-oss dialects, enum-only, signal-less unknown, placeholder-only pricing, opaque wire ids ± enums, clean-id regression guard, Claude-thinking and Gemini-3.7 transcript inference end-to-end, brain-transcript recovery); `withIsolatedAntigravityHome` fixture sets **both `HOME` and `USERPROFILE`** to a sandbox. Suite result: **45 passed**.

### 3.7 Merge-conflict hot spots

High: `createParser().parse()` restructure (sits atop upstream's most-churned function), `antigravitySqliteModel` (wholly diverged signature/body), `getCanonicalModelId` (nearly tripled), `extractAntigravityModelMap` loop, the `buildCall*/buildCallsFrom*` signatures that gained params + async. Medium: new insertion block `:299-363`, display-name regions, cache type/version. Low: pure-addition blocks `:963-1159`, most test additions.

---

## 4. Models & pricing engine — `src/models.ts` (+407/−181)

### 4.1 Live OpenRouter pricing layer (fork-exclusive)

Upstream gap-fills solely from the bundled `pricing-fallback.json`. The fork adds a live second source: `OPENROUTER_URL`, `getOpenRouterCachePath()` → `<cache>/openrouter-snapshot.json` with 24h TTL via `stat` mtime, `parseOpenRouterPricing()` (indexes each id also under its stripped form `vendor/x → x`; derives `cacheWrite = input×1.25`, `cacheRead = input×0.1`, `fastMultiplier = 1`), fetch/cache/load functions, all wired at the end of `loadPricing()` after the LiteLLM path (`:369-397`).

### 4.2 Case-insensitive fallback fixes (the `$0 gemini-3.6-flash` bug)

- `getLowercasePricingIndex()` gained a loop over `openRouterPricing` between `pricingCache` and `fallbackCosts` (`:252-255`).
- `getModelCosts` gained a terminal ladder before returning null (`:1163-1166`): `fallbackCosts.get(lowerCanonical)` → `openRouterPricing.get(canonical)` → `openRouterPricing.get(lowerCanonical)`.
- Net effect: OpenRouter-served slugs absent from LiteLLM resolve regardless of case/prefix spelling.

### 4.3 User-config pricing & naming

- `config.localModelPricing?: Record<string, LiteLLMEntry>` → `applyLocalModelPricing()` (`:348-360`, called at end of `loadPricing`) parses each entry with `parseLiteLLMEntry` and injects into the pricing map — users can price local/Ollama models in config JSON. Ordering nuance: built-in price overrides apply **after** user rows within this call.
- `config.modelNames?: Record<string, string>` → `setModelNames()` (`:618-630`, wired in `main.ts:468` `preAction`) stores user display names plus a provider-stripped secondary index (first-write-wins); `lookupShortName` checks them **first**, overriding everything else.
- `LiteLLMEntry` is now exported (consumed by `config.ts`).

### 4.4 Normalization pipeline additions

Wired into `getCanonicalName` (`:987-998`):

- `stripTerminalFreeSuffix` — strips `-free` only as the **terminal** segment (`^(.+)-free$`), so routing namespaces like `cline-free/` survive; OpenCode free-tier SKUs (`mimo-v2.5-free`, `nemotron-3-ultra-free`) reach their priced rows.
- `stripLocalGgufFilename` — drops `.gguf` plus one trailing llama.cpp quant tag (`Q4_K_M`, `IQ4_XS`, `BF16`, …), folding case **only** when something was stripped; ollama colon tags deliberately untouched (#968).

### 4.5 Alias remaps with measured impact (highlights)

- `'gemini-3-flash-agent': 'gemini-3.5-flash'` (was `gemini-3-flash-preview`) — the `-a/-b/-agent` wire ids bind `MODEL_PLACEHOLDER_M132/M133`, whose server name is "Gemini 3.5 Flash (High)". The old target **misattributed ~56M observed tokens**. Bare `gemini-3-flash` deliberately stays on the retired preview family.
- `gemini-pro-agent` / `gemini-pro-default` → `gemini-3.1-pro-preview` (priced row, not intermediate alias); opaque `gemini-pro-a/-c` → 3.1 Pro preview; `gemini-default` → 3.5 flash.
- Claude thinking spellings ×4 collapse onto base SKUs; Copilot capacity pods `capi-noe-ptuc-h200-ib-…` / `capi-cus-ptuc-h100-ib-…` mapped **exact-string only** (no peel regex, so unknown pods stay unpriced).
- Multimodal: `nano-banana{,-2,-lite,-pro}`, `nanobanana*` → image-preview rows; `imagen-3`, `veo-2/3` self-aliases (no invented rates); `gemini-3-pro-image(-high)` → `gemini-3-pro-image-preview`; `gemini-2.5-flash-image` pair.
- Local ecosystem: `ornith-1.5-35b` → `-a3b` row; `nemotron-3-ultra` → `550b-a55b`; `nemotron-3.5-lightning` → `nvidia/…`; corrupted `gemma-4-26b-a4bvgemma-4-26b-a4b` alias.
- `buildCosts` clamps negative input/output to 0; `calculateCost` returns $0 when a resolved rate is negative (guards corrupt catalog rows).

### 4.6 Short-name derivation

- `deriveClaudeShortName` regex widened `\d+` → `[\d.]+` (`:1488`) so tier-first dot ids (`claude-opus-4.6` → "Opus 4.6") derive directly; dash ids take the major-minor path; both produce identical strings.
- **NEW** `deriveGeminiShortName` (`:1494-1500`): `/^gemini-([\d.]+)-(pro|flash|ultra|nano)(?:-.*)?$/i` → "Gemini X.Y Tier", swallowing `-preview`/`-high`/`-image-preview`/`-tts` suffixes with zero per-release maintenance.
- Resolution order in `lookupShortName`: user `modelNames` → Claude derivation → Gemini derivation → longest-first static table. Every consumer (dashboard overview, `codeburn models` CLI report, menubar JSON, parser aggregation keys) funnels through the same resolver, keeping Dashboard and CLI uniform.
- ⚠️ Wrinkle: derivation runs **before** the static table, so `gemini-3.1-flash-image-preview` derives to "Gemini 3.1 Flash" (loses "Image"), shadowing/deadening the table entries for all three image-preview rows — `nanobanana-pro` displays as "Nano Banana Pro" while its priced row displays as "Gemini 3 Pro": two rows, one SKU. Cosmetic; worth fixing by checking the table first for `-image` ids.

### 4.7 Bundler & data

`scripts/bundle-litellm.mjs` adds two `MANUAL_ENTRIES` rows (ornith launch pricing, explicit no-fabricated-cache-write note). Both data JSONs are routine single-line regeneration outputs (new models added, stale ones dropped, batch rates repriced) — **never hand-merge these; regenerate post-merge**.

### 4.8 Tests

- `tests/models.test.ts` (+180/−8): inverted gpt-5.6-codex snapshot contract (Codex SKUs now differ from base); terminal-`-free` semantics incl. mid-name immunity; claude-thinking aliases; machine-id retargets (pins the counterintuitive 3.5-flash redirect); capi pods exact-only policy; GGUF canonicalization (priced, unpriced-no-invention, colon-tag untouched, mid-id quant tokens intact); DeepSeek v4 prefixed-vs-bare distinct-rate brittleness.
- `tests/pricing-fallback-data.test.ts` (new): bundler postcondition gates — >50 entries, no negative sentinels, no 0/0 rows, no unreachable date-suffixed/`@pin` keys, no per-million leaks, ornith tuple pins. (Uses legacy `assert { type: 'json' }` syntax — inconsistent with `models.ts` `with`; normalize.)
- `tests/models-hoist.test.ts` (+2): `kimi-k2.7-code` and `glm-5.2` join the stability fixture.
- `tests/providers/opencode.test.ts` (+7/−1): `@cf/zai-org/glm-5.2` / `@cf/moonshotai/kimi-k2.7-code` display names; expectation flip `edenai/router-model` → `router-model` (locks the `session-message.ts` peel, §6.2).

### 4.9 Merge-conflict hot spots

🔴 **SEVERE:** `loadPricing` — both sides rewrote it (upstream added `livePricingTimestamp` resets + generation-key feed-in; fork added the OpenRouter layer + `applyLocalModelPricing`). 🔴 High semantic: `CACHE_SCHEMA_VERSION` region — upstream re-exported the const and added ~30 lines of `getPricingGenerationKey`/`getBundledPricingDigest` machinery; losing it breaks staleness detection (`113ebb1c`). 🟠 High: `mergeSnapshotFallbacks` override-timing models must be reconciled; `getCanonicalName` pipelines must compose with upstream's new alias-preservation early return (`orcarouter/fusion`). 🟡 Medium additive: `BUILTIN_ALIASES` tail (upstream adds OrcaRouter rows), SHORT_NAMES region (fork deleted many rationale comments — merge-noise generator). Data JSONs: guaranteed conflicts every sync.

---

## 5. Parser & core pipeline — `src/parser.ts` (+25/−12)

Three real changes (everything else in old notes was upstream work absorbed by syncs):

1. **Server-billed-provider cost precedence on cache read** (`:2684-2685`): for providers `mistral-vibe | antigravity | devin | vercel-gateway | hermes | kiro | codewhale`, a stored `call.costUSD` wins over token-derived recalculation (`finalCost`); otherwise derived `costUSD` is used. Context: the **write** side already gates stored costs by a 9-provider allowlist on both trees. ⚠️ **Fork bug:** the read-side list has only 7 — `quickdesk` and `cline-cli` are write-allowlisted but read-dropped, so their cached server-billed costs get re-priced from tokens (this is almost certainly the failing `provider-turn-grouping` Cline-cost test). Recommended resolution at next merge: drop the fork's redundant read-side check in favor of upstream's `call.costUSD ?? costUSD`.
2. **Negative-cost diagnostics** (`:2503-2505` fresh path, `:2686-2688` cache path): `console.log('[parser] Negative cost detected …')` with model/id/values; `cachedCallToApiCall` grew an optional `sessionId` param threaded from `cachedTurnToClassified` (`:2734`). Diagnostic-only (logs, does not clamp) and **not gated on `CODEBURN_VERBOSE`** — can pollute machine-readable CLI output.
3. **Empty-timestamp range/day slicing resilience** (`callsInRange` gained `fallbackTs?: string`, `:3178`; slice functions pass `turn.timestamp` and re-anchor with `|| turn.timestamp`; undated calls are kept, `return true`): previously calls parsed without timestamps (legacy Copilot/Antigravity paths) could make days vanish from `--since/--until` and menubar day buckets.

**Not fork changes despite prior doc claims:** PR URL extraction (`extractPrUrlsFromText`/regex byte-identical to upstream) and all session-cache retry logic (see §7.2).

Merge risk MED-HIGH: upstream rewrote exactly these regions for nanoAiu/supplementaryAccounting (`0c7d92a3`) and status-snapshot work — expect textual conflicts at hunks ≈2500, 2669-2705, 2731 plus the semantic decision in (1).

---

## 6. Config, CLI wiring, shared session builder

### 6.1 `src/config.ts` (+3) and `src/main.ts` (+2/−1)

New optional config fields `localModelPricing?: Record<string, LiteLLMEntry>` and `modelNames?: Record<string, string>` (after `localModelSavings`), consumed as described in §4.3. `preAction` wires `setModelNames(config.modelNames ?? {})` alongside the existing setters so every command gets naming context. Low textual risk, but depends on fork-only `models.ts` symbols — keep the pairing intact.

### 6.2 `src/providers/session-message.ts` (+4/−1)

Shared builder for OpenCode-style stores (OpenCode SQLite/file, Kilo Code) now peels everything up to the final `/` from `data.modelID ?? data.model` before pricing/aggregation (`:132-135`). Fixes $0 costs for namespaced ids whose LiteLLM rows are keyed bare. Sharp edges: ids whose canonical form needs the namespace lose their qualifier (e.g. `deepseek/deepseek-v4-pro` collapses from 1.32e-6 to the bare 4.35e-7 row — tension with `tests/models.test.ts` exact-catalog expectations), a value ending in `/` yields `''`.

### 6.3 Not changed

`session-message.ts` is the only provider-shared file touched; `cursor.ts`, `yield.ts`, `daily-cache.ts`, `providers/opencode.ts`, `providers/types.ts` have **zero** fork delta.

---

## 7. Build & test infrastructure

### 7.1 `tsconfig.json` — `"types": ["node"]`

Deterministic @types inclusion (repo hoists `@types/{chai,deep-eql,estree,node,react,selfsigned}`; auto-inclusion drags React/chai globals into the CLI compile). Empirical A/B compile shows the flag is **currently non-differentiating** — whatever error it fixed depended on an earlier dependency state. Orthogonal to JSON import attributes (`resolveJsonModule` present on both sides).

### 7.2 `src/session-cache.ts` — whitespace only

Entire delta is `{}` → `{ }` in three empty blocks. The atomic-write rename retry (EPERM/EBUSY, 3 attempts, 10/20 ms backoff) and `retryCacheFileMutation` exist **identically in upstream** — the previous doc's "file mutation retry logic" claim was upstream work absorbed by a sync. Expect conflicts elsewhere in this file from upstream's month-shard re-layout; take upstream.

### 7.3 `tests/setup/env-isolation-vars.ts` — `USERPROFILE` redirected

On Windows, Node's `os.homedir()` consults `USERPROFILE` before `HOME`; redirecting only `HOME` left homedir()-based discovery pointed at the real profile during tests. One-line, fork-only, high-value.

### 7.4 `dash/package-lock.json` — metadata churn, NOT deletion

All −63 lines are `"libc": ["glibc"|"musl"]` blocks stripped from 23 native optional deps (`@rollup/*` ×14, `@tailwindcss/oxide-*` ×5, `lightningcss-linux-*` ×4) by a different npm version. No versions/resolutions/integrity changed. Consequence: musl installs may momentarily attempt glibc binaries; and this file is a perpetual three-way-merge noise generator — regenerate after merges rather than hand-resolving.

---

## 8. Verification status (post-merge, 2026-08-25)

### 8.1 Typecheck — ✅ PASS

`npx tsc --noEmit` exits 0 on the merged tree. The two pre-merge TS2353 `sourceType` errors were fixed by restoring upstream-style `Promise<ChatSessionSource[]>` discovery typing with `sourceType?: 'chatsession'` optional in the fork's local interface (legacy `.json` sources omit the field and route through `createJsonlParser` instead).

### 8.2 Test suite — 123 failed / 3231 passed / 5 skipped (246 files, ~68 s)

Post-merge baseline. Upstream added 83 new tests; the three new upstream suites that fail (`launcher-homes` ×10, `cli-status-menubar` ×4, `session-cache-status-snapshot` ×1) **also fail on pure origin/main** (19/39 there vs 15/39 merged — verified via a throwaway worktree at `b305378e`): POSIX symlink/cache-path assumptions, not merge regressions.

Merge-related improvements over the pre-merge baseline: `session-cache-v5-adoption` ×2 → **fixed**; parser month-shard `(sc) copilot` ×2 → **fixed**; `provider-turn-grouping` Cline-cost ×1 → **fixed** (the §5 read-side `??` adoption).

Classification:

| Class | ≈Count | Notes |
|---|---|---|
| Environmental / Windows-only (paths, symlinks, chmod, XDG, TZ, ESM-URL, mkdir ordering) | ~100 | devin ×19, sync-ledger ×11, launcher-homes ×10, claude-config-dirs ×8, sqlite-readonly ×7, sync-push/parser-claude-cwd ×6 each, cli-status-menubar ×4 … Need a Linux CI baseline to confirm. |
| Likely fork-related | ~7 | antigravity-statusline ×2 (fork writes quoted command, upstream test expects unquoted); cache-directory-switch ×3 (antigravity cache isolation); guard-hooks ×1; cli-settings-json ×1. |
| Ambiguous / triage | ~4 | context-tree-api-prefix ×2, cli-json-daily ×3 timezone-sensitive, parser-gemini-cache ×1. |

The lock suite (`npm run test:locks`) is excluded from `npm test` by design; on this machine the merged tree completes with 8 timing failures while the pre-merge tree hangs >15 min — treat as Windows-timing noise.

**All fork-touched suites pass post-merge:** copilot + antigravity + models + pricing-fallback-data + models-hoist + opencode = **435/435**.

---

## 9. Known fork bugs, regressions & hygiene debt

**2026-08-25 status: items 1–6 from the pre-merge audit are RESOLVED** (typecheck fixed; read-side `??` adopted; creationDate fallback restored with RangeError-safe `timestampToISO`; dedup index aligned; SHUTDOWN AUTO log removed and negative-cost diagnostics gated behind `CODEBURN_VERBOSE`; 7 dead copilot functions + orphaned `ChatSessionRequest` type + unused `homedir` import deleted; `assert`→`with` normalized; antigravity EOF newline added).

Remaining:

1. **Dead plumbing:** `parseSqliteGenMetadataCalls(source.path, cascadeId, cache.modelMap)` (antigravity.ts) reads `cache.modelMap`, which is never written — the sqlite path works solely via static tables. Either wire the fetched map into the persisted cache or drop the param.
2. **Display shadowing:** `deriveGeminiShortName` runs before SHORT_NAMES, so image-preview rows derive to names without "Image" (`gemini-3.1-flash-image-preview` → "Gemini 3.1 Flash"); `nanobanana-pro` displays as "Nano Banana Pro" while its priced row displays as "Gemini 3 Pro" — two rows, one SKU. Fix by checking the static table first for `-image` ids.
3. **Image heuristics:** substring `pro` misclassification, flat 1024-token outputs, $0.03 floor — acceptable estimates, but document them as estimates.
4. **Minor:** `model.split('/').pop()` in session-message.ts can yield `''` on trailing-slash ids; antigravity-statusline test conflict (fork quotes the command on Windows, upstream test expects raw path — make quoting OS-conditional).
5. **New post-merge watch items:** upstream's Copilot nanoAiu twin-dedup (`src/copilot-aiu.ts`) now consumes fork-parsed legacy sessions — watch for double counting between `parseLegacyChatSession` outputs and shutdown rollups; sync privacy rules (`src/path-privacy.ts`) are active on outbound payloads — fork-local project labels must never reach them.

---

## 10. Upstream backlog — MERGED 2026-08-25

The 61-commit backlog (status-snapshot perf PR #999, menubar quota parity #1133/#1136, Copilot nanoAiu credits #1123, OrcaRouter pricing #1118, sync privacy #1126/#1128, Codex nest robustness, doctor launcher-homes #1099, release 0.9.21) is now **fully merged and resolved**. The §10 merge-risk matrix from the previous revision played out as predicted: `models.ts` required the composed `loadPricing`/`getCanonicalName` resolutions documented in §11's log; everything else auto-merged or took upstream.

**Standing watch list going forward** (semantic adjacencies that survive the merge):

| Area | Watch item |
|---|---|
| Copilot nanoAiu twins (`copilot-aiu.ts`, plan-usage) | Fork's legacy-session parser feeds upstream's credit math — audit for double counting vs shutdown rollups. |
| Menubar Antigravity quota (Swift layer) | Align model-id naming with the fork's Nano Banana / placeholder tables across TS and Swift. |
| Sync privacy (`path-privacy.ts`) | Fork-local project labels must never appear on outbound payloads. |
| Daily-cache versioning | Fork ships upstream's current version post-merge; any future fork-side cached-shape change must bump it. |
| Data JSONs + dash lockfile | Still regeneration-only files; never hand-merge. |
| `tests/models.test.ts` numeric pins | DeepSeek/gpt-5.6 sections now use upstream's looser non-null contracts; re-tighten only against stable bundled data. |

For the next upstream sync, re-run the analysis protocol: refresh §0, diff `HEAD...origin/main` for overlap with the numstat above, and update this section.

---

## 11. Recommended merge protocol

```bash
# Pre-merge hygiene (on fork main, BEFORE git merge):
#   1. Fix the 2 TS2353 sourceType errors (decide vs upstream types.ts direction).
#   2. Remove/gate the debug console.logs; delete or wire dead symbols (§9.6).
#   3. Restore the creationDate timestamp fallback; align dedup index base with upstream.
#   4. Extend the parser read-side cost check to all 9 write-allowlisted providers
#      (or adopt upstream's ?? outright).

git checkout -b sync/upstream-merge
git fetch origin
git merge origin/main --no-commit

# Conflict guidance:
#   - models.ts: keep fork aliases/derivations/OpenRouter layer; adopt upstream
#     generation-key machinery, OrcaRouter rows, EXTRA_NAMESPACES additions.
#   - parser.ts: adopt upstream nanoAiu spreads; keep empty-timestamp fallbacks;
#     keep negative-cost logging only behind CODEBURN_VERBOSE if kept at all.
#   - data/*.json + dash/package-lock.json: take upstream, then regenerate.
#   - session-cache.ts: take upstream.

npm run bundle-litellm        # regenerate pricing data post-adopt
npx tsc --noEmit              # must pass
npm test                      # compare against the §8.2 baseline (110 env failures)
npx vitest run tests/providers/copilot.test.ts tests/providers/antigravity.test.ts \
  tests/models.test.ts tests/pricing-fallback-data.test.ts tests/models-hoist.test.ts
npm run test:locks
```

Post-merge: refresh §0 numbers, update §10 severities, and prune resolved items from §9.

### 11.1 Merge log — 2026-08-25 (`d7e7e8f8`)

Executed per this protocol. Pre-merge hygiene landed as `ffb7d736` (§9 items 1–6). Actual conflict resolutions:

| File | Resolution |
|---|---|
| `src/models.ts` | Composed `loadPricing` (fork's no-early-return structure so OpenRouter + `applyLocalModelPricing` + index resets run on every path; upstream's `livePricingTimestamp = null` in snapshot-only + catch paths). Took upstream's exported `CACHE_SCHEMA_VERSION` + generation-key machinery verbatim. `getCanonicalName`: upstream's alias-preservation early return first, then fork's `stripTerminalFreeSuffix`→`stripLocalGgufFilename` chain before namespace peel. Fork's lowercase-index loop + terminal ladder intact. |
| `src/main.ts` | Import union (fork `setModelNames` + upstream's 8 new hash/fingerprint imports); fork's `setModelNames(config.modelNames ?? {})` survived the upstream `preAction` refactor at its original position. |
| `tests/models.test.ts` | Adopted upstream's loosened gpt-5.6-codex and DeepSeek prefixed-vs-bare contracts (live LiteLLM repricing made exact pins brittle); all fork describe blocks kept. |
| `src/data/litellm-snapshot.json` | Upstream base, then regenerated via `npm run bundle-litellm` (re-applies ornith MANUAL_ENTRIES; bundler notes 4 MANUAL rows now covered by LiteLLM — candidates to prune later). |
| `src/data/pricing-fallback.json` | Regenerated (committed as follow-up `be64245e`). |
| auto-merged | `parser.ts`, `config.ts`, `session-cache.ts`, `session-message.ts`, everything else — the pre-merge hygiene pass removed the predicted conflict surface. |

Post-merge verification: `tsc --noEmit` clean; fork suites 435/435; full suite deltas vs baseline fully attributed (see §8.2).

---

## 12. Audit of the previous version of this document

The prior revision contained several claims contradicted by the code. Verdicts (kept here so stale claims don't resurface):

| Old claim | Verdict |
|---|---|
| §1 "Added robust Windows support for Antigravity" | ⚠️ Historically true, **since absorbed identically by origin/main**; remaining delta whitespace-only. |
| §1/§8 "latest output/logs format" handling | ✅ Real, concretely: placeholder/internal-id/opaque-wire attribution tables + transcript fallback (§3.2-3.3). |
| §2 legacy parsing "+1000 lines", structures, reasoningTokens, tests | ✅ Accurate (§2). |
| §3 "modifying over 750 lines" in models.ts | ⚠️ Overstated — 588 changed lines. |
| §3 "`@cf/` support added inside the OpenCode provider" | ⚠️ Misattributed — provider file unchanged; delivered via models.ts SHORT_NAMES + existing stripping + the shared `session-message.ts` peel (§4.8, §6.2). |
| §3 "Enabled JSON imports natively via new import attributes" | ❌ False — `with { type: 'json' }` existed at the merge-base and upstream; fork only added unrelated imports (`stat`, `readConfig`, unused `homedir`). |
| §3 gemini-pro-agent redirect, Gemini pricing fixes | ✅ Verified, incl. the ~56M-token `gemini-3-flash-agent` correction (§4.5). |
| §4 "`types": ["node"]` resolves core types" | ✅ True but empirically non-differentiating today (§7.1). |
| §4 "Fixed TypeScript validation errors in copilot.ts" | ⚠️ Superseded/regressed — 2 standing TS2353 errors at HEAD (§8.1). |
| §5 "Removed unused dash/package-lock.json" | ❌ False — file exists and is tracked; only `libc` metadata stripped (§7.4). |
| §6 "CLI imports (main.ts)", short-name derivations, openRouterPricing lowercase-index fix | ✅ Verified (§4.3, §4.2, §6.1). |
| §6 "PR URL extraction updates (parser.ts)" | ❌ Misattributed — byte-identical to upstream (§5). |
| §6 "file mutation retry logic (session-cache.ts)" | ❌ Misattributed — identical upstream; fork delta whitespace (§7.2). |
| §7 "modelFromChatSessionRequest inspects autoModeResolution" | ⚠️ Function rewritten but **dead code**; live equivalent is `extractModelFromRequest` step 3 (§2.2). |
| §7 "`discoverChatSessionFiles` differentiates .json/.jsonl" | ⚠️ Wrong symbol name — no such function; work lives in `discoverWorkspaceChatSessions`/`discoverEmptyWindowChatSessions` + `isChatSessionJsonFormat` (§2.3). |
| §8 "image/video calls produce token events in gen_metadata and status lines" | ❌ Inaccurate as shipped — image tracking reads `generate_image` tool_calls from brain transcripts with heuristic estimates; nothing parses gen_metadata/status lines for media turns; **Veo/video has no parser at all** (§3.3, §3.5). |
| §8 "added Windows USERPROFILE isolation in test fixtures" (copilot scope) | ⚠️ Overstated — copilot tests use win32 skip-guards; USERPROFILE isolation is the global setup file (§7.3). |

---

## 13. Commit-history phases (55 commits)

1. **Foundations (2026-05-22 → 05-30):** `15fe8e2c` Windows Antigravity, `7cb19ab1` IDE flavor + legacy copilot start, `4d92c16b` Gemini pricing, `2290ea1d` VSCode globalStorage chats, `f1151871` gemini-pro-agent redirect, `cfd4439a` remapping; six upstream syncs.
2. **Local LLMs & namespaces (06-01 → 06-09):** `68948fa5` local LLM support, `f7dbde65` Cloudflare `@cf/`, `27c9c45c`, `4f11ba5f`; four syncs.
3. **Hardening & heavy-sync era (06-26 → 07-22):** `cf0f571f`, `50e67b17`, `093a71dc`/`1cbcea0c` antigravity syncs, mega-merge `d6299009`, repair commits `a9dfc606`/`b2638c2f`/`3b75c064`, `58ae2f46` legacy-files fix, `cc735899` parser rewrite, `ded92e4a`, `3b12a6d6`; twelve syncs.
4. **Auto-mode mapping (08-03 → 08-05):** `508da597` models conflict fix, `47850cd7` auto-mode credit mapping; four syncs.
5. **Multimodal era (08-13 → 08-24):** `e3210cc9` multimodal tracking + legacy parse fix, `96bca969` generate_image/Nano Banana + transcript fallback, `fc923168` final attribution overhaul; HEAD `af9ba833`.
