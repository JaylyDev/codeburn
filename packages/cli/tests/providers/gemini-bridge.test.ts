import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

import { describe, it, expect } from 'vitest'

import { createGeminiProvider } from '../../src/providers/gemini.js'
import { priceProviderCall } from '../../src/pricing-pass.js'
import type { ParsedProviderCall, SessionSource } from '../../src/providers/types.js'

// Byte-identical parity gate for the gemini bridge migration (phase 8). The
// GOLDEN below was captured from the legacy in-CLI decode (git show
// origin/feat/core-extraction:packages/cli/src/providers/gemini.ts) run over the
// committed fixtures. Covers: single-JSON (<=0.38) vs headerless JSONL (>=0.39)
// parsing incl. the `$set` skip, cached-token subtraction from fresh input, the
// tool-name map with Set-dedup on BOTH tools and bash base names, the zero-token
// gemini-message skip, per-message dedup key, turn threading, and the timestamp
// fallback to the session startTime when a message omits its own timestamp.

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = resolve(here, '../fixtures/gemini-parity')

// Gemini discovery keys off ~/.gemini/tmp (no dir override), so the parity gate
// drives the parser directly over the committed fixture files — that is the
// read + decode + map path where every migration risk lives.
function sources(): SessionSource[] {
  return [
    { path: resolve(FIXTURE_DIR, 'single.json'), project: 'proj', provider: 'gemini' },
    { path: resolve(FIXTURE_DIR, 'jsonl.jsonl'), project: 'proj', provider: 'gemini' },
  ].sort((a, b) => a.path.localeCompare(b.path))
}

const GOLDEN: ParsedProviderCall[] = [
  {
    provider: 'gemini',
    model: 'gemini-auto',
    inputTokens: 50,
    outputTokens: 5,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
    costBasis: 'estimated',
    tools: [],
    bashCommands: [],
    timestamp: '2026-06-02T09:00:00.000Z',
    speed: 'standard',
    deduplicationKey: 'gemini:gsess-2:g1',
    turnId: 'gsess-2:turn-0',
    userMessage: 'hello',
    sessionId: 'gsess-2',
  },
  {
    provider: 'gemini',
    model: 'gemini-3.1-pro-preview',
    inputTokens: 100,
    outputTokens: 30,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 20,
    cachedInputTokens: 20,
    reasoningTokens: 5,
    webSearchRequests: 0,
    costBasis: 'estimated',
    // Set-deduped: [Read,Bash,Bash,Read] -> [Read,Bash]; git repeated across
    // `git status && git log` + `git diff` -> single 'git'.
    tools: ['Read', 'Bash'],
    bashCommands: ['git'],
    timestamp: '2026-06-01T10:00:05.000Z',
    speed: 'standard',
    deduplicationKey: 'gemini:gsess-1:g1',
    turnId: 'gsess-1:turn-0',
    userMessage: 'inspect the repo',
    sessionId: 'gsess-1',
  },
  {
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    inputTokens: 0,
    outputTokens: 10,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
    costBasis: 'estimated',
    tools: [],
    bashCommands: [],
    timestamp: '2026-06-01T10:01:05.000Z',
    speed: 'standard',
    deduplicationKey: 'gemini:gsess-1:g2',
    turnId: 'gsess-1:turn-1',
    userMessage: 'run tests',
    sessionId: 'gsess-1',
  },
]

async function collect(): Promise<ParsedProviderCall[]> {
  const provider = createGeminiProvider()
  const seen = new Set<string>()
  const calls: ParsedProviderCall[] = []
  for (const source of sources()) {
    for await (const call of provider.createSessionParser(source, seen).parse()) calls.push(call)
  }
  return calls
}

describe('gemini bridge — fixture parity', () => {
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
    const provider = createGeminiProvider()
    const seen = new Set<string>()
    const first: ParsedProviderCall[] = []
    for (const source of sources()) {
      for await (const call of provider.createSessionParser(source, seen).parse()) first.push(call)
    }
    const second: ParsedProviderCall[] = []
    for (const source of sources()) {
      for await (const call of provider.createSessionParser(source, seen).parse()) second.push(call)
    }
    expect(first).toHaveLength(3)
    expect(second).toEqual([])
  })
})
