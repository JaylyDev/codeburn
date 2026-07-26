import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

import { describe, it, expect } from 'vitest'

import { createQwenProvider } from '../../src/providers/qwen.js'
import { priceProviderCall } from '../../src/pricing-pass.js'
import type { ParsedProviderCall, SessionSource } from '../../src/providers/types.js'

// Byte-identical parity gate for the qwen bridge migration (phase 8.1). Qwen is
// not present in the frozen corpus (no qwen data), so a committed fixture golden
// is THE parity gate: the bridged provider (discovery + I/O CLI-side, pure decode
// delegated to @codeburn/core/providers/qwen) must reproduce exactly what the
// pre-migration in-CLI decode produced. The GOLDEN below was captured from the
// legacy provider before the migration.

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = resolve(here, '../fixtures/qwen-parity')

// The exact ParsedProviderCall stream the pre-migration qwen decode produced for
// the fixture: user-message attribution (thought parts filtered), tool mapping
// (read_file->Read, execute_command->Bash, write_to_file->Write, unknown passes
// through), bash base-name extraction, uuid dedup (the second a-1 drops), the
// zero-token skip, cached/reasoning buckets, and the 'qwen-auto' model fallback.
const GOLDEN: ParsedProviderCall[] = [
  {
    provider: 'qwen',
    model: 'qwen3-coder-plus',
    inputTokens: 1200,
    outputTokens: 340,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 800,
    cachedInputTokens: 800,
    reasoningTokens: 90,
    webSearchRequests: 0,
    costBasis: 'estimated',
    tools: ['Read', 'Bash'],
    bashCommands: ['npm', 'vitest'],
    timestamp: '2026-05-16T10:00:05.000Z',
    speed: 'standard',
    deduplicationKey: 'qwen:sess-alpha:a-1',
    userMessage: 'please fix the parser and run the tests',
    sessionId: 'sess-alpha',
  },
  {
    provider: 'qwen',
    model: 'qwen-auto',
    inputTokens: 500,
    outputTokens: 120,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
    costBasis: 'estimated',
    tools: ['Write', 'some_native_tool'],
    bashCommands: [],
    timestamp: '2026-05-16T10:01:05.000Z',
    speed: 'standard',
    deduplicationKey: 'qwen:sess-alpha:a-2',
    userMessage: 'now write the changelog',
    sessionId: 'sess-alpha',
  },
]

async function collect(): Promise<ParsedProviderCall[]> {
  const provider = createQwenProvider(FIXTURE_DIR)
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

describe('qwen bridge — fixture parity', () => {
  it('the bridged provider reproduces the pre-migration decode byte-for-byte', async () => {
    expect(await collect()).toEqual(GOLDEN)
  })

  it('the priced output survives the pricing pass with only costUSD added', async () => {
    const raw = await collect()
    const priced = raw.map(priceProviderCall)
    // Raw parity is byte-identical (test above) and priceProviderCall is
    // deterministic, so priced parity follows. The pass adds exactly costUSD
    // (a finite number) and leaves every other field — including the
    // 'estimated' marker — untouched.
    priced.forEach((call, i) => {
      expect(typeof call.costUSD).toBe('number')
      expect(Number.isFinite(call.costUSD)).toBe(true)
      expect(call.costBasis).toBe('estimated')
      const { costUSD, ...rest } = call
      expect(rest).toEqual(raw[i])
    })
  })

  it('discovery, I/O, and dedup stay CLI-side; the shared seenKeys set dedups', async () => {
    // A second scan sharing the SAME seenKeys set must yield nothing (every call
    // already seen), proving dedup threads through the host-owned set.
    const provider = createQwenProvider(FIXTURE_DIR)
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
})
