import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { describe, it, expect } from 'vitest'

import { createDroidProvider } from '../../src/providers/droid.js'
import { priceProviderCall } from '../../src/pricing-pass.js'
import type { ParsedProviderCall, SessionSource } from '../../src/providers/types.js'

// Byte-identical parity gate for the droid bridge migration (phase 8). Droid is
// not in the frozen corpus, so a committed fixture golden is THE parity gate:
// the bridged provider (discovery + companion-settings I/O CLI-side, pure decode
// delegated to @codeburn/core/providers/droid) must reproduce exactly what the
// pre-migration in-CLI decode produced. Covers: session-level token distribution
// with the remainder assigned to the last call, model-wrapper stripping and the
// 'unknown' fallback when settings omit a model, tool mapping (Execute->Bash,
// Task->Agent), Droid's first-line bash base-name extraction over a heredoc,
// system-reminder-only user text being dropped, and session:id dedup.
const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = resolve(here, '../fixtures/droid-parity')

const GOLDEN: ParsedProviderCall[] = [
  {
    provider: 'droid',
    model: 'gpt-5',
    inputTokens: 50,
    outputTokens: 25,
    cacheCreationInputTokens: 3,
    cacheReadInputTokens: 5,
    cachedInputTokens: 5,
    reasoningTokens: 2,
    webSearchRequests: 0,
    costBasis: 'estimated',
    tools: ['Bash', 'Read', 'Agent'],
    bashCommands: ['python3'],
    timestamp: '2026-05-01T10:00:01.000Z',
    speed: 'standard',
    deduplicationKey: 'droid:sess-droid:a1',
    userMessage: 'add a feature',
    sessionId: 'sess-droid',
  },
  {
    provider: 'droid',
    model: 'gpt-5',
    inputTokens: 51,
    outputTokens: 26,
    cacheCreationInputTokens: 4,
    cacheReadInputTokens: 6,
    cachedInputTokens: 6,
    reasoningTokens: 3,
    webSearchRequests: 0,
    costBasis: 'estimated',
    tools: [],
    bashCommands: [],
    timestamp: '2026-05-01T10:00:02.000Z',
    speed: 'standard',
    deduplicationKey: 'droid:sess-droid:a2',
    userMessage: '',
    sessionId: 'sess-droid',
  },
  {
    provider: 'droid',
    model: 'unknown',
    inputTokens: 10,
    outputTokens: 5,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
    costBasis: 'estimated',
    tools: [],
    bashCommands: [],
    timestamp: '2026-05-02T10:00:00.000Z',
    speed: 'standard',
    deduplicationKey: 'droid:sess-droid2:b1',
    userMessage: '',
    sessionId: 'sess-droid2',
  },
]

async function collect(seen = new Set<string>()): Promise<ParsedProviderCall[]> {
  const provider = createDroidProvider(FIXTURE_DIR)
  const sources: SessionSource[] = await provider.discoverSessions()
  sources.sort((a, b) => a.path.localeCompare(b.path))
  const calls: ParsedProviderCall[] = []
  for (const source of sources) {
    for await (const call of provider.createSessionParser(source, seen).parse()) calls.push(call)
  }
  return calls
}

describe('droid bridge — fixture parity', () => {
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
})
