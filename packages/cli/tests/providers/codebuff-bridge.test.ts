// FIRST import: pins the host privacy key before anything reads it, so the
// dedup-key fingerprint below is a constant rather than a per-run random.
import '../setup/fixed-privacy-key.js'

import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

import { describe, it, expect } from 'vitest'

import { createCodebuffProvider } from '../../src/providers/codebuff.js'
import { priceProviderCall } from '../../src/pricing-pass.js'
import { expectedSourceRef } from '../setup/fixed-privacy-key.js'
import type { ParsedProviderCall, SessionSource } from '../../src/providers/types.js'

// Byte-identical parity gate for the codebuff bridge migration. The GOLDEN below
// was captured from the legacy in-CLI decode before the migration; the bridged
// provider (discovery + I/O CLI-side, pure decode in @codeburn/core/providers/codebuff)
// must reproduce it exactly, EXCEPT the dedup key, which deliberately changed:
// it used to embed the absolute chat-dir path (dedupKey ships on the observation
// envelope, so that was a raw host path riding a payload) and now embeds a keyed
// fingerprint of it. The expected fingerprint is re-derived longhand from a
// pinned key (expectedSourceRef) rather than by calling the production helper,
// so this golden pins the encoding instead of agreeing with itself.

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = resolve(here, '../fixtures/codebuff-parity/manicode')

function expectedGolden(sourcePath: string): ParsedProviderCall[] {
  const chatRef = expectedSourceRef(sourcePath)
  return [
    {
      provider: 'codebuff',
      model: 'codebuff-base2',
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      costBasis: 'estimated',
      fallbackCostUSD: 0.42,
      tools: ['Read', 'Edit', 'Bash', 'Read', 'Bash'],
      bashCommands: ['npm', 'npm'],
      timestamp: '2026-04-14T10:00:30.000Z',
      speed: 'standard',
      deduplicationKey: `codebuff:${chatRef}:a1`,
      userMessage: 'implement the feature',
      sessionId: 'manicode/2026-04-14T10-00-00.000Z',
    },
    {
      provider: 'codebuff',
      model: 'claude-haiku-4-5-20251001',
      inputTokens: 5000,
      outputTokens: 2000,
      cacheCreationInputTokens: 1000,
      cacheReadInputTokens: 500,
      cachedInputTokens: 500,
      reasoningTokens: 0,
      webSearchRequests: 0,
      costBasis: 'estimated',
      fallbackCostUSD: 0.1,
      tools: [],
      bashCommands: [],
      timestamp: '2026-04-14T10:01:30.000Z',
      speed: 'standard',
      deduplicationKey: `codebuff:${chatRef}:a2`,
      userMessage: 'fix the bug',
      sessionId: 'manicode/2026-04-14T10-00-00.000Z',
    },
    {
      provider: 'codebuff',
      model: 'openai/gpt-4o',
      inputTokens: 2000,
      outputTokens: 800,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 400,
      cachedInputTokens: 400,
      reasoningTokens: 0,
      webSearchRequests: 0,
      costBasis: 'estimated',
      fallbackCostUSD: 0.07,
      tools: [],
      bashCommands: [],
      timestamp: '2026-04-14T10:02:00.000Z',
      speed: 'standard',
      deduplicationKey: `codebuff:${chatRef}:a3`,
      userMessage: '',
      sessionId: 'manicode/2026-04-14T10-00-00.000Z',
    },
  ]
}

async function collect(): Promise<{ calls: ParsedProviderCall[]; sourcePath: string }> {
  const provider = createCodebuffProvider(FIXTURE_DIR)
  const sources: SessionSource[] = await provider.discoverSessions()
  expect(sources).toHaveLength(1)
  const sourcePath = sources[0]!.path
  const seen = new Set<string>()
  const calls: ParsedProviderCall[] = []
  for await (const call of provider.createSessionParser(sources[0]!, seen).parse()) {
    calls.push(call)
  }
  return { calls, sourcePath }
}

describe('codebuff bridge — fixture parity', () => {
  it('the bridged provider reproduces the pre-migration decode byte-for-byte', async () => {
    const { calls, sourcePath } = await collect()
    expect(calls).toEqual(expectedGolden(sourcePath))
  })

  it('the dedup key is an opaque fingerprint, never the chat-dir path', async () => {
    const { calls, sourcePath } = await collect()
    expect(calls.length).toBeGreaterThan(0) // non-vacuous
    for (const call of calls) {
      expect(call.deduplicationKey).toMatch(/^codebuff:[0-9a-f]{16}:a[0-9]+$/)
      expect(call.deduplicationKey).not.toContain(sourcePath)
      expect(call.deduplicationKey).not.toContain('codebuff-parity')
    }
  })

  it('the priced output survives the pricing pass; credit fallback is used when table price is zero', async () => {
    const { calls } = await collect()
    const priced = calls.map(priceProviderCall)
    priced.forEach((call, i) => {
      expect(typeof call.costUSD).toBe('number')
      expect(Number.isFinite(call.costUSD)).toBe(true)
      const raw = calls[i]!
      expect(call.costBasis).toBe(raw.costBasis)
      // Every field except the added costUSD must stay byte-identical.
      const { costUSD, ...rest } = call
      expect(rest).toEqual(raw)
    })
    // The token-less codebuff-base2 call has no table price, so the credit
    // fallback becomes the final cost.
    expect(priced[0]!.costUSD).toBeCloseTo(0.42, 6)
    // The Claude/GPT calls have known table prices that beat their credit fallback.
    expect(priced[1]!.costUSD).not.toBeCloseTo(0.1, 6)
    expect(priced[2]!.costUSD).not.toBeCloseTo(0.07, 6)
  })

  it('discovery, I/O, and dedup stay CLI-side; the shared seenKeys set dedups', async () => {
    const provider = createCodebuffProvider(FIXTURE_DIR)
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
    expect(first.length).toBe(3)
    expect(second).toEqual([])
  })
})
