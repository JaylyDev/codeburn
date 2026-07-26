import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

import { describe, it, expect } from 'vitest'

import { createKimicodeProvider } from '../../src/providers/kimicode.js'
import { priceProviderCall } from '../../src/pricing-pass.js'
import type { ParsedProviderCall, SessionSource } from '../../src/providers/types.js'

// Byte-identical parity gate for the kimicode bridge migration (phase 8). The
// GOLDEN below was captured from the legacy in-CLI decode (git show
// origin/feat/core-extraction:packages/cli/src/providers/kimicode.ts) run over the
// committed fixture home. Covers: model-alias resolution (usage.model -> real
// model from an earlier llm.request), the `kimicode:<sid>:<agent>:<lineIndex>:
// <ordinal>` dedup key whose lineIndex counts BLANK lines (fixture line 7 is
// blank, shifting call 2 to line 10), tools/bash carried as FLAT un-deduped lists
// (two identical `ls -la` Bash calls stay two `ls`), and the three-tier timestamp
// fallback — record.time, then request.time, then state.json updatedAt (call 3
// omits both and resolves to the state's 10:05:00 updatedAt).

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE_HOME = resolve(here, '../fixtures/kimicode-parity/home')

async function collect(): Promise<ParsedProviderCall[]> {
  const provider = createKimicodeProvider(FIXTURE_HOME)
  const sources: SessionSource[] = await provider.discoverSessions()
  const seen = new Set<string>()
  const calls: ParsedProviderCall[] = []
  for (const source of sources) {
    for await (const call of provider.createSessionParser(source, seen).parse()) calls.push(call)
  }
  return calls
}

const GOLDEN: ParsedProviderCall[] = [
  {
    provider: 'kimicode',
    model: 'kimi-k2',
    inputTokens: 100,
    outputTokens: 40,
    cacheCreationInputTokens: 5,
    cacheReadInputTokens: 10,
    cachedInputTokens: 10,
    reasoningTokens: 0,
    webSearchRequests: 0,
    costBasis: 'estimated',
    costIsEstimated: true,
    tools: ['Bash', 'Bash', 'Read'],
    bashCommands: ['ls', 'ls'],
    timestamp: '2026-07-01T10:00:02.000Z',
    speed: 'standard',
    deduplicationKey: 'kimicode:S1:agentA:6:0',
    turnId: '1',
    userMessage: 'first prompt',
    sessionId: 'S1',
    project: 'myproj',
    projectPath: '/work/myproj',
  },
  {
    provider: 'kimicode',
    model: 'kimi-k2-turbo',
    inputTokens: 200,
    outputTokens: 80,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
    costBasis: 'estimated',
    costIsEstimated: true,
    tools: [],
    bashCommands: [],
    timestamp: '2026-07-01T10:00:03.000Z',
    speed: 'standard',
    deduplicationKey: 'kimicode:S1:agentA:10:1',
    turnId: '2',
    userMessage: 'second prompt',
    sessionId: 'S1',
    project: 'myproj',
    projectPath: '/work/myproj',
  },
  {
    provider: 'kimicode',
    model: 'kimi-k2',
    inputTokens: 5,
    outputTokens: 5,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
    costBasis: 'estimated',
    costIsEstimated: true,
    tools: [],
    bashCommands: [],
    // record.time and request.time both absent -> state.json updatedAt.
    timestamp: '2026-07-01T10:05:00.000Z',
    speed: 'standard',
    deduplicationKey: 'kimicode:S1:agentA:13:2',
    turnId: '3',
    userMessage: 'third prompt',
    sessionId: 'S1',
    project: 'myproj',
    projectPath: '/work/myproj',
  },
]

describe('kimicode bridge — fixture parity', () => {
  it('the bridged provider reproduces the pre-migration decode byte-for-byte', async () => {
    expect(await collect()).toEqual(GOLDEN)
  })

  it('the priced output survives the pricing pass with only costUSD added', async () => {
    const raw = await collect()
    const priced = raw.map(priceProviderCall)
    priced.forEach((call, i) => {
      expect(typeof call.costUSD).toBe('number')
      expect(Number.isFinite(call.costUSD)).toBe(true)
      const { costUSD, ...rest } = call
      expect(rest).toEqual(raw[i])
    })
  })

  it('dedup threads through the host-owned seenKeys set', async () => {
    const provider = createKimicodeProvider(FIXTURE_HOME)
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
    expect(first).toHaveLength(3)
    expect(second).toEqual([])
  })
})
