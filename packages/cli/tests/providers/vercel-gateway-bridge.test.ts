import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { vercelGateway } from '../../src/providers/vercel-gateway.js'

const source = { path: 'vercel-ai-gateway:report', project: 'Vercel AI Gateway', provider: 'vercel-gateway' as const }

function sortedKeys(obj: object): string[] {
  return Object.keys(obj).sort()
}

const expectedKeys = [
  'bashCommands',
  'cacheCreationInputTokens',
  'cacheReadInputTokens',
  'cachedInputTokens',
  'costUSD',
  'deduplicationKey',
  'inputTokens',
  'model',
  'outputTokens',
  'project',
  'provider',
  'reasoningTokens',
  'sessionId',
  'speed',
  'timestamp',
  'tools',
  'userMessage',
  'webSearchRequests',
]

describe('vercel-gateway bridge golden (unmodified provider)', () => {
  const originalFetch = globalThis.fetch
  const originalKey = process.env.AI_GATEWAY_API_KEY

  beforeEach(() => {
    process.env.AI_GATEWAY_API_KEY = 'test-key'
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (originalKey === undefined) delete process.env.AI_GATEWAY_API_KEY
    else process.env.AI_GATEWAY_API_KEY = originalKey
    vi.restoreAllMocks()
  })

  const range = {
    start: new Date('2026-06-01T00:00:00.000Z'),
    end: new Date('2026-06-07T23:59:59.999Z'),
  }

  it('maps a normal multi-row report verbatim', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        results: [
          {
            day: '2026-06-01',
            model: 'anthropic/claude-sonnet-4.6',
            total_cost: 1.25,
            input_tokens: 1000,
            output_tokens: 200,
            cached_input_tokens: 50,
            cache_creation_input_tokens: 10,
            reasoning_tokens: 5,
            request_count: 3,
          },
          {
            day: '2026-06-02',
            model: 'openai/gpt-4o',
            total_cost: 0.75,
            input_tokens: 500,
            output_tokens: 100,
            request_count: 1,
          },
        ],
      }),
    })) as typeof fetch

    const calls: unknown[] = []
    for await (const call of vercelGateway.createSessionParser(source, new Set<string>(), range).parse()) {
      calls.push(call)
    }

    expect(calls).toHaveLength(2)
    expect(calls[0]).toStrictEqual({
      provider: 'vercel-gateway',
      model: 'anthropic/claude-sonnet-4.6',
      inputTokens: 1000,
      outputTokens: 200,
      cacheCreationInputTokens: 10,
      cacheReadInputTokens: 50,
      cachedInputTokens: 0,
      reasoningTokens: 5,
      webSearchRequests: 0,
      costUSD: 1.25,
      tools: [],
      bashCommands: [],
      timestamp: '2026-06-01T12:00:00.000Z',
      speed: 'standard',
      deduplicationKey: 'vercel-gateway:2026-06-01:anthropic/claude-sonnet-4.6',
      userMessage: '',
      sessionId: '2026-06-01:anthropic/claude-sonnet-4.6',
      project: 'Vercel AI Gateway',
    })
    expect(calls[1]).toStrictEqual({
      provider: 'vercel-gateway',
      model: 'openai/gpt-4o',
      inputTokens: 500,
      outputTokens: 100,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      costUSD: 0.75,
      tools: [],
      bashCommands: [],
      timestamp: '2026-06-02T12:00:00.000Z',
      speed: 'standard',
      deduplicationKey: 'vercel-gateway:2026-06-02:openai/gpt-4o',
      userMessage: '',
      sessionId: '2026-06-02:openai/gpt-4o',
      project: 'Vercel AI Gateway',
    })
    for (const call of calls) {
      expect(sortedKeys(call as object)).toStrictEqual(expectedKeys)
      expect(call).not.toHaveProperty('costBasis')
    }
  })

  it('skips all-zero rows BEFORE burning a dedup key', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        results: [
          { day: '2026-06-03', model: 'skip-before-dedup', total_cost: 0, input_tokens: 0, output_tokens: 0 },
          { day: '2026-06-03', model: 'skip-before-dedup', total_cost: 0.5, input_tokens: 10, output_tokens: 5 },
        ],
      }),
    })) as typeof fetch

    const seen = new Set<string>()
    const calls: unknown[] = []
    for await (const call of vercelGateway.createSessionParser(source, seen, range).parse()) {
      calls.push(call)
    }

    expect(calls).toHaveLength(1)
    expect((calls[0] as { costUSD: number }).costUSD).toBe(0.5)
    expect(seen.has('vercel-gateway:2026-06-03:skip-before-dedup')).toBe(true)
  })

  it('second pass with a shared seenKeys yields nothing', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        results: [{ day: '2026-06-04', model: 'dup', total_cost: 0.1, input_tokens: 1, output_tokens: 1 }],
      }),
    })) as typeof fetch

    const seen = new Set<string>(['vercel-gateway:2026-06-04:dup'])
    const calls: unknown[] = []
    for await (const call of vercelGateway.createSessionParser(source, seen, range).parse()) {
      calls.push(call)
    }
    expect(calls).toStrictEqual([])
    expect(seen.has('vercel-gateway:2026-06-04:dup')).toBe(true)
  })

  it('missing day keeps timestamp empty', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        results: [{ model: 'no-day', total_cost: 0.5, input_tokens: 10, output_tokens: 5 }],
      }),
    })) as typeof fetch

    const calls: unknown[] = []
    for await (const call of vercelGateway.createSessionParser(source, new Set<string>(), range).parse()) {
      calls.push(call)
    }

    expect(calls).toHaveLength(1)
    expect(calls[0]).toStrictEqual({
      provider: 'vercel-gateway',
      model: 'no-day',
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      costUSD: 0.5,
      tools: [],
      bashCommands: [],
      timestamp: '',
      speed: 'standard',
      deduplicationKey: 'vercel-gateway::no-day',
      userMessage: '',
      sessionId: ':no-day',
      project: 'Vercel AI Gateway',
    })
  })

  it('missing model defaults to unknown', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        results: [{ day: '2026-06-05', total_cost: 0.1, input_tokens: 1, output_tokens: 1 }],
      }),
    })) as typeof fetch

    const calls: unknown[] = []
    for await (const call of vercelGateway.createSessionParser(source, new Set<string>(), range).parse()) {
      calls.push(call)
    }

    expect(calls).toHaveLength(1)
    expect((calls[0] as { model: string }).model).toBe('unknown')
    expect((calls[0] as { sessionId: string }).sessionId).toBe('2026-06-05:unknown')
    expect((calls[0] as { deduplicationKey: string }).deduplicationKey).toBe('vercel-gateway:2026-06-05:unknown')
    expect(sortedKeys(calls[0] as object)).toStrictEqual(expectedKeys)
  })

  it('warns on a non-ok report and yields nothing', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 403,
      text: async () => 'forbidden detail',
    })) as unknown as typeof fetch
    const writes: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk))
      return true
    })

    const calls: unknown[] = []
    for await (const call of vercelGateway.createSessionParser(source, new Set<string>(), range).parse()) {
      calls.push(call)
    }

    expect(calls).toStrictEqual([])
    expect(writes).toStrictEqual([
      'codeburn: Vercel AI Gateway report failed (HTTP 403). ' +
        'Requires AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN (Pro/Enterprise for /v1/report). ' +
        'forbidden detail\n',
    ])
  })

  it('warns when the report is unreachable and yields nothing', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND ai-gateway.vercel.sh')
    }) as unknown as typeof fetch
    const writes: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk))
      return true
    })

    const calls: unknown[] = []
    for await (const call of vercelGateway.createSessionParser(source, new Set<string>(), range).parse()) {
      calls.push(call)
    }

    expect(calls).toStrictEqual([])
    expect(writes).toStrictEqual([
      'codeburn: Vercel AI Gateway report unreachable (getaddrinfo ENOTFOUND ai-gateway.vercel.sh).\n',
    ])
  })

  it('no dateRange yields nothing', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ results: [{ day: '2026-06-06', model: 'x', total_cost: 1, input_tokens: 1, output_tokens: 1 }] }),
    })) as typeof fetch

    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ results: [{ day: '2026-06-06', model: 'x', total_cost: 1, input_tokens: 1, output_tokens: 1 }] }),
    })) as unknown as typeof fetch
    globalThis.fetch = fetchSpy

    const calls: unknown[] = []
    for await (const call of vercelGateway.createSessionParser(source, new Set<string>(), undefined).parse()) {
      calls.push(call)
    }
    expect(calls).toStrictEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  // The discovered source is shared across the scan; parsing must not stash
  // per-run state (e.g. a date range) on it.
  it('does not mutate the discovered source', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ results: [{ day: '2026-06-07', model: 'm', total_cost: 1, input_tokens: 1, output_tokens: 1 }] }),
    })) as typeof fetch

    const fresh = { path: 'vercel-ai-gateway:report', project: 'Vercel AI Gateway', provider: 'vercel-gateway' as const }
    const before = Reflect.ownKeys(fresh)
    for await (const _call of vercelGateway.createSessionParser(fresh, new Set<string>(), range).parse()) {
      // drain
    }

    expect(Reflect.ownKeys(fresh)).toStrictEqual(before)
    expect(fresh).toStrictEqual({ path: 'vercel-ai-gateway:report', project: 'Vercel AI Gateway', provider: 'vercel-gateway' })
  })
})
