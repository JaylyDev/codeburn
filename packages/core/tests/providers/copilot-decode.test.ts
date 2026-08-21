import { createHash } from 'node:crypto'

import { describe, it, expect } from 'vitest'
import { collectJetBrainsRepoDirCandidates, decodeCopilot } from '../../src/providers/copilot/decode.js'
import type { CopilotRecordEnvelope } from '../../src/providers/copilot/types.js'

const ctx = { privacyKey: 'test-key', providerId: 'copilot', sourceRef: 'ref' }

describe('decodeCopilot — jsonl arm', () => {
  it('skips a zero-token assistant.message in non-transcript format', () => {
    const envelope: CopilotRecordEnvelope = {
      kind: 'jsonl',
      sessionId: 's1',
      lines: [
        JSON.stringify({ type: 'user.message', data: { content: 'hello' } }),
        JSON.stringify({ type: 'assistant.message', data: { messageId: 'm1', outputTokens: 0 } }),
      ],
    }
    const seen = new Set<string>()
    const { calls } = decodeCopilot({ records: [envelope], context: ctx, seenKeys: seen })
    expect(calls).toHaveLength(0)
    expect(seen.size).toBe(0)
  })

  it('falls back to model from session.start and preserves pendingUserMessage across skipped messages', () => {
    const envelope: CopilotRecordEnvelope = {
      kind: 'jsonl',
      sessionId: 's1',
      lines: [
        JSON.stringify({ type: 'session.start', data: { selectedModel: 'gpt-4.1' } }),
        JSON.stringify({ type: 'user.message', data: { content: 'pending message' } }),
        JSON.stringify({ type: 'assistant.message', data: { messageId: 'skip', outputTokens: 0 } }),
        JSON.stringify({ type: 'assistant.message', data: { messageId: 'keep', outputTokens: 10 } }),
      ],
    }
    const seen = new Set<string>()
    const { calls } = decodeCopilot({ records: [envelope], context: ctx, seenKeys: seen })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.userMessage).toBe('pending message')
    expect(calls[0]?.model).toBe('gpt-4.1')
    expect(seen.has('copilot:s1:keep')).toBe(true)
  })

  it('dedups by message id and tags the arm', () => {
    const envelope: CopilotRecordEnvelope = {
      kind: 'jsonl',
      sessionId: 's1',
      lines: [
        JSON.stringify({ type: 'assistant.message', data: { messageId: 'm1', outputTokens: 10, model: 'gpt-4.1' } }),
        JSON.stringify({ type: 'assistant.message', data: { messageId: 'm1', outputTokens: 20, model: 'gpt-5' } }),
      ],
    }
    const seen = new Set<string>()
    const { calls } = decodeCopilot({ records: [envelope], context: ctx, seenKeys: seen })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.arm).toBe('jsonl-turn')
    expect(calls[0]?.outputTokens).toBe(10)
    expect(seen.size).toBe(1)
  })

  it('emits a shutdown arm with cache-inclusive input tokens priced separately', () => {
    const envelope: CopilotRecordEnvelope = {
      kind: 'jsonl',
      sessionId: 's1',
      lines: [
        JSON.stringify({ type: 'assistant.message', data: { messageId: 'm1', outputTokens: 10 } }),
        JSON.stringify({
          type: 'session.shutdown',
          data: {
            modelMetrics: {
              'gpt-4.1': {
                usage: { inputTokens: 1100, cacheReadTokens: 100, cacheWriteTokens: 50, reasoningTokens: 5 },
              },
            },
          },
        }),
      ],
    }
    const seen = new Set<string>()
    const { calls } = decodeCopilot({ records: [envelope], context: ctx, seenKeys: seen })
    const shutdown = calls.find(c => c.arm === 'jsonl-shutdown')
    expect(shutdown).toBeDefined()
    expect(shutdown?.inputTokens).toBe(950) // 1100 - 100 - 50
    expect(shutdown?.cacheReadInputTokens).toBe(100)
    expect(shutdown?.cacheCreationInputTokens).toBe(50)
    expect(shutdown?.reasoningTokens).toBe(5)
    expect(shutdown?.outputTokens).toBe(0)
    expect(seen.has('copilot:s1:shutdown:gpt-4.1')).toBe(true)
  })

  it('skips shutdown when all cache/input tokens are zero', () => {
    const envelope: CopilotRecordEnvelope = {
      kind: 'jsonl',
      sessionId: 's1',
      lines: [
        JSON.stringify({
          type: 'session.shutdown',
          data: {
            modelMetrics: {
              'gpt-4.1': { usage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
            },
          },
        }),
      ],
    }
    const { calls } = decodeCopilot({ records: [envelope], context: ctx })
    expect(calls).toHaveLength(0)
  })

  it('skips transcript files with no inferable model', () => {
    const envelope: CopilotRecordEnvelope = {
      kind: 'jsonl',
      sessionId: 's1',
      lines: [
        JSON.stringify({ type: 'session.start', data: { producer: 'copilot-agent' } }),
        JSON.stringify({ type: 'assistant.message', data: { messageId: 'm1' } }),
      ],
    }
    const { calls } = decodeCopilot({ records: [envelope], context: ctx })
    expect(calls).toHaveLength(0)
  })
})

describe('decodeCopilot — chatsession arm', () => {
  it('replays a kind-0/1/2 journal and skips zero-token requests', () => {
    const envelope: CopilotRecordEnvelope = {
      kind: 'chatsession',
      fallbackSessionId: 'fallback',
      project: 'myproject',
      content: [
        JSON.stringify({ kind: 0, v: { version: 3, creationDate: 1780157113020, sessionId: 'cs1', requests: [] } }),
        JSON.stringify({ kind: 1, k: ['requests'], v: [{ requestId: 'r1', modelId: 'copilot/gpt-4.1', timestamp: 1780157113100, result: { metadata: { promptTokens: 100, outputTokens: 10 } } }] }),
        JSON.stringify({ kind: 2, k: ['requests'], v: [{ requestId: 'r2', modelId: 'copilot/gpt-4.1', timestamp: 1780157113200, result: { metadata: { promptTokens: 0, outputTokens: 0 } } }] }),
      ].join('\n'),
    }
    const seen = new Set<string>()
    const { calls } = decodeCopilot({ records: [envelope], context: ctx, seenKeys: seen })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.arm).toBe('chatsession')
    expect(calls[0]?.model).toBe('gpt-4.1')
    expect(calls[0]?.sessionId).toBe('cs1')
    expect(seen.has('copilot-chatsession:cs1:r1')).toBe(true)
    expect(seen.has('copilot-chatsession:cs1:r2')).toBe(false)
  })
})

/** One JetBrains nitrite page holding a single ask-mode turn. */
function jetBrainsRaw(replyText: string, userMessage: string): string {
  const convGuid = '11111111-1111-1111-1111-111111111111'
  const convRecord = `$${convGuid}t\x00\x04namesq\x00\x01?@\x00\x00w\x00\x00t\x00value t\x00${userMessage}t\x00\x06sourcet\x00copilotx`
  const innerMd = { type: 'Markdown', data: JSON.stringify({ text: replyText, annotations: [] }) }
  const valueMap: Record<string, unknown> = {
    'a1b2c3d4-0000-0000-0000-000000000001': { type: 'Value', value: JSON.stringify(innerMd) },
  }
  const blob = JSON.stringify({ __first__: { type: 'Subgraph', value: JSON.stringify(valueMap) } })
  return 'H:2,block:9,blockSize:1000,format:3\n' +
    'com.github.copilot.agent.session.persistence.nitrite.entity.NtAgentTurn\n' +
    convRecord + '\n' + blob + '\n' + blob + '\n'
}

describe('decodeCopilot — jetbrains arm', () => {
  it('extracts an ask-mode turn and dedups by content hash', () => {
    const raw = jetBrainsRaw('Ask reply', 'Hello World')
    const envelope: CopilotRecordEnvelope = {
      kind: 'jetbrains',
      sessionId: 'jb1',
      mtime: '2026-07-17T10:00:00.000Z',
      raw,
      repoRootByDir: new Map(),
    }
    const seen = new Set<string>()
    const { calls } = decodeCopilot({ records: [envelope], context: ctx, seenKeys: seen })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.arm).toBe('jetbrains')
    expect(calls[0]?.outputTokens).toBe(3) // ceil("Ask reply".length / 4) = 3
    expect(calls[0]?.userMessage).toBe('Hello World')
  })

  it('keys the per-turn content digest with the privacy key: same input, different keys => different dedup key', () => {
    // The JetBrains dedup key embeds a digest of the assistant REPLY TEXT and
    // ships on the observation envelope. An unkeyed sha256 of a short reply
    // ("OK", "Done.") is dictionary-attackable, so the digest is an HMAC under
    // the host privacy key. This test is the mutation gate: swap createHmac
    // back to createHash in decode.ts and the two keys below become equal (and
    // equal to the bare sha256 pinned at the end), so it fails.
    const raw = jetBrainsRaw('Ask reply', 'Hello World')
    const envelope = (): CopilotRecordEnvelope => ({
      kind: 'jetbrains',
      sessionId: 'jb1',
      mtime: '2026-07-17T10:00:00.000Z',
      raw,
      repoRootByDir: new Map(),
    })
    const keyFor = (privacyKey: string): string => {
      const { calls } = decodeCopilot({
        records: [envelope()],
        context: { privacyKey, providerId: 'copilot', sourceRef: 'ref' },
        seenKeys: new Set<string>(),
      })
      expect(calls).toHaveLength(1) // non-vacuous: a decode that emits nothing proves nothing
      return calls[0]!.deduplicationKey
    }

    expect(() => keyFor('')).toThrow(/privacyKey is required/) // never a degenerate key

    const keyA = keyFor('privacy-key-A')
    const keyB = keyFor('privacy-key-B')

    expect(keyA).not.toBe(keyB)
    expect(keyA).toBe(keyFor('privacy-key-A')) // deterministic under one key
    expect(keyA).toMatch(/^copilot:jb:[^:]+:[0-9a-f]{12}:1$/)

    // Direct anti-createHash pin: the digest component must NOT be the unkeyed
    // sha256 of the reply text.
    const unkeyed = createHash('sha256').update('Ask reply').digest('hex').slice(0, 12)
    expect(keyA).not.toContain(unkeyed)
    expect(keyB).not.toContain(unkeyed)
  })
})

describe('decodeCopilot — otel arm', () => {
  it('skips zero-token chat spans and records tool/subagent metadata per trace', () => {
    const envelope: CopilotRecordEnvelope = {
      kind: 'otel',
      conversations: [{
        conversationId: 'conv1',
        project: 'myproject',
        spans: [
          {
            spanId: 'span-chat',
            traceId: 'trace1',
            operationName: 'chat',
            startTimeMs: 1000,
            responseModel: 'gpt-4.1',
            attrs: {
              'gen_ai.response.model': 'gpt-4.1',
              'gen_ai.usage.input_tokens': 100,
              'gen_ai.usage.output_tokens': 50,
            },
          },
          {
            spanId: 'span-tool',
            traceId: 'trace1',
            operationName: 'execute_tool',
            startTimeMs: 1100,
            responseModel: null,
            attrs: {
              'gen_ai.tool.name': 'bash',
              'gen_ai.tool.call.arguments': JSON.stringify({ command: 'ls -la' }),
            },
          },
          {
            spanId: 'span-zero',
            traceId: 'trace1',
            operationName: 'chat',
            startTimeMs: 1200,
            responseModel: 'gpt-4.1',
            attrs: {
              'gen_ai.usage.input_tokens': 0,
              'gen_ai.usage.output_tokens': 0,
            },
          },
          {
            spanId: 'span-subagent',
            traceId: 'trace1',
            operationName: 'invoke_agent',
            startTimeMs: 1300,
            responseModel: null,
            attrs: {
              'gen_ai.agent.name': 'Explore',
              'copilot_chat.parent_chat_session_id': 'parent1',
            },
          },
          {
            spanId: 'span-root-agent',
            traceId: 'trace2',
            operationName: 'invoke_agent',
            startTimeMs: 1400,
            responseModel: null,
            attrs: {
              'gen_ai.agent.name': 'GitHub Copilot Chat',
            },
          },
        ],
      }],
    }
    const seen = new Set<string>()
    const { calls } = decodeCopilot({ records: [envelope], context: ctx, seenKeys: seen })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.arm).toBe('otel')
    expect(calls[0]?.tools).toEqual(['Bash'])
    expect(calls[0]?.rawBashCommands).toEqual(['ls -la'])
    expect(calls[0]?.subagentTypes).toEqual(['Explore'])
    expect(seen.has('copilot-otel:span-chat')).toBe(true)
    expect(seen.has('copilot-otel:span-zero')).toBe(false)
  })
})

describe('collectJetBrainsRepoDirCandidates', () => {
  // The scanner must be a SUPERSET of the per-chunk `file://(/[^"\\]+?)(?:\\|")`
  // walk the decoder runs: the host resolves each candidate to a repo root, and
  // a dir the scanner misses degrades to "no project" instead of the real repo.
  const perChunkScan = (raw: string): string[] => {
    const re = /file:\/\/(\/[^"\\]+?)(?:\\|")/g
    const dirs = new Set<string>()
    let m: RegExpExecArray | null
    while ((m = re.exec(raw))) {
      let p = m[1]!
      try { p = decodeURIComponent(p) } catch { /* leave as-is */ }
      const dir = p.slice(0, p.lastIndexOf('/'))
      if (dir.startsWith('/')) dirs.add(dir)
    }
    return [...dirs]
  }

  const raws = [
    '{"data":"file:///home/user/repo/src/Main.java"}',
    '{"data":"file:///home/user/pipe|repo/src/Main.java"}',
    '{"data":"file:///home/user/my%20repo/src/Main.java"}',
    '{"a":"file:///one/a.ts\\\\","b":"file:///two/b.ts"}',
    'file://file:///nested/c.ts"',
    '{"data":"file:///no-terminator/d.ts',
    'no file uris here at all',
  ]

  for (const raw of raws) {
    it(`covers every dir the per-chunk scan finds: ${JSON.stringify(raw).slice(0, 48)}`, () => {
      const candidates = new Set(collectJetBrainsRepoDirCandidates(raw))
      for (const dir of perChunkScan(raw)) expect(candidates.has(dir)).toBe(true)
    })
  }

  it('keeps a pipe character inside the path', () => {
    expect(collectJetBrainsRepoDirCandidates('{"d":"file:///home/pipe|repo/src/Main.java"}'))
      .toEqual(['/home/pipe|repo/src'])
  })
})

describe('decodeCopilot — otel cross-source dedup side effect (O17)', () => {
  it('adds copilot:<conv>:<turnId> to seenKeys without emitting a call', () => {
    const envelope: CopilotRecordEnvelope = {
      kind: 'otel',
      conversations: [{
        conversationId: 'conv1',
        project: 'p',
        spans: [{
          spanId: 'span-a', traceId: 't1', operationName: 'chat', startTimeMs: 1000, responseModel: 'gpt-4.1',
          attrs: { 'gen_ai.usage.input_tokens': 5, 'gen_ai.usage.output_tokens': 1, 'github.copilot.chat.turn.id': 'turn-9' },
        }],
      }],
    }
    const seen = new Set<string>()
    const { calls } = decodeCopilot({ records: [envelope], context: ctx, seenKeys: seen })
    expect(calls).toHaveLength(1)
    expect([...seen].sort()).toEqual(['copilot-otel:span-a', 'copilot:conv1:turn-9'])
  })

  it('emits a span shared by two conversations only once (O21)', () => {
    const span = {
      spanId: 'span-shared', traceId: 't1', operationName: 'chat', startTimeMs: 1000, responseModel: 'gpt-4.1',
      attrs: { 'gen_ai.usage.input_tokens': 5, 'gen_ai.usage.output_tokens': 1 },
    }
    const envelope: CopilotRecordEnvelope = {
      kind: 'otel',
      conversations: [
        { conversationId: 'conv-a', project: 'p', spans: [span] },
        { conversationId: 'conv-b', project: 'p', spans: [span] },
      ],
    }
    const { calls } = decodeCopilot({ records: [envelope], context: ctx })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.sessionId).toBe('conv-a')
  })
})
