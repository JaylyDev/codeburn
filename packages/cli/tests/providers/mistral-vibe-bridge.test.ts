import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { createMistralVibeProvider } from '../../src/providers/mistral-vibe.js'
import { priceProviderCall } from '../../src/pricing-pass.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'mistral-vibe-bridge-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

function metadata(opts: {
  sessionId?: string
  cwd?: string
  input?: number
  output?: number
  sessionCost?: number
  inputPrice?: number
  outputPrice?: number
  activeModel?: string
  modelName?: string
  configInputPrice?: number
  configOutputPrice?: number
  endTime?: string | null
  title?: string
} = {}) {
  const activeModel = opts.activeModel ?? 'mistral-medium-3.5'
  return {
    session_id: opts.sessionId ?? 'session-abc123',
    start_time: '2026-05-11T10:00:00+00:00',
    end_time: Object.hasOwn(opts, 'endTime') ? opts.endTime : '2026-05-11T10:05:00+00:00',
    environment: {
      working_directory: opts.cwd ?? '/Users/test/mistral-project',
    },
    stats: {
      session_prompt_tokens: opts.input ?? 2000,
      session_completion_tokens: opts.output ?? 3000,
      session_cost: opts.sessionCost,
      input_price_per_million: opts.inputPrice ?? 1.5,
      output_price_per_million: opts.outputPrice ?? 7.5,
      tokens_per_second: 42,
    },
    config: {
      active_model: activeModel,
      models: [
        {
          alias: activeModel,
          name: opts.modelName ?? 'mistral-vibe-cli-latest',
          provider: 'mistral',
          input_price: opts.configInputPrice ?? 1.5,
          output_price: opts.configOutputPrice ?? 7.5,
        },
      ],
    },
    title: opts.title ?? 'implement mistral support',
    total_messages: 2,
  }
}

function userMessage(content: unknown = 'implement mistral support', messageId = 'msg-user-1') {
  return {
    role: 'user',
    content,
    message_id: messageId,
  }
}

function assistantMessage(content = 'Done', messageId = 'msg-assistant-1') {
  return {
    role: 'assistant',
    content,
    message_id: messageId,
    tool_calls: [],
  }
}

async function writeSession(
  name: string,
  meta: Record<string, unknown>,
  messages: Record<string, unknown>[],
  root = tmpDir,
) {
  const sessionDir = join(root, name)
  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, 'meta.json'), JSON.stringify(meta, null, 2))
  await writeFile(join(sessionDir, 'messages.jsonl'), messages.map(m => JSON.stringify(m)).join('\n') + '\n')
  return sessionDir
}

async function buildFixtures(): Promise<void> {
  await writeSession(
    'session_20260511_100000_remainder',
    metadata({
      sessionId: 'session-remainder',
      input: 100,
      output: 100,
      sessionCost: 0.1,
      title: 'remainder session',
    }),
    [
      userMessage('first turn', 'msg-user-1'),
      assistantMessage('a1', 'msg-assistant-1'),
      userMessage('second turn', 'msg-user-2'),
      assistantMessage('a2', 'msg-assistant-2'),
      userMessage('third turn', 'msg-user-3'),
      assistantMessage('a3', 'msg-assistant-3'),
    ],
  )

  await writeSession(
    'session_20260511_100001_zero',
    metadata({
      sessionId: 'session-zero-cost',
      input: 1000,
      output: 1000,
      sessionCost: 0,
      title: 'zero cost session',
    }),
    [userMessage('zero cost turn', 'msg-user-1'), assistantMessage('z1', 'msg-assistant-1')],
  )

  await writeSession(
    'session_20260511_100002_single',
    metadata({
      sessionId: 'session-single',
      input: 2000,
      output: 3000,
      sessionCost: 0.0255,
      title: 'single assistant session',
    }),
    [userMessage('single turn', 'msg-user-1'), assistantMessage('s1', 'msg-assistant-1')],
  )
}

async function collect(provider = createMistralVibeProvider(tmpDir)): Promise<ParsedProviderCall[]> {
  const sources = await provider.discoverSessions()
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

// Byte-identical parity gate for the mistral-vibe bridge migration (phase 8,
// Category A / JSONL). The GOLDEN below was captured from the unmodified legacy
// in-CLI decode. Allocation remainders, the session_cost > 0 gate, and the
// single-assistant path are all pinned exactly as the original emits them.
const GOLDEN: ParsedProviderCall[] = [
  {
    provider: 'mistral-vibe',
    model: 'mistral-medium-3.5',
    inputTokens: 34,
    outputTokens: 34,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
    costUSD: 0.03333333333333333,
    costBasis: 'measured',
    tools: [],
    bashCommands: [],
    timestamp: '2026-05-11T10:05:00+00:00',
    speed: 'standard',
    deduplicationKey: 'mistral-vibe:session-remainder:msg-assistant-1',
    turnId: 'session-remainder:turn-0',
    userMessage: 'first turn',
    sessionId: 'session-remainder',
  },
  {
    provider: 'mistral-vibe',
    model: 'mistral-medium-3.5',
    inputTokens: 33,
    outputTokens: 33,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
    costUSD: 0.03333333333333333,
    costBasis: 'measured',
    tools: [],
    bashCommands: [],
    timestamp: '2026-05-11T10:05:00+00:00',
    speed: 'standard',
    deduplicationKey: 'mistral-vibe:session-remainder:msg-assistant-2',
    turnId: 'session-remainder:turn-1',
    userMessage: 'second turn',
    sessionId: 'session-remainder',
  },
  {
    provider: 'mistral-vibe',
    model: 'mistral-medium-3.5',
    inputTokens: 33,
    outputTokens: 33,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
    costUSD: 0.03333333333333333,
    costBasis: 'measured',
    tools: [],
    bashCommands: [],
    timestamp: '2026-05-11T10:05:00+00:00',
    speed: 'standard',
    deduplicationKey: 'mistral-vibe:session-remainder:msg-assistant-3',
    turnId: 'session-remainder:turn-2',
    userMessage: 'third turn',
    sessionId: 'session-remainder',
  },
  {
    provider: 'mistral-vibe',
    model: 'mistral-medium-3.5',
    inputTokens: 1000,
    outputTokens: 1000,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
    costUSD: 0.009,
    costBasis: 'measured',
    tools: [],
    bashCommands: [],
    timestamp: '2026-05-11T10:05:00+00:00',
    speed: 'standard',
    deduplicationKey: 'mistral-vibe:session-zero-cost:msg-assistant-1',
    turnId: 'session-zero-cost:turn-0',
    userMessage: 'zero cost turn',
    sessionId: 'session-zero-cost',
  },
  {
    provider: 'mistral-vibe',
    model: 'mistral-medium-3.5',
    inputTokens: 2000,
    outputTokens: 3000,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
    costUSD: 0.0255,
    costBasis: 'measured',
    tools: [],
    bashCommands: [],
    timestamp: '2026-05-11T10:05:00+00:00',
    speed: 'standard',
    deduplicationKey: 'mistral-vibe:session-single:msg-assistant-1',
    turnId: 'session-single:turn-0',
    userMessage: 'single turn',
    sessionId: 'session-single',
  },
]

describe('mistral-vibe bridge — fixture parity', () => {
  it('the unmodified provider reproduces the golden decode byte-for-byte', async () => {
    await buildFixtures()
    expect(await collect()).toEqual(GOLDEN)
  })

  it('cost keys are present exactly as the original emits them', async () => {
    await buildFixtures()
    const calls = await collect()
    expect(calls.length).toBe(5)
    calls.forEach(call => {
      expect(call.costBasis).toBe('measured')
      expect(typeof call.costUSD).toBe('number')
      expect(Number.isFinite(call.costUSD)).toBe(true)
      expect(Object.hasOwn(call, 'costUSD')).toBe(true)
    })
  })

  it('the pricing pass leaves measured costUSD untouched', async () => {
    await buildFixtures()
    const raw = await collect()
    const priced = raw.map(priceProviderCall)
    priced.forEach((call, i) => {
      expect(call.costBasis).toBe('measured')
      expect(call.costUSD).toBe(raw[i]!.costUSD)
      expect(call).toEqual(raw[i])
    })
  })

  it('discovery, I/O, and dedup stay CLI-side; the shared seenKeys set dedups', async () => {
    await buildFixtures()
    const provider = createMistralVibeProvider(tmpDir)
    const sources = await provider.discoverSessions()
    sources.sort((a, b) => a.path.localeCompare(b.path))
    const seen = new Set<string>()
    const first: ParsedProviderCall[] = []
    for (const source of sources) {
      for await (const call of provider.createSessionParser(source, seen).parse()) first.push(call)
    }
    const second: ParsedProviderCall[] = []
    for (const source of sources) {
      for await (const call of provider.createSessionParser(source, seen).parse()) second.push(call)
    }
    expect(first).toEqual(GOLDEN)
    expect(second).toEqual([])
  })
})

// ── Adversarial allocation arms ─────────────────────────────────────────────
//
// Every value below was captured by running the UNMODIFIED f4f4dcca decode
// (checked out in place) over these exact fixtures. They pin the arms the first
// golden does not reach: an odd integer split with a remainder smaller than the
// message count, a total smaller than the count, the terminal zero-cost arm
// (no session_cost, no Vibe prices, model absent from the price table), the
// `session_id`-absent directory-basename fallback, the no-assistant session-level
// arm (which emits NO `turnId` key at all), and `idx-N` dedup keys.

async function writeRaw(name: string, meta: Record<string, unknown>, messages: Record<string, unknown>[]) {
  const sessionDir = join(tmpDir, name)
  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, 'meta.json'), JSON.stringify(meta, null, 2))
  await writeFile(join(sessionDir, 'messages.jsonl'), messages.map(m => JSON.stringify(m)).join('\n') + '\n')
}

function advMeta(over: Record<string, unknown>): Record<string, unknown> {
  return {
    session_id: 'sess',
    start_time: '2026-05-11T10:00:00+00:00',
    end_time: '2026-05-11T10:05:00+00:00',
    environment: { working_directory: '/Users/test/mistral-project' },
    config: {
      active_model: 'mistral-medium-3.5',
      models: [{ alias: 'mistral-medium-3.5', name: 'mistral-vibe-cli-latest', input_price: 1.5, output_price: 7.5 }],
    },
    title: 'a title',
    ...over,
  }
}

const advUser = (text: string, id: string) => ({ role: 'user', content: text, message_id: id })
const advAssistant = (id: string | null) => ({
  role: 'assistant',
  content: 'ok',
  ...(id ? { message_id: id } : {}),
  tool_calls: [],
})

async function buildAdversarialFixtures(): Promise<void> {
  await writeRaw('b1_seven_over_three', advMeta({
    session_id: 'alloc-7-over-3',
    stats: { session_prompt_tokens: 7, session_completion_tokens: 2, session_cost: 1 },
  }), [advUser('u', 'u1'), advAssistant('a1'), advAssistant('a2'), advAssistant('a3')])

  await writeRaw('b2_one_over_three', advMeta({
    session_id: 'alloc-1-over-3',
    stats: { session_prompt_tokens: 1, session_completion_tokens: 0, session_cost: 0.1 },
  }), [advUser('u', 'u1'), advAssistant('a1'), advAssistant('a2'), advAssistant('a3')])

  await writeRaw('b3_zero_terminal', advMeta({
    session_id: 'alloc-zero-cost',
    stats: { session_prompt_tokens: 1000, session_completion_tokens: 1000 },
    config: {
      active_model: 'totally-unknown-model-xyz',
      models: [{ alias: 'totally-unknown-model-xyz', name: 'totally-unknown-model-xyz' }],
    },
  }), [advUser('zero', 'u1'), advAssistant('a1'), advAssistant('a2')])

  await writeRaw('b4_no_session_id', advMeta({
    session_id: undefined,
    stats: { session_prompt_tokens: 10, session_completion_tokens: 10, session_cost: 0.02 },
  }), [advUser('no id', 'u1'), advAssistant('a1'), advAssistant('a2')])

  await writeRaw('b5_no_assistant', advMeta({
    session_id: 'alloc-no-assistant',
    stats: { session_prompt_tokens: 55, session_completion_tokens: 55, session_cost: 0.004 },
  }), [advUser('only user text', 'u1')])

  await writeRaw('b6_no_message_ids', advMeta({
    session_id: 'alloc-idx-keys',
    stats: { session_prompt_tokens: 5, session_completion_tokens: 5, session_cost: 0.3 },
  }), [advUser('x', 'u1'), advAssistant(null), advAssistant(null)])

  // Float-op-order discriminator for the ALLOCATION: 0.005 / 3 and
  // 0.005 * (1 / 3) differ in the last bit, so this pins the division order.
  await writeRaw('b7_float_alloc', advMeta({
    session_id: 'alloc-float-order',
    stats: { session_prompt_tokens: 30, session_completion_tokens: 30, session_cost: 0.005 },
  }), [advUser('f', 'u1'), advAssistant('a1'), advAssistant('a2'), advAssistant('a3')])

  // Float-op-order discriminator for the HOST price branch:
  // (1000/1e6)*0.3 + (1000/1e6)*0.9 !== (1000*0.3 + 1000*0.9)/1e6.
  await writeRaw('b8_float_price', advMeta({
    session_id: 'price-float-order',
    stats: {
      session_prompt_tokens: 1000, session_completion_tokens: 1000, session_cost: 0,
      input_price_per_million: 0.3, output_price_per_million: 0.9,
    },
  }), [advUser('p', 'u1'), advAssistant('a1')])
}

const ADVERSARIAL_TOKENS: Array<[string, number, number]> = [
  // 7 over 3 -> 3,2,2 (remainder to the FIRST messages); 2 over 3 -> 1,1,0.
  ['mistral-vibe:alloc-7-over-3:a1', 3, 1],
  ['mistral-vibe:alloc-7-over-3:a2', 2, 1],
  ['mistral-vibe:alloc-7-over-3:a3', 2, 0],
  // 1 over 3 -> 1,0,0; 0 over 3 -> 0,0,0.
  ['mistral-vibe:alloc-1-over-3:a1', 1, 0],
  ['mistral-vibe:alloc-1-over-3:a2', 0, 0],
  ['mistral-vibe:alloc-1-over-3:a3', 0, 0],
  ['mistral-vibe:alloc-zero-cost:a1', 500, 500],
  ['mistral-vibe:alloc-zero-cost:a2', 500, 500],
  ['mistral-vibe:b4_no_session_id:a1', 5, 5],
  ['mistral-vibe:b4_no_session_id:a2', 5, 5],
  ['mistral-vibe:alloc-no-assistant', 55, 55],
  ['mistral-vibe:alloc-idx-keys:idx-0', 3, 3],
  ['mistral-vibe:alloc-idx-keys:idx-1', 2, 2],
  ['mistral-vibe:alloc-float-order:a1', 10, 10],
  ['mistral-vibe:alloc-float-order:a2', 10, 10],
  ['mistral-vibe:alloc-float-order:a3', 10, 10],
  ['mistral-vibe:price-float-order:a1', 1000, 1000],
]

const ADVERSARIAL_COSTS: Array<[string, number]> = [
  ['mistral-vibe:alloc-7-over-3:a1', 0.3333333333333333],
  ['mistral-vibe:alloc-7-over-3:a2', 0.3333333333333333],
  ['mistral-vibe:alloc-7-over-3:a3', 0.3333333333333333],
  ['mistral-vibe:alloc-1-over-3:a1', 0.03333333333333333],
  ['mistral-vibe:alloc-1-over-3:a2', 0.03333333333333333],
  ['mistral-vibe:alloc-1-over-3:a3', 0.03333333333333333],
  // Terminal arm: nothing resolves a price, so the session cost is 0 — and the
  // call still carries costUSD: 0 with costBasis 'measured'.
  ['mistral-vibe:alloc-zero-cost:a1', 0],
  ['mistral-vibe:alloc-zero-cost:a2', 0],
  ['mistral-vibe:b4_no_session_id:a1', 0.01],
  ['mistral-vibe:b4_no_session_id:a2', 0.01],
  ['mistral-vibe:alloc-no-assistant', 0.004],
  ['mistral-vibe:alloc-idx-keys:idx-0', 0.15],
  ['mistral-vibe:alloc-idx-keys:idx-1', 0.15],
  // Last-bit exact: division, not multiplication by the reciprocal.
  ['mistral-vibe:alloc-float-order:a1', 0.0016666666666666668],
  ['mistral-vibe:alloc-float-order:a2', 0.0016666666666666668],
  ['mistral-vibe:alloc-float-order:a3', 0.0016666666666666668],
  // Last-bit exact: the host price branch divides each bucket by 1e6 BEFORE
  // multiplying by its price, then sums.
  ['mistral-vibe:price-float-order:a1', 0.0012000000000000001],
]

describe('mistral-vibe bridge — adversarial allocation parity', () => {
  it('splits integer totals exactly as the original did (remainder to the FIRST messages)', async () => {
    await buildAdversarialFixtures()
    const byKey = new Map((await collect()).map(c => [c.deduplicationKey, c]))
    expect(byKey.size).toBe(ADVERSARIAL_TOKENS.length)
    for (const [key, input, output] of ADVERSARIAL_TOKENS) {
      const call = byKey.get(key)
      expect(call, key).toBeDefined()
      expect([key, call!.inputTokens, call!.outputTokens]).toEqual([key, input, output])
    }
  })

  it('splits the session dollar figure exactly as the original did', async () => {
    await buildAdversarialFixtures()
    const byKey = new Map((await collect()).map(c => [c.deduplicationKey, c]))
    for (const [key, cost] of ADVERSARIAL_COSTS) {
      expect([key, byKey.get(key)!.costUSD]).toEqual([key, cost])
    }
  })

  it('emits costUSD + costBasis on every arm, including the terminal zero-cost arm', async () => {
    await buildAdversarialFixtures()
    for (const call of await collect()) {
      expect(Object.hasOwn(call, 'costUSD')).toBe(true)
      expect(Object.hasOwn(call, 'costBasis')).toBe(true)
      expect(call.costBasis).toBe('measured')
      expect(typeof call.costUSD).toBe('number')
    }
  })

  it('falls back to the session directory basename when meta.json omits session_id', async () => {
    await buildAdversarialFixtures()
    const calls = (await collect()).filter(c => c.sessionId === 'b4_no_session_id')
    expect(calls).toHaveLength(2)
    expect(calls.map(c => c.turnId)).toEqual(['b4_no_session_id:turn-0', 'b4_no_session_id:turn-0'])
  })

  it('the no-assistant arm omits the turnId key entirely', async () => {
    await buildAdversarialFixtures()
    const call = (await collect()).find(c => c.deduplicationKey === 'mistral-vibe:alloc-no-assistant')!
    expect(Object.hasOwn(call, 'turnId')).toBe(false)
    expect(Object.keys(call).sort()).toEqual([
      'bashCommands', 'cacheCreationInputTokens', 'cacheReadInputTokens', 'cachedInputTokens',
      'costBasis', 'costUSD', 'deduplicationKey', 'inputTokens', 'model', 'outputTokens',
      'provider', 'reasoningTokens', 'sessionId', 'speed', 'timestamp', 'tools',
      'userMessage', 'webSearchRequests',
    ])
    const withTurn = (await collect()).find(c => c.deduplicationKey === 'mistral-vibe:alloc-idx-keys:idx-0')!
    expect(Object.hasOwn(withTurn, 'turnId')).toBe(true)
  })
})
