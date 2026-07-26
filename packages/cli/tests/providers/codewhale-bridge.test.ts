import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

import { describe, it, expect } from 'vitest'

import { createCodeWhaleProvider } from '../../src/providers/codewhale.js'
import { priceProviderCall } from '../../src/pricing-pass.js'
import type { ParsedProviderCall, SessionSource, ToolCall } from '../../src/providers/types.js'

// Byte-identical parity gate for the codewhale bridge migration (phase 8). The
// GOLDEN below was captured from the legacy in-CLI decode before the migration.

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = resolve(here, '../fixtures/codewhale-parity/sessions')

const GOLDEN: ParsedProviderCall[] = [
  {
    provider: 'codewhale',
    model: 'anthropic/claude-sonnet-4-6',
    inputTokens: 12345,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 1,
    costUSD: 0.95,
    costBasis: 'measured',
    costIsEstimated: false,
    // CodeWhale dedups nothing: Read appears twice (two read_file calls) and
    // 'npm' repeats across `npm test && git status && npm run build`.
    tools: ['Read', 'Bash', 'Edit', 'Read', 'Skill', 'Agent', 'WebSearch'],
    bashCommands: ['npm', 'git', 'npm'],
    skills: ['typescript'],
    subagentTypes: ['reviewer'],
    timestamp: '2026-07-15T12:34:56.000Z',
    speed: 'standard',
    deduplicationKey: 'codewhale:session-full',
    turnId: 'session-full:session',
    toolSequence: [
      [
        { tool: 'Read', file: 'src/app.ts' },
        { tool: 'Bash', command: 'npm test && git status && npm run build' },
        { tool: 'Edit', file: 'src/app.ts' },
        { tool: 'Read', file: 'src/other.ts' },
      ] as ToolCall[],
      [
        { tool: 'Skill' },
        { tool: 'Agent' },
        { tool: 'WebSearch' },
      ] as ToolCall[],
    ],
    userMessage: 'Implement the parser',
    sessionId: 'session-full',
    project: 'codewhale-demo',
    projectPath: '/Users/alice/codewhale-demo',
  },
]

async function collect(): Promise<ParsedProviderCall[]> {
  const provider = createCodeWhaleProvider(FIXTURE_DIR)
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

describe('codewhale bridge — fixture parity', () => {
  it('the bridged provider reproduces the pre-migration decode byte-for-byte', async () => {
    expect(await collect()).toEqual(GOLDEN)
  })

  it('the priced output survives the pricing pass unchanged for measured cost', async () => {
    const raw = await collect()
    const priced = raw.map(priceProviderCall)
    priced.forEach((call, i) => {
      // Measured-cost calls already carry costUSD/costBasis; the pricing pass
      // leaves them untouched.
      expect(call).toEqual(raw[i])
    })
  })

  it('dedup threads through the host-owned seenKeys set', async () => {
    const provider = createCodeWhaleProvider(FIXTURE_DIR)
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
