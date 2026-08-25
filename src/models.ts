import { readFile, writeFile, mkdir, stat } from 'fs/promises'
import { join } from 'path'
import { createHash } from 'crypto'

import { getCodeburnCacheDir } from './cache-dir.js'
import snapshotData from './data/litellm-snapshot.json' with { type: 'json' }
import fallbackData from './data/pricing-fallback.json' with { type: 'json' }
import { fetchWithTimeout } from './fetch-utils.js'
import { readConfig } from './config.js'

export type ModelCosts = {
  inputCostPerToken: number
  outputCostPerToken: number
  cacheWriteCostPerToken: number
  cacheReadCostPerToken: number
  webSearchCostPerRequest: number
  fastMultiplier: number
  /// True only when the pricing source carried a real cache-write rate. When
  /// absent/false, `cacheWriteCostPerToken` is the fabricated `1.25 x input`
  /// default, which is right for Anthropic-style pricing but would invent a
  /// surcharge on providers that charge nothing extra to write cache. Callers
  /// that decide WHICH bucket to put tokens in (rather than what to multiply
  /// them by) must consult this before routing tokens to the cache-write
  /// bucket. Optional so an incomplete literal defaults to the safe answer.
  cacheWriteCostIsExplicit?: boolean
}

/// Providers whose reported `reasoningTokens` are a SUBSET of `outputTokens`
/// rather than a separate bucket to add on top. OpenAI bills reasoning as part
/// of output (every codex `token_count` event satisfies input + output ==
/// total), and Anthropic folds thinking into output the same way, so summing
/// the two double-counts both the cost and the displayed output tokens. Copilot
/// is the same case: its per-request token_details_json prices input/cache/output
/// and nothing else, and its supplementary store-row/shutdown calls carry
/// reasoningTokens with outputTokens 0 while the per-turn assistant.message call
/// bills the full output, so adding reasoning on top bills it twice.
const REASONING_INCLUDED_IN_OUTPUT = new Set(['claude', 'codex', 'copilot'])

/// Output tokens to bill and display for one call. Single source of truth so
/// the pricing sites and the display sums can never disagree about whether a
/// provider's reasoning tokens are already inside its output count (#1075).
export function billableOutputTokens(provider: string, outputTokens: number, reasoningTokens: number): number {
  return REASONING_INCLUDED_IN_OUTPUT.has(provider) ? outputTokens : outputTokens + reasoningTokens
}

type PriceOverrideRates = {
  input: number
  output: number
  cacheRead?: number
  cacheCreation?: number
}

export type LiteLLMEntry = {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_creation_input_token_cost?: number;
  cache_read_input_token_cost?: number;
  provider_specific_entry?: { fast?: number };
};

// [input, output, cacheWrite, cacheRead, fastMultiplier]. The trailing fast
// multiplier is carried straight from LiteLLM's provider_specific_entry.fast so
// new models pick it up automatically — no hand-maintained per-model table.
type SnapshotEntry = [
  number,
  number,
  number | null,
  number | null,
  (number | null)?,
];

const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/models'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
// Bump whenever a ModelCosts field changes pricing behavior (cacheWriteCostIsExplicit,
// added in #1075/#1078). A cache written under an older/missing version is treated as a
// miss instead of read verbatim, so a stale on-disk file can't reintroduce a killed bug
// for up to CACHE_TTL_MS after an upgrade.
// Also folded into getPricingGenerationKey() below: a resident/snapshot-caching
// consumer needs the same "pricing behavior changed" signal this already gives
// the on-disk LiteLLM cache, not just the on-disk cache itself.
export const CACHE_SCHEMA_VERSION = 2
const WEB_SEARCH_COST = 0.01
const ONE_HOUR_CACHE_WRITE_MULTIPLIER_FROM_FIVE_MINUTE_RATE = 1.6

let openRouterPricing: Map<string, ModelCosts> = new Map()

function getOpenRouterCachePath(): string {
  return join(getCodeburnCacheDir(), 'openrouter-snapshot.json')
}

export type OpenRouterModel = {
  id: string
  pricing: {
    prompt: string
    completion: string
  }
}

function parseOpenRouterPricing(
  data: OpenRouterModel[],
): Map<string, ModelCosts> {
  const pricing = new Map<string, ModelCosts>()
  for (const m of data || []) {
    const input = parseFloat(m.pricing?.prompt ?? '0')
    const output = parseFloat(m.pricing?.completion ?? '0')
    if (Number.isFinite(input) && Number.isFinite(output) && input >= 0 && output >= 0) {
      const entry: ModelCosts = {
        inputCostPerToken: input,
        outputCostPerToken: output,
        cacheWriteCostPerToken: input * 1.25,
        cacheReadCostPerToken: input * 0.1,
        webSearchCostPerRequest: WEB_SEARCH_COST,
        fastMultiplier: 1,
      }
      pricing.set(m.id, entry)
      const stripped = m.id.replace(/^[^/]+\//, '')
      if (stripped !== m.id && !pricing.has(stripped)) {
        pricing.set(stripped, entry)
      }
    }
  }
  return pricing
}

async function fetchAndCacheOpenRouterPricing(): Promise<
  Map<string, ModelCosts>
> {
  const response = await fetchWithTimeout(OPENROUTER_URL)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const rawText = await response.text()
  const json = JSON.parse(rawText) as { data: OpenRouterModel[] }
  const pricing = parseOpenRouterPricing(json.data)

  await mkdir(getCodeburnCacheDir(), { recursive: true })
  await writeFile(getOpenRouterCachePath(), rawText, 'utf-8')

  return pricing
}

async function loadCachedOpenRouterPricing(): Promise<Map<
  string,
  ModelCosts
> | null> {
  try {
    const path = getOpenRouterCachePath()
    const stats = await stat(path)
    if (Date.now() - stats.mtimeMs > CACHE_TTL_MS) return null
    const raw = await readFile(path, 'utf-8')
    const json = JSON.parse(raw) as { data: OpenRouterModel[] }
    return parseOpenRouterPricing(json.data)
  } catch {
    return null
  }
}

// Explicit USD/token prices that must override LiteLLM/cache data. Cursor
// publishes house-model rates in the models table at cursor.com/docs/models
// (provider "Cursor", USD per 1M tokens): composer-2/2.5: $0.50 input, $2.50
// output, $0.20 cache read; composer-1.5: $3.50/$17.50/$0.35; composer-1:
// $1.25/$10/$0.125. Cursor publishes no separate cache-write rate for these,
// so cache write uses the input rate.
const BUILTIN_PRICE_OVERRIDES: Record<string, SnapshotEntry> = {
  'composer-2.5': [0.5e-6, 2.5e-6, 0.5e-6, 0.2e-6],
  'composer-2': [0.5e-6, 2.5e-6, 0.5e-6, 0.2e-6],
  'composer-1.5': [3.5e-6, 17.5e-6, 3.5e-6, 0.35e-6],
  'composer-1': [1.25e-6, 10e-6, 1.25e-6, 0.125e-6],
}

// Assemble a ModelCosts, applying the cache-cost heuristics (write = 1.25x
// input, read = 0.1x input) when a source omits them. Shared by the bundled
// tuple path (tupleToCosts) and the live LiteLLM path (parseLiteLLMEntry) so the
// multipliers live in exactly one place.
function buildCosts(
  input: number,
  output: number,
  cacheWrite: number | null | undefined,
  cacheRead: number | null | undefined,
  fast: number | null | undefined,
): ModelCosts {
  const safeInput = Math.max(0, input);
  const safeOutput = Math.max(0, output);
  return {
    inputCostPerToken: safeInput,
    outputCostPerToken: safeOutput,
    cacheWriteCostPerToken: cacheWrite !== null && cacheWrite !== undefined ? Math.max(0, cacheWrite) : safeInput * 1.25,
    cacheReadCostPerToken: cacheRead !== null && cacheRead !== undefined ? Math.max(0, cacheRead) : safeInput * 0.1,
    webSearchCostPerRequest: WEB_SEARCH_COST,
    fastMultiplier: fast ?? 1,
    cacheWriteCostIsExplicit: cacheWrite !== null && cacheWrite !== undefined,
  }
}

function tupleToCosts(raw: SnapshotEntry): ModelCosts {
  const [input, output, cacheWrite, cacheRead, fast] = raw
  return buildCosts(input, output, cacheWrite, cacheRead, fast)
}

function applyBuiltinPriceOverrides(pricing: Map<string, ModelCosts>): Map<string, ModelCosts> {
  for (const [name, raw] of Object.entries(BUILTIN_PRICE_OVERRIDES)) {
    pricing.set(name, tupleToCosts(raw))
  }
  return pricing
}

function loadSnapshot(): Map<string, ModelCosts> {
  const map = new Map<string, ModelCosts>()
  for (const [name, raw] of Object.entries(snapshotData as unknown as Record<string, SnapshotEntry>)) {
    map.set(name, tupleToCosts(raw))
  }
  return map;
}

// Gap-fill pricing from models.dev / OpenRouter, keyed lowercase. Consulted ONLY
// as the last-resort fallback in getModelCosts (never for exact/canonical/prefix
// matches), so a reseller variant name can't shadow a real canonical entry.
const fallbackCosts: Map<string, ModelCosts> = (() => {
  const map = new Map<string, ModelCosts>()
  for (const [name, raw] of Object.entries(fallbackData as unknown as Record<string, SnapshotEntry>)) {
    const lk = name.toLowerCase()
    if (!map.has(lk)) map.set(lk, tupleToCosts(raw))
  }
  return map
})()

let pricingCache: Map<string, ModelCosts> = applyBuiltinPriceOverrides(loadSnapshot())
let sortedPricingKeys: string[] | null = null
let lowercasePricingIndex: Map<string, ModelCosts> | null = null

function getSortedPricingKeys(): string[] {
  if (sortedPricingKeys === null) {
    sortedPricingKeys = Array.from(pricingCache.keys()).sort(
      (a, b) => b.length - a.length,
    );
  }
  return sortedPricingKeys;
}

// Case-insensitive index, built lazily. Lets a session model like `MiniMax-M3`
// resolve to a gap-filled OpenRouter key like `minimax-m3` (lowercase slug).
// First key wins on a lowercase collision so it stays deterministic.
//
// Zero-priced entries are excluded: LiteLLM ships `[0,0]` stubs (e.g.
// `GigaChat-2-Max`) for models it lists but has no price for. Indexing those
// would let a case-mismatched query (`gigachat-2-max`) resolve to a silent $0
// instead of returning null, which suppresses the unknown-model warning and
// hides real spend. A case-EXACT query still finds the stub via the normal
// pipeline; only the fuzzy case-insensitive path skips them.
function getLowercasePricingIndex(): Map<string, ModelCosts> {
  if (lowercasePricingIndex === null) {
    lowercasePricingIndex = new Map()
    const priced = (c: ModelCosts) => c.inputCostPerToken > 0 || c.outputCostPerToken > 0
    // The live pricing data wins on any lowercase collision; the gap-fill only
    // fills names that resolve to nothing through the normal pipeline.
    for (const [key, costs] of pricingCache) {
      const lk = key.toLowerCase()
      if (priced(costs) && !lowercasePricingIndex.has(lk)) lowercasePricingIndex.set(lk, costs)
    }
    for (const [key, costs] of openRouterPricing) {
      const lk = key.toLowerCase()
      if (priced(costs) && !lowercasePricingIndex.has(lk)) lowercasePricingIndex.set(lk, costs)
    }
    for (const [lk, costs] of fallbackCosts) {
      if (priced(costs) && !lowercasePricingIndex.has(lk)) lowercasePricingIndex.set(lk, costs)
    }
  }
  return lowercasePricingIndex
}

function getCachePath(): string {
  return join(getCodeburnCacheDir(), 'litellm-pricing.json')
}

/// Clamp a per-token rate to a sane non-negative value. Defense in depth
/// against a tampered LiteLLM JSON shipping a negative `input_cost_per_token`,
/// which would otherwise produce negative costs that subtract from totals.
/// We use Number.isFinite to also reject NaN/Infinity, and cap at $1/token
/// (well above the most expensive frontier model) so a stray decimal-place
function safePerTokenRate(n: number | undefined): number | null {
  if (n === undefined || !Number.isFinite(n) || n < 0) return null;
  if (n > 1) return 1;
  return n;
}

export function parseLiteLLMEntry(entry: LiteLLMEntry): ModelCosts | null {
  // The live LiteLLM map is remote JSON; a null (or non-object) value for a
  // model would make the field reads below throw and abort the whole pricing
  // load. Treat it as unparseable, like any other bad entry.
  if (!entry || typeof entry !== 'object') return null
  const inputCost = safePerTokenRate(entry.input_cost_per_token)
  const outputCost = safePerTokenRate(entry.output_cost_per_token)
  if (inputCost === null || outputCost === null) return null
  return buildCosts(
    inputCost,
    outputCost,
    safePerTokenRate(entry.cache_creation_input_token_cost),
    safePerTokenRate(entry.cache_read_input_token_cost),
    entry.provider_specific_entry?.fast,
  )
}

// Timestamp of whichever live LiteLLM data (freshly fetched or read back from
// the on-disk cache) is currently loaded into pricingCache; null when nothing
// live is loaded and pricing is purely the bundled snapshot (offline/first
// run, CODEBURN_PRICING_SNAPSHOT_ONLY, or a failed fetch with no cache hit).
// Read by getPricingGenerationKey() so a consumer that persists rendered
// costs across process invocations (the menubar's status snapshot) can tell
// "the live pricing data actually changed" apart from "nothing changed" —
// this module has no other way to signal that across a fresh CLI process.
let livePricingTimestamp: number | null = null

async function fetchAndCachePricing(): Promise<Map<string, ModelCosts>> {
  // Bounded: runs on every CLI invocation (the menubar shells out and blocks on
  // it). Without a timeout a half-open network after wake-from-sleep makes
  // fetch() hang forever, wedging the menubar's loading spinner. On timeout the
  // caller's catch falls back to the bundled price snapshot.
  const response = await fetchWithTimeout(LITELLM_URL);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = (await response.json()) as Record<string, LiteLLMEntry>;
  const pricing = new Map<string, ModelCosts>();

  for (const [name, entry] of Object.entries(data)) {
    const costs = parseLiteLLMEntry(entry);
    if (!costs) continue;
    pricing.set(name, costs);
    // Also index by stripped name so lookups work without provider prefix:
    // 'anthropic/claude-opus-4-6' is also queryable as 'claude-opus-4-6'.
    // First write wins so direct-provider entries take precedence over re-hosters.
    const stripped = name.replace(/^[^/]+\//, "");
    if (stripped !== name && !pricing.has(stripped))
      pricing.set(stripped, costs);
  }

  const timestamp = Date.now()
  await mkdir(getCodeburnCacheDir(), { recursive: true })
  await writeFile(getCachePath(), JSON.stringify({
    version: CACHE_SCHEMA_VERSION,
    timestamp,
    data: Object.fromEntries(pricing),
  }))
  livePricingTimestamp = timestamp

  return pricing;
}

async function loadCachedPricing(): Promise<Map<string, ModelCosts> | null> {
  try {
    const raw = await readFile(getCachePath(), 'utf-8')
    const cached = JSON.parse(raw) as { version?: number; timestamp: number; data: Record<string, ModelCosts> }
    if (cached.version !== CACHE_SCHEMA_VERSION) return null
    if (Date.now() - cached.timestamp > CACHE_TTL_MS) return null
    livePricingTimestamp = cached.timestamp
    return new Map(Object.entries(cached.data))
  } catch {
    return null;
  }
}

function mergeSnapshotFallbacks(
  pricing: Map<string, ModelCosts>,
): Map<string, ModelCosts> {
  for (const [name, costs] of loadSnapshot()) {
    if (!pricing.has(name)) pricing.set(name, costs);
  }
  return pricing;
}

async function applyLocalModelPricing(
  pricing: Map<string, ModelCosts>,
): Promise<Map<string, ModelCosts>> {
  const config = await readConfig();
  if (config.localModelPricing) {
    for (const model of Object.keys(config.localModelPricing)) {
      const entry: LiteLLMEntry = config.localModelPricing[model]!;
      const costs = parseLiteLLMEntry(entry);
      if (costs) pricing.set(model, costs);
    }
  }
  return applyBuiltinPriceOverrides(pricing)
}

function setPricingCache(pricing: Map<string, ModelCosts>): void {
  pricingCache = pricing
  sortedPricingKeys = null
  lowercasePricingIndex = null
  knownNamespaces = null
}

export async function loadPricing(): Promise<void> {
  const cached = await loadCachedPricing()
  if (cached) {
    setPricingCache(mergeSnapshotFallbacks(cached))
  } else if (!process.env['CODEBURN_PRICING_SNAPSHOT_ONLY']) {
    // Test-only escape hatch honored above; skip the live LiteLLM fetch and
    // price purely off the bundled snapshot so an upstream reprice can't turn
    // tests red.
    try {
      setPricingCache(mergeSnapshotFallbacks(await fetchAndCachePricing()))
    } catch {
      // snapshot already loaded at init; nothing more to do
      livePricingTimestamp = null
    }
  } else {
    livePricingTimestamp = null
    setPricingCache(mergeSnapshotFallbacks(new Map()))
  }

  const cachedOR = await loadCachedOpenRouterPricing()
  if (cachedOR) {
    openRouterPricing = cachedOR
  } else {
    try {
      openRouterPricing = await fetchAndCacheOpenRouterPricing()
    } catch {
      // ignore
    }
  }

  await applyLocalModelPricing(pricingCache)
  sortedPricingKeys = null
  lowercasePricingIndex = null
}

// Content digest of the two bundled pricing files, computed once and memoized
// (they're static imports; nothing in-process can change them). Changes only
// when `scripts/bundle-litellm.mjs` regenerates litellm-snapshot.json /
// pricing-fallback.json and that regeneration ships in a new codeburn build —
// exactly the "bundled data" staleness class getPricingGenerationKey exists
// to catch, distinct from the live cache's own timestamp.
let bundledPricingDigest: string | null = null
function getBundledPricingDigest(): string {
  if (bundledPricingDigest === null) {
    bundledPricingDigest = createHash('sha256')
      .update(JSON.stringify(snapshotData))
      .update(JSON.stringify(fallbackData))
      .digest('hex')
  }
  return bundledPricingDigest
}

/// Stable signature of everything that can silently change a session's
/// RENDERED cost with no session file ever changing: the live LiteLLM cache's
/// freshness (a repricing fetch, or its absence), the bundled snapshot's own
/// content (a repriced model shipped in a new build), and this module's
/// pricing-behavior version (CACHE_SCHEMA_VERSION). A caller that persists a
/// fully-rendered payload across process invocations (the menubar's status
/// snapshot) must fold this into its own cache key the same way it already
/// folds the four *ConfigHash getters above — those cover user-editable
/// pricing CONFIG, this covers upstream/bundled pricing DATA and code version,
/// a different staleness gap with no other invalidation path of its own.
export function getPricingGenerationKey(): string {
  return `${CACHE_SCHEMA_VERSION}:${livePricingTimestamp ?? 'bundled'}:${getBundledPricingDigest()}`
}

// Known model name variants that providers emit but LiteLLM/fallback don't index under.
// OMP emits 'anthropic--claude-4.6-opus' (double-dash, dot version, tier-last).
// getCanonicalName strips a KNOWN vendor/router prefix first unless the
// full cleaned id itself is an alias (orcarouter/fusion). Post-strip forms
// still cover every other entry here.
const BUILTIN_ALIASES: Record<string, string> = {
  'anthropic--claude-4.6-opus':    'claude-opus-4-6',
  'anthropic--claude-4.6-sonnet':  'claude-sonnet-4-6',
  'anthropic--claude-4.5-opus':    'claude-opus-4-5',
  'anthropic--claude-4.5-sonnet':  'claude-sonnet-4-5',
  'anthropic--claude-4.5-haiku':   'claude-haiku-4-5',
  // #1093: copilot session-store.db writes 'claude-haiku-4.5' (tier-first, dot)
  'claude-haiku-4.5':             'claude-haiku-4-5',
  'claude-sonnet-4.6':             'claude-sonnet-4-6',
  'claude-sonnet-4.5':             'claude-sonnet-4-5',
  'claude-opus-4.7':               'claude-opus-4-7',
  'claude-opus-4.6':               'claude-opus-4-6',
  'claude-opus-4.5':               'claude-opus-4-5',
  // Antigravity tags reasoning-mode sessions onto the dot-version spelling;
  // the SKU priced is the base model regardless of reasoning mode. The
  // dash-spelled forms below are the wire ids Antigravity's own
  // activeModelSpecs binds for those slots (claude-sonnet-4-6 → M35,
  // claude-opus-4-6-thinking → M26; Antigravity Context Window Monitor
  // models.ts@603e3ea); the opus form was observed verbatim in real
  // gen_metadata #19 payloads.
  'claude-sonnet-4.6-thinking':    'claude-sonnet-4-6',
  'claude-opus-4.6-thinking':      'claude-opus-4-6',
  'claude-sonnet-4-6-thinking':    'claude-sonnet-4-6',
  'claude-opus-4-6-thinking':      'claude-opus-4-6',
  'cursor-auto':                   'claude-sonnet-4-5',
  'cursor-agent-auto':             'claude-sonnet-4-5',
  'copilot-auto':                  'claude-sonnet-4-5',
  'copilot-openai-auto':           'gpt-5.3-codex',
  'copilot-anthropic-auto':        'claude-sonnet-4-5',
  // GitHub Copilot capacity pods wrap the upstream dated snapshot id in a
  // capi-<site>-ptuc-<hw>-ib- envelope (observed: noe/h200, cus/h100).
  // Exact-string aliases only — a generalized peel regex could swallow
  // unrelated capi-* ids, so new pods must be added as they are observed.
  'capi-noe-ptuc-h200-ib-gpt-5-mini-2025-08-07': 'gpt-5-mini-2025-08-07',
  'capi-cus-ptuc-h100-ib-gpt-5-mini-2025-08-07': 'gpt-5-mini-2025-08-07',
  'openai-codex:gpt-5.5':          'gpt-5.5',
  'ibm-bob-auto':                  'claude-sonnet-4-5',
  'kiro-auto':                     'claude-sonnet-4-5',
  'quickdesk-auto':                'claude-sonnet-4-5',
  'cline-auto':                    'claude-sonnet-4-5',
  'openclaw-auto':                 'claude-sonnet-4-5',
  'warp-auto-efficient':           'gpt-5.3-codex',
  'warp-auto-powerful':            'claude-opus-4-6',
  // Codex activity ids are product surfaces, not subscription SKUs and not
  // LiteLLM rows. OpenAI's tracker (openai/codex#32224) says auto review
  // consumes normal model usage. Public evidence: review_model defaults to
  // the session model; GPT-5.5 is the currently recommended review model.
  // Price as that existing bundled row. Do not invent a rate. Do not treat
  // the id as honestly $0 — it draws from the same credit pool. Display
  // stays on autoModelNames (same class as cursor-auto / copilot-openai-auto).
  // Only alias ids observed in Codex source / real rollouts. Do not infer
  // `codex-code-review` from the activity name "code review".
  'codex-auto-review':             'gpt-5.5',
  'grok-build':                    'grok-build-0.1',
  'GPT-5.3 Codex (low reasoning)': 'gpt-5.3-codex',
  'GPT-5.3 Codex (medium reasoning)': 'gpt-5.3-codex',
  'GPT-5.3 Codex (high reasoning)': 'gpt-5.3-codex',
  'GPT-5.3 Codex (extra high reasoning)': 'gpt-5.3-codex',
  'Claude Sonnet 4.6':             'claude-sonnet-4-6',
  'Claude Sonnet 4.5':             'claude-sonnet-4-5',
  'Claude Haiku 4.5':              'claude-haiku-4-5',
  'Claude Opus 4.6':               'claude-opus-4-6',
  'claude-4-6-sonnet-high':        'claude-sonnet-4-6',
  'claude-4-6-sonnet-low':         'claude-sonnet-4-6',
  'claude-4-6-sonnet-medium':      'claude-sonnet-4-6',
  'claude-4-6-sonnet-high-fast':   'claude-sonnet-4-6',
  'claude-4-7-opus-xhigh':         'claude-opus-4-7',
  'claude-4-7-opus-xhigh-fast':    'claude-opus-4-7',
  'qwen-auto':                     'claude-sonnet-4-5',
  // OrcaRouter fusion routes. Provenance: live OrcaRouter completion `model`
  // field, 2026-08 (community #1058 / house #1118). Re-verify if the gateway
  // rotates targets. `orcarouter/auto` is intentionally unaliased: the smart
  // route currently lands on a Qwen/Llama flash model, so a Sonnet alias
  // would overprice ~3–30×. Fail closed until a live probe pins that target.
  'orcarouter/fusion':             'openai/gpt-oss-120b',
  'orcarouter/fusion-flash':       'openai/gpt-oss-120b',
  'orcarouter/fusion-mini':        'openai/gpt-oss-120b',
  'kimi-auto':                     'kimi-k2-thinking',
  'kimi-code':                     'kimi-k2-thinking',
  'kimi-for-coding':               'kimi-k2-thinking',
  // Kimi Code wires report the bare `k3` id in llm.request.model; without an
  // alias those calls priced at $0 and the provider looked absent in the UI.
  'k3':                            'kimi-k3',
  // Kimi desktop/IDE embedded runtime serves `k3-agent` / `k2d6-agent`.
  'k3-agent':                      'kimi-k3',
  'k2d6-agent':                    'kimi-k2p6',
  'mimo-v2-flash':                 'xiaomi/mimo-v2-flash',
  // Hermes / Xiaomi token-plan sessions store the bare id. LiteLLM's row is
  // namespaced. Same class as mimo-v2-flash above — do not invent a rate.
  'mimo-v2.5-pro':                 'xiaomi/mimo-v2.5-pro',
  'mimo-v2.5':                     'xiaomi/mimo-v2.5',
  'kat-coder-pro-v1':              'kwaipilot/kat-coder-pro',
  // Cursor emits dot-version tier-last names plus tier/reasoning suffixes
  // that LiteLLM does not index (`-high`, `-low`, `-medium`, `-thinking`,
  // `-high-thinking`, `-fast-mode`). Missing aliases here surface as $0 in
  // the dashboard for users on non-Auto models (issue #159). Sources: the
  // display map at `src/providers/cursor.ts:modelDisplayNames`, Cursor's
  // public model docs at https://cursor.com/docs/models, and forum bug
  // reports that quote literal slugs (e.g. forum.cursor.com/t/154933).
  'claude-4-sonnet':                'claude-sonnet-4',
  'claude-4-sonnet-1m':             'claude-sonnet-4',
  'claude-4-sonnet-thinking':       'claude-sonnet-4',
  'claude-4.5-sonnet':              'claude-sonnet-4-5',
  'claude-4.5-sonnet-thinking':     'claude-sonnet-4-5',
  'claude-4.6-sonnet':              'claude-sonnet-4-6',
  'claude-4.6-sonnet-high':         'claude-sonnet-4-6',
  'claude-4.6-sonnet-low':          'claude-sonnet-4-6',
  'claude-4.6-sonnet-thinking':     'claude-sonnet-4-6',
  'claude-4.6-sonnet-high-thinking':'claude-sonnet-4-6',
  'claude-4-opus':                  'claude-opus-4',
  'claude-4.5-opus':                'claude-opus-4-5',
  'claude-4.5-opus-high':           'claude-opus-4-5',
  'claude-4.5-opus-low':            'claude-opus-4-5',
  'claude-4.5-opus-medium':         'claude-opus-4-5',
  'claude-4.5-opus-high-thinking':  'claude-opus-4-5',
  'claude-4.6-opus':                'claude-opus-4-6',
  'claude-4.6-opus-fast-mode':      'claude-opus-4-6',
  'claude-4.6-opus-high':           'claude-opus-4-6',
  'claude-4.6-opus-low':            'claude-opus-4-6',
  'claude-4.6-opus-medium':         'claude-opus-4-6',
  'claude-4.6-opus-high-thinking':  'claude-opus-4-6',
  'claude-4.7-opus':                'claude-opus-4-7',
  'claude-opus-4-7-thinking-high': 'claude-opus-4-7',
  'claude-4.5-haiku':               'claude-haiku-4-5',
  'claude-4.6-haiku':               'claude-haiku-4-5',
  'gpt-5-fast':                     'gpt-5',
  'gpt-4.1':                        'gpt-4.1',
  'gpt-4-1':                        'gpt-4.1',
  'gpt-5.2-low':                    'gpt-5',
  'gpt-5.1-codex-high':             'gpt-5.3-codex',
  'gemini-3.1-pro':                 'gemini-3.1-pro-preview',
  'gemini-3-1-pro-preview':         'gemini-3.1-pro-preview',
  'gemini-3-flash':                 'gemini-3-flash-preview',
  // gemini-3-flash-a/-b/-agent are NOT the retired gemini-3-flash/M18 family:
  // upstream responseModelAliases binds -a to MODEL_PLACEHOLDER_M132 and
  // -b/-agent to M133, whose server display name is 'Gemini 3.5 Flash (High)'
  // (Antigravity Context Window Monitor models.ts@603e3ea). The old
  // gemini-3-flash-preview target for -agent misattributed ~56M observed
  // tokens. Effort tiers collapse onto the priced base row, matching the
  // gemini-3.5-flash-* entries below.
  'gemini-3-flash-a':               'gemini-3.5-flash',
  'gemini-3-flash-b':               'gemini-3.5-flash',
  'gemini-3-flash-agent':           'gemini-3.5-flash',
  // gemini-pro-default (legacy) and gemini-pro-agent (current model_id) are
  // the two wire ids bound to MODEL_PLACEHOLDER_M16 = Gemini 3.1 Pro; same
  // source. The catalog prices that SKU under its -preview spelling, so the
  // target is the priced row (same collapse as the gemini-3.1-pro-high/-low
  // entries below) rather than the intermediate 'gemini-3.1-pro' alias.
  'gemini-pro-default':             'gemini-3.1-pro-preview',
  'gemini-pro-agent':               'gemini-3.1-pro-preview',
  // gemini-pro-a/-c and gemini-default are opaque Antigravity gen_metadata #19
  // wire names — role labels whose actual tier only the accompanying
  // model_enum discloses (gemini-pro-a/-c observed with MODEL_PLACEHOLDER_M16
  // = Gemini 3.1 Pro; gemini-default with M20 = Gemini 3.5 Flash, never M84;
  // Antigravity Context Window Monitor models.ts@603e3ea, Antigravity Manager
  // quota.rs@dfe8765). These aliases are the fallback for rows that carry no
  // enum attribute; the targets are the priced rows the provider's own
  // PLACEHOLDER_MODEL_IDS table maps those enums to.
  'gemini-pro-a':                   'gemini-3.1-pro-preview',
  'gemini-pro-c':                   'gemini-3.1-pro-preview',
  'gemini-default':                 'gemini-3.5-flash',
  'gemini-3.1-pro-high':            'gemini-3.1-pro-preview',
  'gemini-3.1-pro-low':             'gemini-3.1-pro-preview',
  'gemini-3.5-flash-high':          'gemini-3.5-flash',
  'gemini-3.5-flash-medium':        'gemini-3.5-flash',
  'gemini-3.5-flash-low':           'gemini-3.5-flash',
  'gemini-3.5-flash-extra-low':     'gemini-3.5-flash',
  'Gemini 3.5 Flash (High)':        'gemini-3.5-flash',
  'Gemini 3.5 Flash (Medium)':      'gemini-3.5-flash',
  'Gemini 3.5 Flash (Low)':         'gemini-3.5-flash',
  'gemini-3-pro':                   'gemini-3-pro-preview',
  'gemini-3.1-flash-image':         'gemini-3.1-flash-image-preview',
  'gemini-3-pro-image':             'gemini-3-pro-image-preview',
  'gemini-3-pro-image-high':        'gemini-3-pro-image-preview',
  'gemini-3.1-pro-image':           'gemini-3-pro-image-preview',
  'gemini-3.1-flash-lite':          'gemini-3.1-flash-lite-preview',
  'gemini-2.5-flash-image':         'gemini-2.5-flash-image',
  'gemini-2-5-flash-image':         'gemini-2.5-flash-image',
  'nano-banana':                    'gemini-3.1-flash-image-preview',
  'nano-banana-2':                  'gemini-3.1-flash-image-preview',
  'nano-banana-2-lite':             'gemini-3.1-flash-image-preview',
  'nano-banana-pro':                'gemini-3-pro-image-preview',
  'nanobanana':                     'gemini-3.1-flash-image-preview',
  'nanobanana-2':                   'gemini-3.1-flash-image-preview',
  'nanobanana-pro':                 'gemini-3-pro-image-preview',
  'imagen-3':                       'imagen-3',
  'imagen-3.0':                     'imagen-3',
  'veo-2':                          'veo-2',
  'veo-3':                          'veo-3',
  'gemini-2-5-pro':                 'gemini-2.5-pro',
  'gemini-2-5-pro-preview-tts':     'gemini-2.5-pro-preview-tts',
  'gemini-2-5-flash':               'gemini-2.5-flash',
  'grok-code-fast-1':               'grok-code-fast-1',
  'gemma-4-26b-a4bvgemma-4-26b-a4b': 'google.gemma-4-26b-a4b',
  'nemotron-3-ultra':               'nemotron-3-ultra-550b-a55b',
  // OpenCode's free tier serves Nemotron 3.5 Lightning under the bare slug;
  // LiteLLM only indexes NVIDIA's namespaced row. Same model, published rate.
  'nemotron-3.5-lightning':         'nvidia/nemotron-3.5-lightning',
  // Local GGUF exports normalize to this bare slug (stripLocalGgufFilename);
  // map it onto the A3B release the catalog prices.
  'ornith-1.5-35b':                 'ornith-1.5-35b-a3b',
  'GLM-5.2':                        'glm-5p1',
  'glm-5.2':                        'glm-5p1',
  'GLM-5.3':                        'glm-5p2',
  'glm-5.3':                        'glm-5p2',
}

let userAliases: Record<string, string> = {};
let userPriceOverrides: Map<string, ModelCosts> = new Map();
let userPriceOverridesConfig: Record<string, PriceOverrideRates> = {};
let sortedPriceOverrideKeys: string[] | null = null;
let lowercasePriceOverrideIndex: Map<string, ModelCosts> | null = null;

// Called once during CLI startup after config is loaded.
// User aliases take precedence over built-ins.
export function setModelAliases(aliases: Record<string, string>): void {
  userAliases = aliases;
}

// User-defined display names from config.modelNames. Checked first in
// getShortModelName so they override every hardcoded SHORT_NAMES entry.
let userModelNames: Record<string, string> = {};

export function setModelNames(names: Record<string, string>): void {
  userModelNames = { ...names };
  // Also index by provider-stripped form (e.g. "qwen/qwen3.6-35b-a3b" ->
  // "qwen3.6-35b-a3b") because providers strip the prefix before calling
  // getShortModelName. First-write wins so the user's explicit key takes
  // precedence over a derived stripped form.
  for (const [key, displayName] of Object.entries(names)) {
    const stripped = key.replace(/^[^/]+\//, "");
    if (stripped !== key && !Object.hasOwn(userModelNames, stripped)) {
      userModelNames[stripped] = displayName;
    }
  }
}

function priceOverrideRatePerToken(usdPerMillion: number | undefined): number | null {
  if (typeof usdPerMillion !== 'number') return null
  return safePerTokenRate(usdPerMillion / 1_000_000)
}

// Called once during CLI startup after config is loaded.
// Config/CLI rates are USD per 1,000,000 tokens; ModelCosts stores USD/token.
export function setPriceOverrides(overrides: Record<string, PriceOverrideRates>): void {
  const next = new Map<string, ModelCosts>()
  const nextConfig: Record<string, PriceOverrideRates> = {}
  for (const [model, rates] of Object.entries(overrides)) {
    if (!model || !rates || typeof rates !== 'object') continue
    nextConfig[model] = { ...rates }
    const input = priceOverrideRatePerToken(rates.input)
    const output = priceOverrideRatePerToken(rates.output)
    if (input === null || output === null) continue
    next.set(model, buildCosts(
      input,
      output,
      priceOverrideRatePerToken(rates.cacheCreation),
      priceOverrideRatePerToken(rates.cacheRead),
      undefined,
    ))
  }
  userPriceOverrides = next
  userPriceOverridesConfig = nextConfig
  sortedPriceOverrideKeys = null
  lowercasePriceOverrideIndex = null
}

function getSortedPriceOverrideKeys(): string[] {
  if (sortedPriceOverrideKeys === null) {
    sortedPriceOverrideKeys = Array.from(userPriceOverrides.keys()).sort((a, b) => b.length - a.length)
  }
  return sortedPriceOverrideKeys
}

function getLowercasePriceOverrideIndex(): Map<string, ModelCosts> {
  if (lowercasePriceOverrideIndex === null) {
    lowercasePriceOverrideIndex = new Map()
    for (const [key, costs] of userPriceOverrides) {
      const lk = key.toLowerCase()
      if (!lowercasePriceOverrideIndex.has(lk)) lowercasePriceOverrideIndex.set(lk, costs)
    }
  }
  return lowercasePriceOverrideIndex
}

function getPriceOverrideExact(...keys: string[]): ModelCosts | null {
  for (const key of keys) {
    const costs = userPriceOverrides.get(key)
    if (costs) return costs
  }
  return null
}

function getPriceOverridePrefix(canonical: string): ModelCosts | null {
  for (const key of getSortedPriceOverrideKeys()) {
    if (canonical.startsWith(key + '-') || canonical === key) {
      return userPriceOverrides.get(key)!
    }
  }
  return null
}

function getPriceOverrideCaseInsensitive(canonical: string, withPrefix: string): ModelCosts | null {
  const lowerIndex = getLowercasePriceOverrideIndex()
  return lowerIndex.get(canonical.toLowerCase()) ?? lowerIndex.get(withPrefix.toLowerCase()) ?? null
}

// Local-model savings config. Kept separate from userAliases: a `modelAliases`
// entry rewrites a model's identity for actual cost; a `localModelSavings`
// entry keeps the model cost at $0 and reports the *avoided* spend against a
// paid baseline. Set during preAction from `config.localModelSavings`.
let userLocalModelSavings: Record<string, string> = {};

export function setLocalModelSavings(mappings: Record<string, string>): void {
  userLocalModelSavings = { ...mappings };
}

export function getLocalSavingsBaseline(rawModel: string): string | undefined {
  if (!rawModel || typeof rawModel !== "string") return undefined;
  // Defensive: bracket-accessing user-controlled keys on a plain object
  // exposes the prototype chain (`__proto__` would resolve to Object.prototype).
  // Use Object.hasOwn so a hostile JSONL model name cannot piggyback into
  // Object.prototype either through the alias map or here.
  if (!Object.hasOwn(userLocalModelSavings, rawModel)) return undefined;
  return userLocalModelSavings[rawModel];
}

/// Compute the hypothetical baseline cost for a local call. The baseline
/// model is priced through the normal `calculateCost` pipeline (so it can
/// be aliased / canonicalized). Returns `null` when the source model has
/// no savings mapping, the baseline is unknown to the pricing snapshot, or
/// any input is unusable — callers should treat null as "no savings
/// recorded for this call" rather than a hard error.
export function calculateLocalModelSavings(
  rawModel: string,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
  webSearchRequests: number,
  speed: "standard" | "fast" = "standard",
  oneHourCacheCreationTokens = 0,
): { savingsUSD: number; baselineModel: string } | null {
  const baseline = getLocalSavingsBaseline(rawModel);
  if (!baseline) return null;
  if (!getModelCosts(baseline)) return null;
  const savingsUSD = calculateCost(
    baseline,
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    webSearchRequests,
    speed,
    oneHourCacheCreationTokens,
  );
  return { savingsUSD, baselineModel: baseline };
}

/// Stable hash of the current savings config so the daily cache can detect
/// "user changed their baseline mapping" and rebuild instead of presenting
/// stale saved-spend numbers. Two configs with the same key→baseline pairs
/// in any order collapse to the same hash.
export function getLocalModelSavingsConfigHash(): string {
  const keys = Object.keys(userLocalModelSavings).sort();
  if (keys.length === 0) return "";
  const parts = keys.map((k) => `${k}\u0001${userLocalModelSavings[k]}`);
  return parts.join("\u0002");
}

// Subscription / flat-rate product SKUs. $0 is the correct cost; aliasing
// them onto a per-token row fabricates spend (#968). Distinct from
// model-savings (counterfactual local baseline) and from a zero-rate
// price-override (user-declared free). Built-in families plus a user hatch.
let userFlatRateModels = new Set<string>()
let userFlatRateLeaves = new Set<string>()
let userFlatRateRemoved = new Set<string>()
let userFlatRateRemovedLeaves = new Set<string>()

function flatRateLeaf(model: string): string {
  const trimmed = model.trim().replace(/@.*$/, '').replace(/-\d{8}$/, '')
  const leaf = trimmed.includes('/') ? trimmed.slice(trimmed.lastIndexOf('/') + 1) : trimmed
  return leaf.toLowerCase()
}

function fillFlatRateSet(
  models: Iterable<string>,
): { ids: Set<string>; leaves: Set<string> } {
  const ids = new Set<string>()
  const leaves = new Set<string>()
  for (const model of models) {
    if (!model || typeof model !== 'string') continue
    ids.add(model)
    const leaf = flatRateLeaf(model)
    if (leaf) leaves.add(leaf)
  }
  return { ids, leaves }
}

export function setFlatRateModels(models: Iterable<string>): void {
  const filled = fillFlatRateSet(models)
  userFlatRateModels = filled.ids
  userFlatRateLeaves = filled.leaves
}

export function setFlatRateRemoved(models: Iterable<string>): void {
  const filled = fillFlatRateSet(models)
  userFlatRateRemoved = filled.ids
  userFlatRateRemovedLeaves = filled.leaves
}

export function getFlatRateModelsConfigHash(): string {
  const added = [...userFlatRateModels].sort().join('\u0002')
  const removed = [...userFlatRateRemoved].sort().join('\u0002')
  if (!removed) return added
  return `${added}\u0003${removed}`
}

export function getFlatRateModels(): string[] {
  return [...userFlatRateModels]
}

export function getFlatRateRemoved(): string[] {
  return [...userFlatRateRemoved]
}

export function isSameFlatRateModel(a: string, b: string): boolean {
  if (!a || !b) return false
  if (a === b) return true
  const leaf = flatRateLeaf(a)
  return leaf.length > 0 && leaf === flatRateLeaf(b)
}

function isUserFlatRateModel(model: string): boolean {
  if (userFlatRateModels.has(model)) return true
  const leaf = flatRateLeaf(model)
  return leaf.length > 0 && userFlatRateLeaves.has(leaf)
}

function isFlatRateRemoved(model: string): boolean {
  if (userFlatRateRemoved.has(model)) return true
  const leaf = flatRateLeaf(model)
  return leaf.length > 0 && userFlatRateRemovedLeaves.has(leaf)
}

/// Product SKUs billed as a subscription, not missing LiteLLM rows.
/// Match raw ids and path-prefixed ids (`cline-pass/auto-genius`). Display
/// names from getShortModelName are matched only when the aggregation key
/// is not the raw leaf (Warp Auto *, Grok Composer *).
export function isBuiltInFlatRateModel(model: string): boolean {
  const leaf = flatRateLeaf(model)
  // Warp's product SKU is the bare id `auto`. Kiro rewrites its own `auto`
  // to `kiro-auto` before pricing, so this leaf does not swallow Kiro.
  if (
    leaf === 'auto'
    || leaf === 'auto-genius'
    || leaf === 'kimi-for-coding-highspeed'
  ) return true
  if (leaf.startsWith('grok-composer-')) return true
  if (leaf.startsWith('warp-auto-')) return true
  const display = model.trim()
  if (/^grok composer\b/i.test(display)) return true
  if (/^warp auto\b/i.test(display)) return true
  return false
}

export function isFlatRateModel(model: string): boolean {
  if (!model) return false
  if (isFlatRateRemoved(model)) return false
  return isUserFlatRateModel(model) || isBuiltInFlatRateModel(model)
}

/// Shared unpriced-warning copy. Never tell the user to alias unconditionally:
/// mapping a subscription SKU onto a priced row invents spend. Optional `model`
/// interpolates the sanitized id so the verbose calculateCost path names the
/// same two hatches.
export function unpricedModelHint(model = '<model>'): string {
  const safe = model.replace(/[\x00-\x1F\x7F-\x9F]/g, '?').slice(0, 200)
  return `If a model is billed per token, map it with: codeburn model-alias "${safe}" <known-model>. If $0 is correct (subscription / flat-rate): codeburn model-flat-rate "${safe}".`
}

/// Stable hash of the model-alias map, for the same staleness class as the
/// hashes below: a resident process (codeburn serve) must not serve memoized
/// parse results priced under aliases the user has since changed.
export function getModelAliasesConfigHash(): string {
  const keys = Object.keys(userAliases).sort()
  if (keys.length === 0) return ''
  return keys.map(k => `${k}\u0001${userAliases[k]}`).join('\u0002')
}

export function getPriceOverridesConfigHash(): string {
  // The builtin overrides participate so editing BUILTIN_PRICE_OVERRIDES in a
  // release invalidates cached daily costs the same way a user override does.
  const builtin = `builtin:${JSON.stringify(BUILTIN_PRICE_OVERRIDES)}`
  const keys = Object.keys(userPriceOverridesConfig).sort()
  if (keys.length === 0) return builtin
  const parts = keys.map(k => {
    const rates = userPriceOverridesConfig[k]
    return [
      k,
      rates.input,
      rates.output,
      rates.cacheRead ?? '',
      rates.cacheCreation ?? '',
    ].join('\u0001')
  })
  return [builtin, ...parts].join('\u0002')
}

// Absolute directory prefixes whose sessions are routed through a
// subscription-backed proxy (config `proxyPaths`). Stored already-normalized so
// the per-project match is a cheap compare. Set during preAction. See
// CodeburnConfig.proxyPaths for the product rationale.
let userProxyPaths: string[] = []

/// Normalize a path for prefix comparison: backslashes -> forward slashes
/// (Windows configs / cwds), strip leading AND trailing slashes, fold case on
/// case-insensitive filesystems. Leading slashes are stripped because provider
/// project paths arrive in two forms — Claude keeps the absolute "/Users/x"
/// while Codex (sanitizeProject) and the unsanitizePath fallback drop the
/// leading slash to "Users/x". Folding both to a slashless form (mirroring
/// crossProviderKey) makes matching agnostic to which provider produced the
/// path, so the same directory is flagged whether or not a Claude session
/// happens to co-exist there. Case is folded only on macOS/Windows; on Linux
/// "/home/Me" and "/home/me" are different dirs, so folding would risk
/// crediting unrelated spend. A path that normalizes to empty (e.g. "/" or "")
/// is dropped by callers so it can never match everything. Exported so the CLI
/// dedupes with the same rule.
export function normalizeProxyPath(p: string): string {
  const s = p.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
  return (process.platform === 'darwin' || process.platform === 'win32') ? s.toLowerCase() : s
}

export function setProxyPaths(paths: string[]): void {
  userProxyPaths = (Array.isArray(paths) ? paths : [])
    .filter((p): p is string => typeof p === 'string')
    .map(normalizeProxyPath)
    .filter(p => p !== '')
}

/// True when `cwd` is at or under a configured proxy path. Prefix match is
/// anchored to a path-segment boundary so "/a/proj" matches "/a/proj" and
/// "/a/proj/sub" but NOT "/a/project-x". Empty/undefined cwd or empty config
/// never matches (so a misconfig can't silently zero unrelated spend).
export function isProxiedPath(cwd: string | undefined | null): boolean {
  if (!cwd || typeof cwd !== 'string') return false
  if (userProxyPaths.length === 0) return false
  const c = normalizeProxyPath(cwd)
  if (c === '') return false
  return userProxyPaths.some(p => c === p || c.startsWith(p + '/'))
}

/// Stable hash of the active proxy-path config. Project-level proxy attribution
/// is computed live from this set and then cached in the in-memory session
/// cache, so the cache key must vary with it — otherwise a long-lived process
/// (menubar) that re-reads config could serve attribution from a stale set.
export function getProxyPathsConfigHash(): string {
  if (userProxyPaths.length === 0) return ''
  return [...userProxyPaths].sort().join('')
}

function resolveAlias(model: string): string {
  if (Object.hasOwn(userAliases, model)) return userAliases[model]!
  if (Object.hasOwn(BUILTIN_ALIASES, model)) return BUILTIN_ALIASES[model]!
  const lowercase = model.toLowerCase()
  if (lowercase !== model && Object.hasOwn(BUILTIN_ALIASES, lowercase)) return BUILTIN_ALIASES[lowercase]!
  return model
}
/// OpenCode's free tier serves otherwise-priced SKUs under a terminal `-free`
/// suffix (`mimo-v2.5-free`, `nemotron-3-ultra-free`). Strip only when `-free`
/// is the TERMINAL segment (`^(.+)-free$`), never a mid-name substring, so
/// routing namespaces like `cline-free/` survive untouched.
function stripTerminalFreeSuffix(model: string): string {
  return model.replace(/^(.+)-free$/i, '$1')
}

/// Local GGUF runners record raw filenames (`Ornith-1.5-35B-Q4_K_M.gguf`).
/// Drop the `.gguf` extension and one TRAILING llama.cpp quantization tag
/// (`Q4_K_M`, `Q8_0`, `IQ4_XS`, `BF16`, …), then fold case, so a local export
/// lands in the bucket of the cloud model it was quantized from. Case folding
/// is scoped to ids we actually stripped rather than applied to every id:
/// display names and case-sensitive alias keys elsewhere depend on the
/// original spelling. Colon tags (ollama `qwen3:Q4_K_M`) are deliberately
/// untouched — ':' is never treated as a quant separator, and LOCAL_NAMESPACES
/// relies on unlisted local tags staying unpriced (#968).
function stripLocalGgufFilename(model: string): string {
  const stripped = model
    .replace(/\.gguf$/i, '')
    .replace(/[-_](?:q[2-8](?:_[a-z0-9]+)*|iq[1-4](?:_[a-z0-9]+)*|bf16|fp16|f16|f32)$/i, '')
  return stripped === model ? model : stripped.toLowerCase()
}

function getCanonicalName(model: string): string {
  const cleaned = model
    .replace(/@.*$/, '')
    .replace(/-\d{8}$/, '')
    .replace(/\[[^\]]*\]$/, '')
  // Full-id aliases (orcarouter/fusion) must stay visible so resolveAlias can
  // see them. Stripping first would leave a leaf (`fusion`) with no mapping.
  // Nested wrappers without an alias still peel as before.
  if (Object.hasOwn(userAliases, cleaned) || Object.hasOwn(BUILTIN_ALIASES, cleaned)) {
    return cleaned
  }
  const lowercase = cleaned.toLowerCase()
  if (lowercase !== cleaned && Object.hasOwn(BUILTIN_ALIASES, lowercase)) {
    return cleaned
  }
  return stripKnownFirstNamespace(
    stripLocalGgufFilename(
      stripTerminalFreeSuffix(cleaned),
    ),
  )
}

/// Alias-resolved identity for report merge. Display names stay cosmetic —
/// prefix matches in SHORT_NAMES must not fold distinct SKUs into one row.
/// Path-form ids (`accounts/fireworks/models/<slug>`, `cline-pass/<slug>`)
/// peel to the leaf so they share a bucket with the bare slug.
export function resolveCanonicalModelId(model: string): string {
  const viaUser = Object.hasOwn(userAliases, model) ? userAliases[model]! : model
  const aliased = resolveAlias(getCanonicalName(viaUser))
  if (!aliased.includes('/')) return aliased
  const leaf = aliased.slice(aliased.lastIndexOf('/') + 1)
  if (!leaf) return aliased
  return resolveAlias(getCanonicalName(leaf))
}

// Namespaces the pricing catalog itself uses, plus the ones below. An unknown
// `provider/model` must stay unpriced — do not treat `/` as authority. Derived
// rather than hand-listed so a vendor LiteLLM already knows (`x-ai/`, `qwen/`,
// `nousresearch/`, …) is never dropped by a stale list.
const EXTRA_NAMESPACES = [
  // Routing wrappers (see ROUTER_PREFIXES); no catalog lists them.
  'cp', 'cline-pass', 'cline-free', 'cmd', 'antigravity', 'orcarouter',
  // LiteLLM route prefixes that never appear as a key prefix.
  'litellm_proxy', 'openai_like',
  // Vendor spellings the catalog indexes under another name: `zhipu` is `z-ai`,
  // `mimo` is `xiaomi` (BUILTIN_ALIASES maps the bare MiMo ids to `xiaomi/`),
  // and `kimi/` is a client-side prefix (Codex records `kimi/k3[1m]`).
  'zhipu', 'mimo', 'kimi',
]

// Local runners. Their catalog rows are $0 stubs, so an unlisted local tag must
// not strip down to a priced cloud row and invent spend (#968).
const LOCAL_NAMESPACES = ['ollama']

let knownNamespaces: Set<string> | null = null

function getKnownNamespaces(): Set<string> {
  if (knownNamespaces) return knownNamespaces
  const set = new Set(EXTRA_NAMESPACES)
  for (const keys of [pricingCache.keys(), fallbackCosts.keys()]) {
    for (const key of keys) {
      const idx = key.indexOf('/')
      if (idx > 0) set.add(key.slice(0, idx).toLowerCase())
    }
  }
  for (const local of LOCAL_NAMESPACES) set.delete(local)
  knownNamespaces = set
  return set
}

function stripKnownFirstNamespace(model: string): string {
  const idx = model.indexOf('/')
  if (idx <= 0) return model
  const head = model.slice(0, idx).toLowerCase()
  if (getKnownNamespaces().has(head)) return model.slice(idx + 1)
  return model
}

// Routing wrappers (OmniRoute, Cline Pass, cmd/, …) are not model ids.
// Peel them so any plan/gateway spelling of the same model shares one price.
// OrcaRouter is a gateway that routes to many vendors. Its catalog exposes
// route ids (`orcarouter/auto`, `orcarouter/fusion`, …) and plain vendor ids
// (`deepseek/deepseek-v4-pro`); a route id can also spell a nested upstream
// (`orcarouter/deepseek/deepseek-v4-pro`), and the completion response's
// `model` field reports the upstream id that actually ran. Peeling the prefix
// lets every routed spelling price at the upstream row.
const ROUTER_PREFIXES = [
  /^omniroute:/i,
  /^cp\//i,
  /^cline-pass\//i,
  /^cline-free\//i,
  /^cmd\//i,
  /^antigravity\//i,
  /^orcarouter\//i,
  // `xiaomi/` is NOT peeled: it is the vendor namespace LiteLLM prices under,
  // and BUILTIN_ALIASES maps the bare MiMo ids INTO it. Peeling would pull the
  // opposite way. It stays a known namespace via the catalog-derived set.
]

function routedModelCandidates(model: string): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  const push = (value: string) => {
    if (!value || seen.has(value)) return
    seen.add(value)
    ids.push(value)
  }
  push(model)
  let current = model
  let peeled = true
  while (peeled) {
    peeled = false
    for (const prefix of ROUTER_PREFIXES) {
      const next = current.replace(prefix, '')
      if (next && next !== current) {
        current = next
        push(current)
        peeled = true
      }
    }
  }
  // One known-vendor strip only (anthropic/foo → foo). Unknown
  // provider/model trees stay intact and therefore unpriced.
  push(getCanonicalName(current))
  return ids
}

function stripKnownPricingVariantSuffix(model: string): string | null {
  const withoutColonSuffix = model.replace(/:(thinking|cloud)$/i, '')
  if (withoutColonSuffix !== model) return withoutColonSuffix

  const withoutTeeSuffix = model.replace(/-TEE$/i, '')
  if (withoutTeeSuffix !== model) return withoutTeeSuffix

  return null
}

export function getModelCosts(model: string): ModelCosts | null {
  const withPrefix = model.replace(/@.*$/, '').replace(/-\d{8}$/, '')
  const canonicalName = getCanonicalName(model)
  const canonical = resolveAlias(canonicalName)

  const override = getPriceOverrideExact(model, withPrefix, canonicalName, canonical)
  if (override) return override

  if (canonical !== canonicalName && withPrefix === canonicalName && pricingCache.has(canonical)) {
    return pricingCache.get(canonical)!
  }

  if (pricingCache.has(withPrefix)) return pricingCache.get(withPrefix)!
  if (pricingCache.has(canonical)) return pricingCache.get(canonical)!

  for (const candidate of routedModelCandidates(model)) {
    const aliased = resolveAlias(candidate)
    // A user's declared price for the bare id must win over the catalog row a
    // routed spelling of it would otherwise hit.
    const candidateOverride = getPriceOverrideExact(candidate, aliased)
    if (candidateOverride) return candidateOverride
    if (pricingCache.has(aliased)) return pricingCache.get(aliased)!
    if (pricingCache.has(candidate)) return pricingCache.get(candidate)!
  }

  const prefixOverride = getPriceOverridePrefix(canonical)
  if (prefixOverride) return prefixOverride

  for (const key of getSortedPricingKeys()) {
    if (canonical.startsWith(key + "-") || canonical === key) {
      return pricingCache.get(key)!;
    }
  }

  const caseInsensitiveOverride = getPriceOverrideCaseInsensitive(canonical, withPrefix)
  if (caseInsensitiveOverride) return caseInsensitiveOverride

  const lowerIndex = getLowercasePricingIndex()
  const byCanonical = lowerIndex.get(canonical.toLowerCase())
  if (byCanonical) return byCanonical
  const byPrefix = lowerIndex.get(withPrefix.toLowerCase())
  if (byPrefix) return byPrefix

  const withPrefixVariant = stripKnownPricingVariantSuffix(withPrefix)
  if (withPrefixVariant && withPrefixVariant !== withPrefix) {
    const variantCosts = getModelCosts(withPrefixVariant)
    if (variantCosts) return variantCosts
  }

  const canonicalVariant = stripKnownPricingVariantSuffix(canonical)
  if (canonicalVariant && canonicalVariant !== canonical && canonicalVariant !== withPrefixVariant) {
    const variantCosts = getModelCosts(canonicalVariant)
    if (variantCosts) return variantCosts
  }

  const lowerCanonical = canonical.toLowerCase()
  if (fallbackCosts.has(lowerCanonical)) return fallbackCosts.get(lowerCanonical)!
  if (openRouterPricing.has(canonical)) return openRouterPricing.get(canonical)!
  if (openRouterPricing.has(lowerCanonical)) return openRouterPricing.get(lowerCanonical)!

  return null;
}

// Warn at most once per unknown model name per process. Without this, a model
// missing from the pricing snapshot would silently price at $0 for every
// session that used it, hiding real spend until the user noticed.
const warnedUnknownModels = new Set<string>();

/// Heuristic for "this looks like a local model that will never be in LiteLLM's
/// pricing JSON". We suppress the unknown-model warning for these because the
/// "update codeburn" advice can't help — local Ollama models, llama.cpp tags,
/// LM Studio loads, etc. are billed locally and don't have public pricing.
/// Users still get $0 in cost reports for them (correct — local inference is
/// effectively free); the warning was just noise.
function looksLikeLocalModel(name: string): boolean {
  // Ollama and LM Studio tags include `:tag` (e.g. qwen3.6:35b-a3b-bf16).
  if (name.includes(":") && !name.startsWith("http")) return true;
  // GGUF / quantized fingerprints commonly seen in local inference.
  if (/[-_](q[2-8](_[a-z0-9]+)?|bf16|fp16|gguf|f16|f32)$/i.test(name))
    return true;
  return false;
}

export interface UnpricedModelUsage {
  model: string
  calls: number
  tokens: number
}

function hasBillableRate(costs: ModelCosts): boolean {
  return costs.inputCostPerToken > 0
    || costs.outputCostPerToken > 0
    || costs.cacheWriteCostPerToken > 0
    || costs.cacheReadCostPerToken > 0
}

// Exact-override lookup with the same key derivation getModelCosts uses. Lets
// the unpriced detector distinguish "explicitly declared free by the user" (a
// zero-rate override) from a zero-rate LiteLLM stub, which means "listed but
// unknown price" and must still be flagged. Only the EXACT override form is
// consulted: getModelCosts checks it before any table hit, so when one exists
// it is provably what priced the model. Prefix and case-insensitive overrides
// resolve AFTER table hits and so cannot prove the $0 was intentional; a
// zero-rate stub shadowed by one still gets flagged (the honest direction).
function exactPriceOverrideFor(model: string): ModelCosts | null {
  const withPrefix = model.replace(/@.*$/, '').replace(/-\d{8}$/, '')
  const canonicalName = getCanonicalName(model)
  const canonical = resolveAlias(canonicalName)
  return getPriceOverrideExact(model, withPrefix, canonicalName, canonical)
}

// Render-time unpriced detection (#638): flag aggregated model rows that carry
// usage but $0 cost AND whose pricing lookup yields no billable rate right
// now. Cost is computed at parse time and cached, so a parse-time registry
// would miss cached sessions; a render-time check covers both and heals the
// moment pricing data, an alias, or a price override arrives.
//
// Rows with cost > 0 are never flagged: aggregation keys rows by DISPLAY name
// (parser.ts keys modelBreakdown via getShortModelName), which the pricing
// lookup misses, so a priced model like "Opus 4.8" would otherwise false-flag.
// $0 display-name rows ARE flagged even when the raw id would price today:
// those tokens really did enter the report at $0 (a provider priced a
// transformed name, or the session was cached before its model's pricing
// landed). Conservative by design: a display key merging priced and unpriced
// raw ids carries cost > 0 and is not flagged. Local-looking models and
// models with a local-savings mapping are excluded because $0 is their
// correct cost, as are zero-rate USER overrides (explicitly declared free).
/// Models whose $0 cost is CORRECT rather than a pricing gap, mirroring the
/// exclusions findUnpricedModels applies: local-looking models, models mapped
/// to a local-savings baseline, subscription / flat-rate product SKUs, and
/// models an exact zero-rate user override declares free. Used to keep their
/// calls out of the pricing-coverage denominator — otherwise a 95%-ollama
/// user reads high coverage while every genuinely cost-bearing call is unpriced.
export function isExpectedFreeModel(model: string): boolean {
  if (looksLikeLocalModel(model)) return true
  if (getLocalSavingsBaseline(model)) return true
  const costs = getModelCosts(model)
  // A builtin/user alias can still attach a billable rate to a subscription
  // SKU (warp-auto-* today). Those calls are priced, so they stay in the
  // coverage denominator. Only the $0 / no-rate case is expected-free.
  if (isFlatRateModel(model) && (!costs || !hasBillableRate(costs))) return true
  if (costs && !hasBillableRate(costs) && exactPriceOverrideFor(model)) return true
  return false
}

export function findUnpricedModels(
  rows: Iterable<{ model: string; calls: number; cost: number; tokens?: number }>,
): UnpricedModelUsage[] {
  const out: UnpricedModelUsage[] = []
  for (const row of rows) {
    const { model } = row
    const tokens = row.tokens ?? 0
    if (!model || model === '<synthetic>') continue
    if (row.calls <= 0 && tokens <= 0) continue
    if (row.cost > 0) continue
    if (looksLikeLocalModel(model)) continue
    if (getLocalSavingsBaseline(model)) continue
    if (isFlatRateModel(model)) continue
    const costs = getModelCosts(model)
    if (costs && hasBillableRate(costs)) continue
    if (costs && exactPriceOverrideFor(model)) continue
    out.push({ model, calls: row.calls, tokens })
  }
  return out.sort((a, b) => (b.tokens - a.tokens) || (b.calls - a.calls)
    || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0))
}

function shouldWarnAboutUnknownModel(name: string): boolean {
  if (!name || name === "<synthetic>") return false;
  if (warnedUnknownModels.has(name)) return false;
  // Suppress for local/quantized models — the "update codeburn" hint is
  // actively misleading there. Users who need cost visibility for local
  // inference can still set an alias via `codeburn model-alias`.
  if (looksLikeLocalModel(name)) return false
  if (isFlatRateModel(name)) return false
  // The warning fired on every CLI invocation (including the default
  // dashboard) which made first launches look broken — three "no pricing
  // data" lines greet a user before the dashboard even draws. Now opt-in
  // via --verbose. The unknown model still costs $0 in reports; users who
  // suspect missing models run `codeburn --verbose` to see the list.
  if (process.env["CODEBURN_VERBOSE"] !== "1") return false;
  return true;
}

/** Render provider-supplied model IDs without terminal control characters. */
export function sanitizeModelForDisplay(model: string): string {
  return model.replace(/[\x00-\x1F\x7F-\x9F]/g, '?').slice(0, 200)
}

export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
  webSearchRequests: number,
  speed: "standard" | "fast" = "standard",
  oneHourCacheCreationTokens = 0,
): number {
  const costs = getModelCosts(model);
  if (!costs || costs.inputCostPerToken < 0 || costs.outputCostPerToken < 0) {
    if (!costs && shouldWarnAboutUnknownModel(model)) {
      warnedUnknownModels.add(model);
      const safeName = sanitizeModelForDisplay(model)
      process.stderr.write(
        `codeburn: no pricing data for model "${safeName}" — costs for this model will show $0. ` +
        `${unpricedModelHint(safeName)} Or track local-model savings with: codeburn model-savings "${safeName}" <baseline-model>, or update with: npx codeburn@latest.\n`,
      )
    }
    return 0;
  }

  const multiplier = speed === "fast" ? costs.fastMultiplier : 1;

  // Clamp negative inputs to 0. A corrupt JSONL that emits a negative token
  // count would otherwise produce a negative cost that silently subtracts
  // from real spend in aggregate totals. NaN is also handled here; the
  // arithmetic below short-circuits to 0 when any operand is non-finite.
  const safe = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);
  const safeOneHourCacheCreation = safe(oneHourCacheCreationTokens);
  const safeCacheCreation = Math.max(
    safe(cacheCreationTokens),
    safeOneHourCacheCreation,
  );
  const safeFiveMinuteCacheCreation = Math.max(
    0,
    safeCacheCreation - safeOneHourCacheCreation,
  );

  return (
    multiplier *
    (safe(inputTokens) * costs.inputCostPerToken +
      safe(outputTokens) * costs.outputCostPerToken +
      safeFiveMinuteCacheCreation * costs.cacheWriteCostPerToken +
      safeOneHourCacheCreation *
        costs.cacheWriteCostPerToken *
        ONE_HOUR_CACHE_WRITE_MULTIPLIER_FROM_FIVE_MINUTE_RATE +
      safe(cacheReadTokens) * costs.cacheReadCostPerToken +
      safe(webSearchRequests) * costs.webSearchCostPerRequest)
  );
}

const autoModelNames: Record<string, string> = {
  'auto': 'Auto',
  'glm-5.3': 'GLM-5.3',
  'GLM-5.3': 'GLM-5.3',
  'cursor-auto': 'Cursor (auto)',
  'cursor-agent-auto': 'Cursor (auto)',
  'copilot-auto': 'Copilot (auto)',
  'copilot-openai-auto': 'Copilot (OpenAI)',
  'copilot-anthropic-auto': 'Copilot (Anthropic)',
  'ibm-bob-auto': 'IBM Bob (auto)',
  'kiro-auto': 'Kiro (auto)',
  'quickdesk-auto': 'Quick Desktop (auto)',
  'cline-auto': 'Cline (auto)',
  'openclaw-auto': 'OpenClaw (auto)',
  'qwen-auto': 'Qwen (auto)',
  'kimi-auto': 'Kimi (auto)',
  'codex-auto-review': 'Codex Auto Review',
}

const SHORT_NAMES: Record<string, string> = {
  // claude-fable-5 and claude-mythos-5 are outside the opus/sonnet/haiku families deriveClaudeShortName covers.
  'claude-fable-5': 'Fable 5',
  'claude-mythos-5': 'Mythos 5',
  // Modern claude-<family>-<major>-<minor> ids are derived in deriveClaudeShortName.
  // Only the legacy 3.x ids (family-last) need explicit mapping.
  'claude-3-7-sonnet': 'Sonnet 3.7',
  'claude-3-5-sonnet': 'Sonnet 3.5',
  'claude-3-5-haiku': 'Haiku 3.5',
  'gpt-4o-mini': 'GPT-4o Mini',
  'gpt-4o': 'GPT-4o',
  'gpt-4.1-nano': 'GPT-4.1 Nano',
  'gpt-4.1-mini': 'GPT-4.1 Mini',
  'gpt-4.1': 'GPT-4.1',
  'codex-auto-review': 'Codex Auto Review',
  'gpt-5.5-pro': 'GPT-5.5 Pro',
  'gpt-5.5': 'GPT-5.5',
  'gpt-5.4-pro': 'GPT-5.4 Pro',
  'gpt-5.4-nano': 'GPT-5.4 Nano',
  'gpt-5.4-mini': 'GPT-5.4 Mini',
  'gpt-5.4': 'GPT-5.4',
  'gpt-5.3-codex-spark': 'GPT-5.3 Codex Spark',
  'gpt-5.3-codex': 'GPT-5.3 Codex',
  'gpt-5.3': 'GPT-5.3',
  'gpt-5.2-pro': 'GPT-5.2 Pro',
  'gpt-5.2-low': 'GPT-5.2 Low',
  'gpt-5.2': 'GPT-5.2',
  'gpt-5.1-codex-mini': 'GPT-5.1 Codex Mini',
  'gpt-5.1-codex': 'GPT-5.1 Codex',
  'gpt-5.1': 'GPT-5.1',
  'gpt-5-pro': 'GPT-5 Pro',
  'gpt-5-nano': 'GPT-5 Nano',
  'gpt-5-mini': 'GPT-5 Mini',
  'gpt-5': 'GPT-5',
  'gemini-3.5-flash': 'Gemini 3.5 Flash',
  'gemini-3.1-pro-preview': 'Gemini 3.1 Pro',
  'gemini-3-pro-preview': 'Gemini 3 Pro',
  'gemini-3-flash-preview': 'Gemini 3 Flash',
  'gemini-3.1-flash-image-preview': 'Gemini 3.1 Flash Image',
  'gemini-3-pro-image-preview': 'Gemini 3 Pro Image',
  'gemini-2.5-flash-image': 'Gemini 2.5 Flash Image',
  'nano-banana-pro': 'Nano Banana Pro',
  'nano-banana-2': 'Nano Banana 2',
  'nano-banana': 'Nano Banana',
  'imagen-3': 'Imagen 3',
  'veo-2': 'Veo 2',
  'veo-3': 'Veo 3',
  'gemini-2.5-pro': 'Gemini 2.5 Pro',
  'gemini-2-5-pro': 'Gemini 2.5 Pro',
  'gemini-2.5-flash': 'Gemini 2.5 Flash',
  'gemma-4-26b-a4b': 'Gemma 4 26B',
  'gemma-4-26b-a4bvgemma-4-26b-a4b': 'Gemma 4 26B',
  'qwen3.6-35b-a3b': 'Qwen 3.6 35B',
  'qwen3.5-9b': 'Qwen 3.5 9B',
  'grok-code-fast-1': 'Grok Code Fast',
  'kimi-k2-thinking-turbo': 'Kimi K2 Thinking Turbo',
  'kimi-k2-thinking': 'Kimi K2 Thinking',
  'kimi-k3': 'Kimi K3',
  'kimi-k2p6': 'Kimi K2.6',
  'kimi-thinking-preview': 'Kimi Thinking',
  'kimi-k2.7-code': 'Kimi K2.7 Code',
  'kimi-k2p7-code': 'Kimi K2.7 Code',
  '@cf/moonshotai/kimi-k2.7-code': 'Kimi K2.7 Code',
  'kimi-k2.7': 'Kimi K2.7',
  'kimi-k2.6': 'Kimi K2.6',
  'kimi-k2.5': 'Kimi K2.5',
  'kimi-k2p5': 'Kimi K2.5',
  'kimi-k2-instruct': 'Kimi K2 Instruct',
  'kimi-k2-0905': 'Kimi K2',
  'kimi-k2': 'Kimi K2',
  'kimi-latest': 'Kimi Latest',
  'glm-5.2': 'GLM-5.2',
  'glm-5p2': 'GLM-5.2',
  '@cf/zai-org/glm-5.2': 'GLM-5.2',
  'glm-5.1': 'GLM-5.1',
  'glm-5p1': 'GLM-5.2',
  'glm-5': 'GLM-5',
  'glm-4.7-flash': 'GLM 4.7 Flash',
  'glm-4p7-flash': 'GLM 4.7 Flash',
  'glm-4.7': 'GLM 4.7',
  'glm-4p7': 'GLM 4.7',
  'moonshot-v1': 'Moonshot v1',
  'deepseek-v4-pro': 'DeepSeek v4 Pro',
  'deepseek-v4-flash': 'DeepSeek v4 Flash',
  'deepseek-coder-max': 'DeepSeek Coder Max',
  'deepseek-coder': 'DeepSeek Coder',
  'deepseek-r1': 'DeepSeek R1',
  'o4-mini': 'o4-mini',
  'o3': 'o3',
  'MiniMax-M2.7-highspeed': 'MiniMax M2.7 Highspeed',
  'MiniMax-M2.7': 'MiniMax M2.7',
  'grok-build-0.1': 'Grok Build',
  'grok-composer-2.5-fast': 'Grok Composer 2.5 Fast',
  'qwen3p7-plus': 'Qwen 3.7 Plus',
  'gpt-5.6-sol': 'GPT-5.6 Sol',
  'gpt-5.6-terra': 'GPT-5.6 Terra',
  'gpt-5.6-luna': 'GPT-5.6 Luna',
  'grok-4.5': 'Grok 4.5',
  'grok-4.5-build': 'Grok 4.5 (build)',
  'qwen3.7-max': 'Qwen 3.7 Max',
  'mimo-v2.5-pro': 'MiMo v2.5 Pro',
  'mimo-v2.5': 'MiMo v2.5',
  'mimo-v2-flash': 'MiMo v2 Flash',
  'minimax-m3': 'MiniMax M3',
  'MiniMax-M3': 'MiniMax M3',
  'nemotron-3-ultra-550b-a55b': 'Nemotron 3 Ultra',
}

const SORTED_SHORT_NAMES: [string, string][] = Object.entries(SHORT_NAMES).sort(
  (a, b) => b[0].length - a[0].length,
)

const CLAUDE_FAMILY: Record<string, string> = {
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
}

function deriveClaudeShortName(canonical: string): string | undefined {
  const m = canonical.match(/^claude-(opus|sonnet|haiku)-([\d.]+)(?:-(\d+))?/)
  if (!m) return undefined
  const [, family, major, minor] = m
  return `${CLAUDE_FAMILY[family]} ${major}${minor ? `.${minor}` : ""}`
}

function deriveGeminiShortName(canonical: string): string | undefined {
  const m = canonical.match(/^gemini-([\d.]+)-(pro|flash|ultra|nano)(?:-.*)?$/i)
  if (!m) return undefined
  const [, ver, tier] = m
  const tierName = tier.charAt(0).toUpperCase() + tier.slice(1).toLowerCase()
  return `Gemini ${ver} ${tierName}`
}

function lookupShortName(id: string): string | undefined {
  if (Object.hasOwn(userModelNames, id)) return userModelNames[id]!
  const claude = deriveClaudeShortName(id)
  if (claude) return claude
  const gemini = deriveGeminiShortName(id)
  if (gemini) return gemini
  for (const [key, name] of SORTED_SHORT_NAMES) {
    if (id === key || id.startsWith(key + '-')) return name
  }
  return undefined
}

// Public API stays unary so Array.map/forEach cannot feed index as cycle state.
export function getShortModelName(model: string): string {
  return shortModelName(model, new Set())
}

/// Provider-first display name. Local labels win (Cursor estimated suffixes,
/// provider tables that intentionally override the global map). If the provider
/// echoed the raw id, it missed — fall back to the global resolver instead of
/// showing `gpt-5.6-sol` / `accounts/fireworks/models/kimi-k2p6`.
export function fallbackRawModelDisplayName(localLabel: string, rawModel: string): string {
  return localLabel === rawModel ? getShortModelName(rawModel) : localLabel
}

function shortModelName(model: string, seen: Set<string>): string {
  if (autoModelNames[model]) return autoModelNames[model]
  if (seen.has(model)) {
    const leaf = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model
    return lookupShortName(leaf) ?? leaf
  }
  seen.add(model)

  // User aliases win over built-in display names. A remap of gpt-4o must
  // show the target, not "GPT-4o".
  if (Object.hasOwn(userAliases, model)) {
    return shortModelName(userAliases[model]!, seen)
  }

  const stripped = getCanonicalName(model)
  // Before aliasing: `glm-5.3` prices via the `glm-5p2` sibling, so resolving
  // first would label a namespaced GLM-5.3 as "GLM-5.2".
  if (autoModelNames[stripped]) return autoModelNames[stripped]
  if (stripped !== model) {
    if (Object.hasOwn(userAliases, stripped)) {
      return shortModelName(userAliases[stripped]!, seen)
    }
    const knownStripped = lookupShortName(stripped)
    if (knownStripped && !Object.hasOwn(BUILTIN_ALIASES, stripped) && !Object.hasOwn(BUILTIN_ALIASES, stripped.toLowerCase())) {
      return knownStripped
    }
  }

  const canonical = resolveAlias(stripped)
  const known = lookupShortName(canonical)
  if (known) return known

  if (canonical.includes('/')) {
    const segment = canonical.slice(canonical.lastIndexOf('/') + 1)
    if (!segment || seen.has(segment) || segment === stripped) {
      return lookupShortName(segment) ?? segment
    }
    return shortModelName(segment, seen)
  }
  return lookupShortName(canonical) ?? canonical
}

// Pricing is process-global state assembled at CLI startup from the cached
// LiteLLM snapshot plus user config. A parse worker thread starts with none of
// it, and re-running loadPricing() there would mean N more disk reads (or, on a
// cold pricing cache, N network fetches). Ship the resolved state across
// instead, so every thread prices a call exactly as the main thread would.
export type PricingSnapshot = {
  pricing: Map<string, ModelCosts>
  aliases: Record<string, string>
  priceOverrides: Record<string, PriceOverrideRates>
  localModelSavings: Record<string, string>
  flatRateModels?: string[]
  flatRateModelsRemoved?: string[]
}

export function snapshotPricingState(): PricingSnapshot {
  return {
    pricing: pricingCache,
    aliases: userAliases,
    priceOverrides: userPriceOverridesConfig,
    localModelSavings: userLocalModelSavings,
    flatRateModels: getFlatRateModels(),
    flatRateModelsRemoved: getFlatRateRemoved(),
  }
}

export function restorePricingState(snapshot: PricingSnapshot): void {
  pricingCache = snapshot.pricing
  sortedPricingKeys = null
  lowercasePricingIndex = null
  knownNamespaces = null
  setModelAliases(snapshot.aliases)
  setPriceOverrides(snapshot.priceOverrides)
  setLocalModelSavings(snapshot.localModelSavings)
  setFlatRateModels(snapshot.flatRateModels ?? [])
  setFlatRateRemoved(snapshot.flatRateModelsRemoved ?? [])
}
