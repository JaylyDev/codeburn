import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

import { describe, it, expect } from 'vitest'

import { createKimiProvider } from '../../src/providers/kimi.js'
import { priceProviderCall } from '../../src/pricing-pass.js'
import type { ParsedProviderCall, SessionSource } from '../../src/providers/types.js'

// Byte-identical parity gate for the kimi bridge migration (phase 8). The
// GOLDEN below was captured from the legacy in-CLI decode before the migration.

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = resolve(here, '../fixtures/kimi-parity')

const GOLDEN: ParsedProviderCall[] = [
  {
    provider: 'kimi',
    model: 'kimi-k2-thinking-turbo',
    inputTokens: 100,
    outputTokens: 40,
    cacheCreationInputTokens: 10,
    cacheReadInputTokens: 25,
    cachedInputTokens: 25,
    reasoningTokens: 0,
    webSearchRequests: 0,
    costBasis: 'estimated',
    // Kimi dedups per turn (Set): the repeated ReadFile and second Shell call
    // collapse, so tools and bashCommands stay unique.
    tools: ['Bash', 'Read'],
    bashCommands: ['git', 'npm'],
    timestamp: '2026-04-14T10:26:45.000Z',
    speed: 'standard',
    deduplicationKey: 'kimi:sess-1:msg-1',
    userMessage: 'add status endpoint',
    sessionId: 'sess-1',
  },
]

async function collect(): Promise<ParsedProviderCall[]> {
  const provider = createKimiProvider(FIXTURE_DIR)
  const sources: SessionSource[] = await provider.discoverSessions()
  sources.sort((a, b) => a.path.localeCompare(b.path))
  const seen = new Set<string>()
  const calls: ParsedProviderCall[] = []
  for (const source of sources) {
    for await (const call of provider.createSessionParser(source, seen).parse()) {
      calls.push(call)
    }
  }
  return calls
}

describe('kimi bridge — fixture parity', () => {
  it('the bridged provider reproduces the pre-migration decode byte-for-byte', async () => {
    expect(await collect()).toEqual(GOLDEN)
  })

  it('the priced output survives the pricing pass with only costUSD added', async () => {
    const raw = await collect()
    const priced = raw.map(priceProviderCall)
    priced.forEach((call, i) => {
      expect(typeof call.costUSD).toBe('number')
      expect(Number.isFinite(call.costUSD)).toBe(true)
      expect(call.costBasis).toBe('estimated')
      const { costUSD, ...rest } = call
      expect(rest).toEqual(raw[i])
    })
  })

  it('dedup threads through the host-owned seenKeys set', async () => {
    const provider = createKimiProvider(FIXTURE_DIR)
    const sources = await provider.discoverSessions()
    const seen = new Set<string>()
    const first: ParsedProviderCall[] = []
    for (const source of sources) {
      for await (const call of provider.createSessionParser(source, seen).parse()) first.push(call)
    }
    const second: ParsedProviderCall[] = []
    for (const source of sources) {
      for await (const call of provider.createSessionParser(source, seen).parse()) second.push(call)
    }
    expect(first.length).toBe(1)
    expect(second).toEqual([])
  })
})
