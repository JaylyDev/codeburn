# Phase 0 fan-out recipe: lift `calculateCost` out of decoders

> **Path note (Phase 1):** The CLI source has moved into the `packages/cli`
> workspace. Every `src/...` and `tests/...` path in this document now lives
> under `packages/cli/` (e.g. `src/pricing-pass.ts` → `packages/cli/src/pricing-pass.ts`,
> `tests/providers/<name>.test.ts` → `packages/cli/tests/providers/<name>.test.ts`).
> Relative import paths inside `packages/cli/src` (such as `../../src/pricing-pass.js`)
> are unaffected because the source tree moved as a whole.

Phase 0 of the `@codeburn/core` extraction (issue #809) moves cost computation
out of the provider decoders and into a single host-side pricing pass
(`src/pricing-pass.ts`). Decoders emit **token counts + a `costBasis` marker**;
`priceProviderCall` fills in `costUSD` afterwards, byte-identical to today.

The exemplar PR converted three providers (`zerostack`, `qwen`, `quickdesk`) and
built the seam. This document is the mechanical recipe for the remaining
providers. **Follow it per-provider; each provider is one small PR.**

---

## The seam (already in place — do not re-add)

- `ParsedProviderCall` gained two optional fields (`src/providers/types.ts`):
  - `costUSD?: number` — now optional. Converted decoders omit it.
  - `costBasis?: 'measured' | 'estimated'`.
- `priceProviderCall` runs in `src/parser.ts` right before
  `canonicalizeProviderCallProject`, on every parsed call. It is a no-op for
  calls with no `costBasis` (unconverted providers), so converted and
  unconverted providers coexist. **You never edit `parser.ts` or `pricing-pass.ts`.**

`priceProviderCall` behaviour:

| `costBasis`   | what the pass does                                              |
|---------------|----------------------------------------------------------------|
| `'estimated'` | computes `costUSD = calculateCost(model, input, output+reasoning, cacheCreation, cacheRead, webSearch, speed)` from the call's stored buckets |
| `'measured'`  | leaves `costUSD` (which the decoder set to a provider-reported dollar figure) untouched |
| absent        | leaves the call exactly as-is (unconverted)                    |

> **`costBasis` is orthogonal to `costIsEstimated`.** `costIsEstimated` is a
> display flag meaning "the *tokens* are estimated" (e.g. char-count derived);
> it is **preserved verbatim** and never derived from `costBasis`. A call can be
> `costBasis: 'estimated'` with `costIsEstimated: false` (real tokens, priced
> from the table — this is how `copilot` marks metered-token calls).

---

## Why the estimated path is safe (the confidence lever)

For every **non-whitelisted** provider, the cache-read path
(`cachedCallToApiCall` in `parser.ts`) **already** recomputes `costUSD` with the
exact generic formula the pass uses:

```
outputForCost = provider === 'claude' ? outputTokens : outputTokens + reasoningTokens
calculateCost(model, inputTokens, outputForCost, cacheCreationInputTokens,
              cacheReadInputTokens, webSearchRequests, speed, cacheCreationOneHourTokens)
```

So a non-whitelisted provider's report cost is *already* produced by this
formula on a warm cache. Converting it to `costBasis: 'estimated'` cannot change
report output — it just moves the identical computation earlier. **The green
suite is your proof.**

The "whitelist" is the provider list inside `providerCallToCachedCall`
(`parser.ts`, ~line 2380) whose `costUSD` **is** persisted to the cache:

```
mistral-vibe, antigravity, devin, vercel-gateway, hermes, kiro, codewhale, quickdesk
```

For a whitelisted provider the stored decoder cost is authoritative (not
recomputed), so its exact number must be preserved — see Pattern B and the
misfit list. **Do not change the whitelist.**

---

## Before you start (per provider)

```
grep -n "calculateCost\|calculateLocalModelSavings" src/providers/<name>.ts
```

Classify **each** call site:

- **Pattern A** — pure token estimate: `calculateCost(model, <buckets>, ...)`
  with no provider-reported dollar fallback.
- **Pattern B** — passthrough with fallback: `recorded ?? calculateCost(...)` or
  `credits > 0 ? credits*rate : calculateCost(...)` (i.e. a real dollar/credit
  figure when present, token estimate otherwise).
- **Misfit** — see the flag list. Stop and hand to Opus-tier; do not force it.

Then check whether the provider's test asserts cost on raw `parse()` output:

```
grep -n "costUSD\|costIsEstimated" tests/providers/<name>.test.ts   # (or wherever it lives)
```

If yes, you will route that test's collect helper through `priceProviderCall`
(see "Test wiring" below).

---

## Pattern A — pure token estimate

**Steps**

1. Replace `costUSD: calculateCost(...)` (or `const costUSD = calculateCost(...)`
   + `costUSD,`) with `costBasis: 'estimated',`.
2. Delete any now-unused local (`const costUSD = ...`).
3. Prune the import: drop `calculateCost` from the `../models.js` import; keep
   other symbols (e.g. `getShortModelName`).
4. **Verify the buckets match.** The generic formula uses
   `outputTokens + reasoningTokens`, `cacheCreationInputTokens`,
   `cacheReadInputTokens`, `webSearchRequests`, `speed`. Confirm the decoder
   stores into exactly those fields whatever it passed to `calculateCost`. This
   holds automatically for non-whitelisted providers (see confidence lever), but
   eyeball it.

**Worked diff — `zerostack` (trivial, all extra buckets zero):**

```diff
-import { calculateCost, getShortModelName } from '../models.js'
+import { getShortModelName } from '../models.js'
@@
         webSearchRequests: 0,
-        costUSD: calculateCost(model, input, output, 0, 0, 0),
+        costBasis: 'estimated',
```

**Worked diff — `qwen` (reasoning billed at output rate + cache-read):**

```diff
-import { calculateCost } from '../models.js'
@@
         const cachedTokens = usage.cachedContentTokenCount ?? 0
-
-        const costUSD = calculateCost(model, inputTokens, outputTokens + reasoningTokens, 0, cachedTokens, 0)
@@
           reasoningTokens,
           webSearchRequests: 0,
-          costUSD,
+          costBasis: 'estimated',
```

`qwen` stores `reasoningTokens` and `cacheReadInputTokens: cachedTokens`, so the
generic formula reproduces `calculateCost(model, in, out+reasoning, 0, cached, 0)`
exactly.

**Acceptance:** grep the file clean of `calculateCost`; `npx tsc --noEmit`;
run the provider's own tests **and** any golden/report test that touches it.

---

## Pattern B — passthrough with fallback

A real dollar/credit figure when the provider reports one, else a token
estimate. Convert per branch:

- **Measured branch** → set `costUSD: <recordedCost>` **and**
  `costBasis: 'measured' as const`.
- **Fallback branch** → `costBasis: 'estimated' as const` (omit `costUSD`).
- Preserve `costIsEstimated` exactly as before.

Use a conditional spread so the two shapes stay in one `yield`:

**Worked diff — `quickdesk` metrics parser:**

```diff
-import { calculateCost } from '../models.js'
@@
         yield {
           ...commonCallFields(source, basePath),
           model,
           inputTokens,
           outputTokens,
-          costUSD: recordedCost ?? calculateCost(model, inputTokens, outputTokens, 0, 0, 0),
+          ...(recordedCost !== undefined
+            ? { costUSD: recordedCost, costBasis: 'measured' as const }
+            : { costBasis: 'estimated' as const }),
           costIsEstimated,
```

Its second (database) parser is pure Pattern A:

```diff
-          costUSD: calculateCost(model, inputTokens, outputTokens, 0, 0, 0),
+          costBasis: 'estimated',
           costIsEstimated: true,
```

**Whitelisted vs not:** the conversion is identical either way. If the provider
is whitelisted, its measured `costUSD` is persisted and used verbatim (correct).
If not, the measured `costUSD` was already discarded at cache-write and the
report already used the generic recompute — the conversion preserves that. Either
way, leave the whitelist alone.

**Credit-based measured branches** (`codebuff`, `kiro`) are Pattern B: the
`credits * RATE` value is the measured figure — carry it as
`costUSD: creditsCost, costBasis: 'measured'`; the `calculateCost` fallback
becomes `costBasis: 'estimated'`.

---

## Test wiring

Only needed when a provider's own test asserts `costUSD`/`costIsEstimated` on the
raw `parse()` output (unit-level). Route the collect helper through the pass:

```diff
+import { priceProviderCall } from '../../src/pricing-pass.js'
@@
-    for await (const call of provider.createSessionParser(source, seen).parse()) calls.push(call)
+    for await (const call of provider.createSessionParser(source, seen).parse()) calls.push(priceProviderCall(call))
```

All assertions then pass unchanged (the pass reproduces the exact numbers).
Golden/report tests need **no** change — they run through `parser.ts`, which
already applies the pass. Providers with no cost assertion on raw output (e.g.
`qwen`) need no test edit at all.

---

## Per-provider acceptance checklist

1. `grep -n "calculateCost\|calculateLocalModelSavings" src/providers/<name>.ts` → **empty**.
2. `npx tsc --noEmit` → clean.
3. `npx vitest run` for the provider's test + any golden/report suite that names it → green, unchanged assertions.
4. No edit to `parser.ts`, `pricing-pass.ts`, `session-cache.ts`, or the whitelist.
5. No `PROVIDER_PARSE_VERSIONS` change anywhere (grep the diff).
6. `git checkout -- src/data/*.json` before committing (build refreshes the pricing snapshot).

---

## Straightforward fan-out targets

Pattern A / B, non-whitelisted unless noted — safe for the cheap fan-out:

`goose, mux, open-design, lingtai-tui, droid, cursor-agent, zcode, pi, forge,
grok, warp, kimicode, cursor, zed, crush, openclaw, vscode-cline-parser,
session-message, sqlite-session-parser, codebuff, kimi, hermes (whitelisted, B),
kiro (whitelisted, B, credits), codewhale (whitelisted, B), quickdesk (done),
zerostack (done), qwen (done)`

For each whitelisted one, confirm the estimated-branch `calculateCost` args map
to the stored buckets **with the same model** before trusting Pattern A/B.

---

## Misfits — hand to Opus-tier, do NOT mechanically convert

These break the "generic formula on stored buckets reproduces the cost"
assumption. They need a seam extension (e.g. an optional `pricingModel` field or
a session-cost carrier), so they are out of scope for the cheap fan-out:

- **`antigravity`** — prices with a `pricingModel` that differs from the stored
  `model` (3 sites). The pass uses `call.model`, so `'estimated'` would reprice
  with the wrong model, and `'measured'` still needs a `calculateCost` on the
  pricing model inside the decoder. Whitelisted, so the wrong number would ship.
- **`mistral-vibe`** — computes one session-level cost and **allocates** it
  across messages (`allocateCost(costUSD, assistantMessages.length)`). Per-call
  buckets do not map to per-call cost, so the generic formula cannot reproduce
  it. Whitelisted.
- **`copilot`** — not a hard misfit, but higher-effort: multiple emit sites
  (input-only, output-only, full), `durableSources`, and deliberate
  `costIsEstimated: false` on token-priced calls. Each site is Pattern A, but
  verify every site's buckets and preserve each `costIsEstimated` literal
  exactly. Review individually rather than batch.
- **`gemini`** — Pattern A **if** it stores `reasoningTokens = thoughts` and
  `cacheReadInputTokens = cached` (it does today; non-whitelisted, so the
  cache-read path already proves it). Convert, but double-check the buckets.

## Out of scope for this recipe: the `parser.ts` Claude sites

The three `calculateCost` sites in `src/parser.ts` (+ `applyLocalModelSavings`)
belong to the **native Claude decoder**, which produces `ParsedApiCall` (not
`ParsedProviderCall`) and does not flow through `priceProviderCall`. Lifting
those requires a parallel seam on the Claude/`ParsedApiCall` path and is
Phase 3 (Claude decoder carve-out) work — **do not** attempt it as part of the
provider fan-out.
