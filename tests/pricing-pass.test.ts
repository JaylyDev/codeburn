import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as models from '../src/models.js'
import { priceProviderCall } from '../src/pricing-pass.js'
import { createZerostackProvider } from '../src/providers/zerostack.js'
import type { ParsedProviderCall } from '../src/providers/types.js'

function baseCall(overrides: Partial<ParsedProviderCall> = {}): ParsedProviderCall {
  return {
    provider: 'test',
    model: 'claude-sonnet-4-5',
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
    tools: [],
    bashCommands: [],
    timestamp: '2026-07-17T00:00:00Z',
    speed: 'standard',
    deduplicationKey: 'k',
    userMessage: '',
    sessionId: 's',
    ...overrides,
  }
}

describe('priceProviderCall', () => {
  it("computes cost from tokens for costBasis 'estimated'", () => {
    const call = baseCall({ costBasis: 'estimated', reasoningTokens: 10, cacheReadInputTokens: 20 })
    const priced = priceProviderCall(call)
    // Reasoning is billed at the output rate, mirroring the pre-lift decoder call.
    expect(priced.costUSD).toBe(
      models.calculateCost('claude-sonnet-4-5', 100, 60, 0, 20, 0, 'standard'),
    )
    expect(priced.costUSD!).toBeGreaterThan(0)
  })

  it("passes a provider-reported cost through untouched for costBasis 'measured'", () => {
    const call = baseCall({ costBasis: 'measured', costUSD: 0.0042 })
    expect(priceProviderCall(call).costUSD).toBe(0.0042)
  })

  it('leaves an unconverted call (no costBasis) exactly as-is', () => {
    const call = baseCall({ costUSD: 0.99 })
    expect(priceProviderCall(call)).toBe(call)
  })
})

describe('decode determinism: tokens do not depend on pricing', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'pricing-pass-test-'))
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(tmpDir, { recursive: true, force: true })
  })

  const session = JSON.stringify({
    id: 'sess-det',
    name: '',
    messages: [
      { role: 'user', content: 'hello', estimated_tokens: 7 },
      { role: 'assistant', content: 'hi', estimated_tokens: 92 },
    ],
    compactions: [],
    created_at: '2026-06-19T11:33:34.022836+00:00',
    updated_at: '2026-06-19T11:34:14.140631+00:00',
    total_input_tokens: 34119,
    total_output_tokens: 961,
    model: 'deepseek/deepseek-v4-pro',
    provider: 'openrouter',
    working_dir: '/Users/test/myproject',
    permission_allowlist: [],
  })

  it('decodes tokens with pricing stubbed to throw, then prices separately', async () => {
    const path = join(tmpDir, 'sess-det.json')
    await writeFile(path, session)

    // Simulate the pricing table / network being unavailable during decode.
    const spy = vi.spyOn(models, 'calculateCost').mockImplementation(() => {
      throw new Error('pricing unavailable (network stubbed)')
    })

    const provider = createZerostackProvider(tmpDir)
    const source = { path, project: 'myproject', provider: 'zerostack' }
    const raw: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) {
      raw.push(call)
    }

    // Decoding produced tokens without ever consulting the pricing table.
    expect(spy).not.toHaveBeenCalled()
    expect(raw).toHaveLength(1)
    expect(raw[0]!.inputTokens).toBe(34119)
    expect(raw[0]!.outputTokens).toBe(961)
    expect(raw[0]!.costBasis).toBe('estimated')
    expect(raw[0]!.costUSD).toBeUndefined()

    // Cost is computed only afterwards, by the pass.
    spy.mockRestore()
    const priced = priceProviderCall(raw[0]!)
    expect(priced.costUSD).toBe(
      models.calculateCost('deepseek/deepseek-v4-pro', 34119, 961, 0, 0, 0, 'standard'),
    )
    expect(priced.costUSD!).toBeGreaterThan(0)
  })
})
