import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { describe, it, expect } from 'vitest'

import { createOpenDesignProvider } from '../../src/providers/open-design.js'
import { priceProviderCall } from '../../src/pricing-pass.js'
import type { ParsedProviderCall, SessionSource } from '../../src/providers/types.js'

// Byte-identical parity gate for the open-design bridge migration (phase 8).
// Reuses the committed open-design fixture: the bridged provider (discovery +
// events.jsonl I/O CLI-side, pure decode delegated to
// @codeburn/core/providers/open-design) must reproduce exactly what the
// pre-migration in-CLI decode produced. Covers: the start-seeded model, model
// transitions via status events, uncached-input derivation, numeric-epoch
// timestamp normalization, per-event dedup that drops a repeated event id, the
// discovered project carried onto the call, and no-usage runs yielding nothing.
const here = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = resolve(here, '../fixtures/open-design/namespaces/release-stable/data')

const GOLDEN: ParsedProviderCall[] = [
  {
    provider: 'open-design',
    model: 'openai-codex:gpt-5.5',
    inputTokens: 950,
    outputTokens: 200,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 50,
    cachedInputTokens: 50,
    reasoningTokens: 25,
    webSearchRequests: 0,
    costBasis: 'estimated',
    tools: [],
    bashCommands: [],
    timestamp: '2026-06-22T10:00:05.000Z',
    speed: 'standard',
    deduplicationKey: 'open-design:run-mixed:evt-codex-usage',
    userMessage: '',
    sessionId: 'run-mixed',
    project: 'release-stable',
  },
  {
    provider: 'open-design',
    model: 'glm-5.2',
    inputTokens: 2900,
    outputTokens: 400,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 100,
    cachedInputTokens: 100,
    reasoningTokens: 60,
    webSearchRequests: 0,
    costBasis: 'estimated',
    tools: [],
    bashCommands: [],
    timestamp: '2026-06-22T10:00:15.000Z',
    speed: 'standard',
    deduplicationKey: 'open-design:run-mixed:evt-glm-usage',
    userMessage: '',
    sessionId: 'run-mixed',
    project: 'release-stable',
  },
  {
    provider: 'open-design',
    model: 'glm-5.2',
    inputTokens: 770,
    outputTokens: 33,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 7,
    cachedInputTokens: 7,
    reasoningTokens: 3,
    webSearchRequests: 0,
    costBasis: 'estimated',
    tools: [],
    bashCommands: [],
    timestamp: '2026-06-22T12:00:05.000Z',
    speed: 'standard',
    deduplicationKey: 'open-design:run-start-seeded:evt-before-transition',
    userMessage: '',
    sessionId: 'run-start-seeded',
    project: 'release-stable',
  },
]

async function collect(seen = new Set<string>()): Promise<ParsedProviderCall[]> {
  const provider = createOpenDesignProvider(DATA_DIR)
  const sources: SessionSource[] = await provider.discoverSessions()
  sources.sort((a, b) => a.path.localeCompare(b.path))
  const calls: ParsedProviderCall[] = []
  for (const source of sources) {
    for await (const call of provider.createSessionParser(source, seen).parse()) calls.push(call)
  }
  return calls
}

describe('open-design bridge — fixture parity', () => {
  it('the bridged provider reproduces the pre-migration decode byte-for-byte', async () => {
    expect(await collect()).toEqual(GOLDEN)
  })

  it('the priced output survives the pricing pass with only costUSD added', async () => {
    const raw = await collect()
    raw.map(priceProviderCall).forEach((call, i) => {
      expect(typeof call.costUSD).toBe('number')
      expect(Number.isFinite(call.costUSD)).toBe(true)
      expect(call.costBasis).toBe('estimated')
      const { costUSD, ...rest } = call
      expect(rest).toEqual(raw[i])
    })
  })

  it('the shared seenKeys set dedups a repeat scan', async () => {
    const seen = new Set<string>()
    const first = await collect(seen)
    const second = await collect(seen)
    expect(first).toEqual(GOLDEN)
    expect(second).toEqual([])
  })

  it('the discovered run under fixtures resolves to the release-stable project', async () => {
    const provider = createOpenDesignProvider(DATA_DIR)
    const runs = (await provider.discoverSessions()).map(s => s.path)
    expect(runs).toContain(join(DATA_DIR, 'runs', 'run-mixed', 'events.jsonl'))
  })
})
