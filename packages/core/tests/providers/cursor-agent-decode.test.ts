import { describe, expect, it } from 'vitest'

import { decodeCursorAgent, toObservations } from '../../src/providers/cursor-agent/index.js'
import { ObservationEnvelope } from '../../src/observations.js'
import { OBSERVATION_SCHEMA_VERSION } from '../../src/schema.js'
import type { DecodeContext } from '../../src/contracts.js'
import type { CursorAgentRecord } from '../../src/providers/cursor-agent/types.js'

const context: DecodeContext = { privacyKey: 'k', providerId: 'cursor-agent', sourceRef: 'ref' }

function makeRecord(opts: {
  transcript: string
  transcriptPath?: string
  summaryModel?: string | null
  summaryUpdatedAt?: string | null
  fileMtime?: string
  conversationId?: string
}): CursorAgentRecord {
  return {
    summary: opts.summaryModel === undefined && opts.summaryUpdatedAt === undefined
      ? null
      : {
          conversationId: 'sess-a',
          model: opts.summaryModel ?? null,
          title: null,
          updatedAt: opts.summaryUpdatedAt ?? null,
        },
    transcript: opts.transcript,
    transcriptPath: opts.transcriptPath ?? '/data/projects/my-proj/agent-transcripts/123e4567-e89b-12d3-a456-426614174000.txt',
    fileMtime: opts.fileMtime ?? '2026-05-16T10:00:00.000Z',
    conversationId: opts.conversationId ?? '123e4567-e89b-12d3-a456-426614174000',
  }
}

describe('cursor-agent rich decode (moved to @codeburn/core)', () => {
  it('decodes a txt transcript into a cost-free rich call', () => {
    const { calls } = decodeCursorAgent({
      records: [makeRecord({ transcript: 'user:\n<user_query>explain parser output</user_query>\nA:\nfirst line\nsecond line\n' })],
      context,
    })

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.provider).toBe('cursor-agent')
    expect(call.model).toBe('cursor-agent-auto')
    expect(call.inputTokens).toBe(6)
    expect(call.outputTokens).toBe(6)
    expect(call.reasoningTokens).toBe(0)
    expect(call.cacheReadInputTokens).toBe(0)
    expect(call.cacheCreationInputTokens).toBe(0)
    expect(call.tools).toEqual([])
    expect(call.rawBashCommands).toEqual([])
    expect(call.userMessage).toBe('explain parser output')
    expect(call.deduplicationKey).toBe('cursor-agent:123e4567-e89b-12d3-a456-426614174000:0')
    expect(call.sessionId).toBe('123e4567-e89b-12d3-a456-426614174000')
    expect(call.speed).toBe('standard')
    expect(call.timestamp).toBe('2026-05-16T10:00:00.000Z')
    expect(call).not.toHaveProperty('costUSD')
    expect(call).not.toHaveProperty('costBasis')
  })

  it('uses summary model and updatedAt when present', () => {
    const { calls } = decodeCursorAgent({
      records: [makeRecord({
        transcript: 'user:\n<user_query>hello</user_query>\nA:\nworld\n',
        summaryModel: 'claude-4.6-sonnet',
        summaryUpdatedAt: '2025-01-01T00:00:00.000Z',
        fileMtime: '2026-05-16T10:00:00.000Z',
      })],
      context,
    })

    expect(calls[0]!.model).toBe('claude-4.6-sonnet')
    expect(calls[0]!.timestamp).toBe('2025-01-01T00:00:00.000Z')
  })

  it('falls back to fileMtime when summary updatedAt is absent', () => {
    const { calls } = decodeCursorAgent({
      records: [makeRecord({
        transcript: 'user:\n<user_query>hello</user_query>\nA:\nworld\n',
        summaryModel: 'claude-4.6-sonnet',
        summaryUpdatedAt: null,
        fileMtime: '2026-05-16T10:00:00.000Z',
      })],
      context,
    })

    expect(calls[0]!.timestamp).toBe('2026-05-16T10:00:00.000Z')
  })

  it('maps tools from txt [Tool call] markers', () => {
    const { calls } = decodeCursorAgent({
      records: [makeRecord({
        transcript: 'user:\n<user_query>run tools</user_query>\nA:\n[Tool call] Read file\n[Tool result] ok\n[Tool call] Run command\n',
      })],
      context,
    })

    expect(calls[0]!.tools).toEqual(['cursor:read-file', 'cursor:run-command'])
  })

  it('maps tools from jsonl tool_use blocks', () => {
    const { calls } = decodeCursorAgent({
      records: [makeRecord({
        transcriptPath: '/data/sess-a.jsonl',
        transcript: JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: '<user_query>run tools</user_query>' }] } }) + '\n' +
          JSON.stringify({ role: 'assistant', message: { content: [{ type: 'tool_use', name: 'EditFile' }, { type: 'text', text: 'done' }] } }),
      })],
      context,
    })

    expect(calls[0]!.tools).toEqual(['cursor:editfile'])
  })

  it('extracts reasoning from [Thinking] markers', () => {
    const { calls } = decodeCursorAgent({
      records: [makeRecord({
        transcript: 'user:\n<user_query>think</user_query>\nA:\n[Thinking] private reasoning\nvisible output\n',
      })],
      context,
    })

    expect(calls[0]!.reasoningTokens).toBeGreaterThan(0)
    expect(calls[0]!.outputTokens).toBeGreaterThan(0)
  })

  it('dedups repeated turns using the host-owned seenKeys set', () => {
    const seen = new Set<string>()
    const record = makeRecord({ transcript: 'user:\n<user_query>hello</user_query>\nA:\nworld\n' })
    const first = decodeCursorAgent({ records: [record], context, seenKeys: seen }).calls
    expect(first).toHaveLength(1)
    const again = decodeCursorAgent({ records: [record], context, seenKeys: seen }).calls
    expect(again).toEqual([])
  })

  it('skips unrecognized transcripts', () => {
    const { calls } = decodeCursorAgent({
      records: [makeRecord({ transcript: 'no markers in this transcript' })],
      context,
    })

    expect(calls).toEqual([])
  })

  it('skips jsonl transcripts with no recognizable turns', () => {
    const { calls } = decodeCursorAgent({
      records: [makeRecord({
        transcriptPath: '/data/sess-a.jsonl',
        transcript: '{"role":"system","message":{"content":[{"type":"text","text":"hello"}]}}',
      })],
      context,
    })

    expect(calls).toEqual([])
  })

  it('uses the host-supplied conversation id verbatim for session id and dedup key', () => {
    // Deriving the id from the transcript path (uuid stem vs sha1 fallback) is
    // host-side, so a single id is authoritative; the decoder never re-derives.
    const { calls } = decodeCursorAgent({
      records: [makeRecord({
        transcriptPath: '/data/projects/proj/agent-transcripts/not-a-uuid.txt',
        transcript: 'user:\n<user_query>hello</user_query>\nA:\nworld\n',
        conversationId: 'a1b2c3d4e5f60718',
      })],
      context,
    })

    expect(calls[0]!.sessionId).toBe('a1b2c3d4e5f60718')
    expect(calls[0]!.deduplicationKey).toBe('cursor-agent:a1b2c3d4e5f60718:0')
  })

  it('toObservations produces a schema-valid, content-free envelope', () => {
    const { calls } = decodeCursorAgent({
      records: [makeRecord({
        transcript: 'user:\n<user_query>hello</user_query>\nA:\nworld\n',
        summaryModel: 'claude-4.6-sonnet',
        summaryUpdatedAt: '2025-01-01T00:00:00.000Z',
      })],
      context,
    })

    const { sessions } = toObservations(
      { sessionId: '123e4567-e89b-12d3-a456-426614174000', projectPath: '/Users/me/projects/codeburn', calls },
      { privacyKey: 'test-privacy-key', provider: 'cursor-agent' },
    )

    const envelope = {
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      generator: { name: '@codeburn/core', version: '0.0.0-test' },
      fingerprints: { algorithm: 'hmac-sha256-128', keyId: 'test-key' },
      sessions,
    }

    expect(ObservationEnvelope.safeParse(envelope).success).toBe(true)
    expect(sessions[0]!.calls[0]!.costBasis).toBe('estimated')
  })
})
