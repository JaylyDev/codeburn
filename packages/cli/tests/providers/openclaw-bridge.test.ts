import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

import { describe, it, expect } from 'vitest'

import { createOpenClawProvider } from '../../src/providers/openclaw.js'
import { priceProviderCall } from '../../src/pricing-pass.js'
import type { ParsedProviderCall, SessionSource } from '../../src/providers/types.js'

// Byte-identical parity gate for the openclaw bridge migration. The GOLDEN below
// was captured from the legacy in-CLI decode before the migration; the bridged
// provider (discovery + I/O CLI-side, pure decode in @codeburn/core/providers/openclaw)
// must reproduce it exactly. The fixture exercises model_change fallbacks, the
// provider-reported measured-cost path, tool mapping, bash extraction, and dedup.

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = resolve(here, '../fixtures/openclaw-parity/.openclaw/agents')

const GOLDEN: ParsedProviderCall[] = [
  {
    provider: 'openclaw',
    model: 'claude-sonnet-4-6',
    inputTokens: 500,
    outputTokens: 100,
    cacheCreationInputTokens: 50,
    cacheReadInputTokens: 200,
    cachedInputTokens: 200,
    reasoningTokens: 0,
    webSearchRequests: 0,
    costBasis: 'estimated',
    tools: [],
    bashCommands: [],
    timestamp: '2026-04-20T10:00:03.000Z',
    speed: 'standard',
    deduplicationKey: 'openclaw:test-sess-1:a1',
    userMessage: 'hello world',
    sessionId: 'test-sess-1',
  },
  {
    provider: 'openclaw',
    model: 'claude-sonnet-4-6',
    inputTokens: 600,
    outputTokens: 200,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 100,
    cachedInputTokens: 100,
    reasoningTokens: 0,
    webSearchRequests: 0,
    costUSD: 0.05,
    costBasis: 'measured',
    tools: ['Bash', 'Write'],
    bashCommands: ['ls'],
    timestamp: '2026-04-20T10:00:05.000Z',
    speed: 'standard',
    deduplicationKey: 'openclaw:test-sess-1:a2',
    userMessage: '',
    sessionId: 'test-sess-1',
  },
]

async function collect(): Promise<ParsedProviderCall[]> {
  const provider = createOpenClawProvider(FIXTURE_DIR)
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

describe('openclaw bridge — fixture parity', () => {
  it('the bridged provider reproduces the pre-migration decode byte-for-byte', async () => {
    expect(await collect()).toEqual(GOLDEN)
  })

  it('the priced output preserves the measured cost and leaves everything else unchanged', async () => {
    const raw = await collect()
    const priced = raw.map(priceProviderCall)
    priced.forEach((call, i) => {
      expect(typeof call.costUSD).toBe('number')
      expect(Number.isFinite(call.costUSD)).toBe(true)
      expect(call.costBasis).toBe(raw[i]!.costBasis)
      if (raw[i]!.costBasis === 'measured') {
        // For measured calls the parse already carries the provider-reported
        // cost; the pricing pass must leave the call byte-identical.
        expect(call).toEqual(raw[i])
      } else {
        // For estimated calls the pass adds exactly costUSD.
        const { costUSD, ...rest } = call
        expect(rest).toEqual(raw[i])
      }
    })
    // The provider-reported cost survives unchanged through the pricing pass.
    expect(priced[1]!.costUSD).toBe(0.05)
    expect(priced[1]!.costBasis).toBe('measured')
  })

  it('discovery, I/O, and dedup stay CLI-side; the shared seenKeys set dedups', async () => {
    const provider = createOpenClawProvider(FIXTURE_DIR)
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
    expect(first.length).toBe(2)
    expect(second).toEqual([])
  })

  // The session-init entry may omit its id (or be absent). The legacy decode
  // fell back to `basename(path, '.jsonl')`, which strips the extension; the
  // bridge must match, since sessionId flows into the dedup key.
  it('falls back to the extension-stripped filename when the session id is missing', async () => {
    const NOID_DIR = resolve(here, '../fixtures/openclaw-parity-noid/.openclaw/agents')
    const provider = createOpenClawProvider(NOID_DIR)
    const sources = await provider.discoverSessions()
    const seen = new Set<string>()
    const calls: ParsedProviderCall[] = []
    for (const source of sources) {
      for await (const call of provider.createSessionParser(source, seen).parse()) calls.push(call)
    }
    expect(calls).toEqual([
      {
        provider: 'openclaw',
        model: 'claude-x',
        inputTokens: 5,
        outputTokens: 5,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        webSearchRequests: 0,
        costBasis: 'estimated',
        tools: ['Bash'],
        bashCommands: ['echo'],
        timestamp: '2026-04-20T10:00:03.000Z',
        speed: 'standard',
        deduplicationKey: 'openclaw:anon-session:a1',
        userMessage: 'do work',
        sessionId: 'anon-session',
      },
    ])
  })
})
