import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { describe, it, expect } from 'vitest'

import { createMuxProvider } from '../../src/providers/mux.js'
import { priceProviderCall } from '../../src/pricing-pass.js'
import type { ParsedProviderCall, SessionSource } from '../../src/providers/types.js'

// Byte-identical parity gate for the mux bridge migration (phase 8). Mux is not
// in the frozen corpus, so a committed fixture golden is THE parity gate: the
// bridged provider (discovery + JSONL I/O CLI-side, pure decode delegated to
// @codeburn/core/providers/mux) must reproduce exactly what the pre-migration
// in-CLI decode produced. Covers: inclusive input/output token decomposition
// (cache read+creation out of input, reasoning out of output), provider-prefix
// stripping for the model, tool mapping (file_read->Read, bash->Bash),
// extractBashCommands over `&&`, workspace-vs-subagent dedup keys derived from
// the source path, user-prompt pairing, and the model fallback for a sub-agent.
const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = resolve(here, '../fixtures/mux-parity')

const GOLDEN: ParsedProviderCall[] = [
  {
    provider: 'mux',
    model: 'claude-opus-4-8',
    inputTokens: 750,
    outputTokens: 200,
    cacheCreationInputTokens: 50,
    cacheReadInputTokens: 200,
    cachedInputTokens: 200,
    reasoningTokens: 30,
    webSearchRequests: 0,
    costBasis: 'estimated',
    tools: ['Read', 'Bash'],
    bashCommands: ['git', 'bun'],
    timestamp: new Date(1776023230000).toISOString(),
    speed: 'standard',
    deduplicationKey: 'mux:ws-abc:msg-1',
    userMessage: 'implement the feature',
    sessionId: 'ws-abc',
  },
  {
    provider: 'mux',
    model: 'claude-sonnet-4-6',
    inputTokens: 500,
    outputTokens: 100,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
    costBasis: 'estimated',
    tools: [],
    bashCommands: [],
    timestamp: new Date(1776023240000).toISOString(),
    speed: 'standard',
    deduplicationKey: 'mux:child-a:c1',
    userMessage: '',
    sessionId: 'child-a',
  },
]

async function collect(seen = new Set<string>()): Promise<ParsedProviderCall[]> {
  const provider = createMuxProvider(FIXTURE_DIR)
  const sources: SessionSource[] = await provider.discoverSessions()
  sources.sort((a, b) => a.path.localeCompare(b.path))
  const calls: ParsedProviderCall[] = []
  for (const source of sources) {
    for await (const call of provider.createSessionParser(source, seen).parse()) calls.push(call)
  }
  return calls
}

describe('mux bridge — fixture parity', () => {
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
