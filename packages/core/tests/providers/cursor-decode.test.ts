import { describe, expect, it } from 'vitest'

import {
  contentTextLength,
  decodeCursor,
  extractLanguages,
  parseComposerIdFromKey,
  toObservations,
} from '../../src/providers/cursor/index.js'
import { ObservationEnvelope } from '../../src/observations.js'
import { OBSERVATION_SCHEMA_VERSION } from '../../src/schema.js'
import type { DecodeContext } from '../../src/contracts.js'
import type {
  CursorAgentKvRow,
  CursorBubbleRow,
} from '../../src/providers/cursor/index.js'

const context: DecodeContext = { privacyKey: 'k', providerId: 'cursor', sourceRef: 'ref' }

function b(opts: Partial<CursorBubbleRow> & { bubble_key: string }): CursorBubbleRow {
  return {
    input_tokens: null,
    output_tokens: null,
    model: null,
    created_at: '2026-07-17T10:00:00.000Z',
    request_id: null,
    user_text: null,
    text_length: null,
    bubble_type: 2,
    code_blocks: null,
    ...opts,
  }
}

const AGENT_KV_TS = '2026-07-17T10:00:00.000Z'

// -----------------------------------------------------------------------------
// C1 — parseComposerIdFromKey
// -----------------------------------------------------------------------------
describe('cursor core decode: parseComposerIdFromKey', () => {
  it('returns null when there is no colon', () => {
    expect(parseComposerIdFromKey('bubbleId')).toBeNull()
  })

  it('returns null when there is only one colon', () => {
    expect(parseComposerIdFromKey('bubbleId:composer')).toBeNull()
  })

  it('returns null when the composer segment is empty', () => {
    expect(parseComposerIdFromKey('bubbleId::uuid')).toBeNull()
  })

  it('rejects a composer segment containing CR', () => {
    expect(parseComposerIdFromKey('bubbleId:task-call_x\rfc_y:b')).toBeNull()
  })

  it('rejects a composer segment containing LF', () => {
    expect(parseComposerIdFromKey('bubbleId:task-call_x\nfc_y:b')).toBeNull()
  })

  it('rejects a composer segment containing NUL', () => {
    expect(parseComposerIdFromKey('bubbleId:task-call_x\x00fc_y:b')).toBeNull()
  })

  it('extracts a valid composer id', () => {
    expect(parseComposerIdFromKey('bubbleId:composer-1:uuid')).toBe('composer-1')
  })
})

// -----------------------------------------------------------------------------
// C2 — extractLanguages
// -----------------------------------------------------------------------------
describe('cursor core decode: extractLanguages', () => {
  it('excludes plaintext and preserves other languages', () => {
    expect(extractLanguages(JSON.stringify([{ languageId: 'plaintext' }, { languageId: 'ts' }]))).toEqual(['ts'])
  })

  it('deduplicates languages while preserving order', () => {
    expect(extractLanguages(JSON.stringify([{ languageId: 'ts' }, { languageId: 'ts' }, { languageId: 'js' }]))).toEqual([
      'ts',
      'js',
    ])
  })

  it('returns empty array for non-array JSON', () => {
    expect(extractLanguages(JSON.stringify({ languageId: 'ts' }))).toEqual([])
  })

  it('returns empty array for malformed JSON', () => {
    expect(extractLanguages('not json')).toEqual([])
  })

  it('returns empty array for null input', () => {
    expect(extractLanguages(null)).toEqual([])
  })
})

// -----------------------------------------------------------------------------
// C3 — contentTextLength
// -----------------------------------------------------------------------------
describe('cursor core decode: contentTextLength', () => {
  it('sums block.text in a block array', () => {
    expect(contentTextLength(JSON.stringify([{ text: 'hello' }, { text: 'world' }]))).toBe(10)
  })

  it('falls back to block.content when text is absent', () => {
    expect(contentTextLength(JSON.stringify([{ content: 'foo' }]))).toBe(3)
  })

  it('counts only text when both text and content are present', () => {
    expect(contentTextLength(JSON.stringify([{ text: 'ab', content: 'xyz' }]))).toBe(2)
  })

  it('returns raw length when JSON starts with [ but cannot be parsed', () => {
    const raw = '[not json'
    expect(contentTextLength(raw)).toBe(raw.length)
  })

  it('returns raw length for a plain string', () => {
    expect(contentTextLength('plain text')).toBe(10)
  })

  it('returns zero for a block with neither text nor content', () => {
    expect(contentTextLength(JSON.stringify([{}]))).toBe(0)
  })
})

// -----------------------------------------------------------------------------
// C4 — agentKv fold
// -----------------------------------------------------------------------------
describe('cursor core decode: agentKv fold', () => {
  it('flushes pending chars, resets on system rows, drops orphan tool rows, captures model once, and keeps empty Uint8Array but skips empty string', () => {
    const agentKvRows: CursorAgentKvRow[] = [
      // Pending context/user chars before any requestId appears.
      { role: 'system', content: 'sys-pending', request_id: null, model: null },
      { role: 'user', content: 'user-pending', request_id: null, model: null },
      // Empty TEXT row sets the requestId but is skipped; flush still happens.
      { role: 'user', content: '', request_id: 'req-1', model: null },
      // Real user row: model captured here.
      { role: 'user', content: 'after-flush', request_id: 'req-1', model: 'claude-4.6-sonnet' },
      // Second model is ignored once captured.
      { role: 'user', content: 'ignored-model', request_id: 'req-1', model: 'gpt-5' },
      // System row resets currentRequestId to null and buffers its context for
      // the next requestId (req-2) via the pending-flush mechanism.
      { role: 'system', content: 'boundary', request_id: null, model: null },
      // Orphan tool row (no currentRequestId) is dropped.
      { role: 'tool', content: 'orphan', request_id: null, model: null },
      // Empty BLOB is truthy and kept; empty TEXT is falsy and skipped.
      { role: 'user', content: new Uint8Array(0), request_id: 'req-2', model: null },
      { role: 'user', content: '', request_id: 'req-2', model: null },
      { role: 'user', content: 'real', request_id: 'req-2', model: null },
    ]

    const { calls } = decodeCursor({
      bubbles: [],
      agentKvRows,
      userMessageRows: [],
      composerMetaRows: [],
      agentKvTimestamp: AGENT_KV_TS,
      context,
    })

    // Both requests are unjoined (no bubbles mapped them to a composer).
    expect(calls).toHaveLength(2)

    const req1 = calls.find(c => c.sessionId === 'req-1')
    const req2 = calls.find(c => c.sessionId === 'req-2')
    expect(req1).toBeDefined()
    expect(req2).toBeDefined()

    // req-1: pending flushed + after-flush + ignored-model; model captured once.
    expect(req1!.model).toBe('claude-4.6-sonnet')
    expect(req1!.inputTokens).toBeGreaterThan(0)

    // req-2: 'boundary' context was buffered by the system row and flushed when
    // req-2 appeared; 'real' added user chars; empty BLOB stayed, empty TEXT skipped.
    const expectedInput = Math.ceil(('real'.length + 'boundary'.length) / 4)
    expect(req2!.inputTokens).toBe(expectedInput)
    expect(req2!.outputTokens).toBe(0)
  })
})

// -----------------------------------------------------------------------------
// C5 — inputSource ladder
// -----------------------------------------------------------------------------
describe('cursor core decode: inputSource ladder', () => {
  const cid = 'cid-ladder'

  it('uses bubbleTokens when any bubble has a real tokenCount', () => {
    const { calls } = decodeCursor({
      bubbles: [
        b({ bubble_key: `bubbleId:${cid}:u1`, bubble_type: 1, text_length: 40 }),
        b({
          bubble_key: `bubbleId:${cid}:a1`,
          bubble_type: 2,
          input_tokens: 10,
          output_tokens: 20,
        }),
      ],
      agentKvRows: [],
      userMessageRows: [],
      composerMetaRows: [],
      agentKvTimestamp: AGENT_KV_TS,
      context,
    })
    // Only the assistant bubble emits; per-bubble text estimate is bypassed.
    expect(calls).toHaveLength(1)
    expect(calls[0]!.inputTokens).toBe(10)
    expect(calls[0]!.outputTokens).toBe(20)
  })

  it('uses meter when composerMeta has tokens and no real bubble tokens', () => {
    const { calls } = decodeCursor({
      bubbles: [
        b({ bubble_key: `bubbleId:${cid}:u1`, bubble_type: 1, text_length: 40 }),
        b({ bubble_key: `bubbleId:${cid}:a1`, bubble_type: 2, text_length: 20 }),
      ],
      agentKvRows: [],
      userMessageRows: [],
      composerMetaRows: [{ composer_id: cid, used: 100, ctx: null, created_at: 1_750_000_000_000 }],
      agentKvTimestamp: AGENT_KV_TS,
      context,
    })
    // The assistant bubble still emits its output-text estimate; arm-B adds the
    // conversation-level meter record.
    expect(calls).toHaveLength(2)
    const armB = calls.find(c => c.deduplicationKey === `cursor:composer-input:${cid}`)
    expect(armB).toBeDefined()
    expect(armB!.inputTokens).toBe(100)
  })

  it('uses stream when agentKv holds prompt/context and there is no meter', () => {
    const { calls } = decodeCursor({
      bubbles: [
        b({ bubble_key: `bubbleId:${cid}:u1`, bubble_type: 1, text_length: 40, request_id: 'req-1' }),
        b({ bubble_key: `bubbleId:${cid}:a1`, bubble_type: 2, text_length: 20, request_id: 'req-1' }),
      ],
      agentKvRows: [
        // System context buffers first, then the user row with requestId flushes it.
        { role: 'system', content: 'ctx', request_id: null, model: null },
        { role: 'user', content: 'hello world', request_id: 'req-1', model: null },
      ],
      userMessageRows: [],
      composerMetaRows: [],
      agentKvTimestamp: AGENT_KV_TS,
      context,
    })
    // The assistant bubble emits its output-text estimate; arm-B adds the stream
    // estimate. agentKv is joined to the conversation, so no unjoined arm-C call.
    expect(calls).toHaveLength(2)
    const armB = calls.find(c => c.deduplicationKey === `cursor:composer-input:${cid}`)
    expect(armB).toBeDefined()
    // (11 + 3) / 4 rounded up = 4
    expect(armB!.inputTokens).toBe(Math.ceil(('hello world'.length + 'ctx'.length) / 4))
  })

  it('uses text when nothing else is available', () => {
    const { calls } = decodeCursor({
      bubbles: [
        b({ bubble_key: `bubbleId:${cid}:u1`, bubble_type: 1, text_length: 40 }),
        b({ bubble_key: `bubbleId:${cid}:a1`, bubble_type: 2, text_length: 20 }),
      ],
      agentKvRows: [],
      userMessageRows: [],
      composerMetaRows: [],
      agentKvTimestamp: AGENT_KV_TS,
      context,
    })
    // Both bubbles emit; no arm-B record.
    expect(calls).toHaveLength(2)
    expect(calls.some(c => c.deduplicationKey === `cursor:composer-input:${cid}`)).toBe(false)
    const userCall = calls.find(c => c.inputTokens > 0 && c.outputTokens === 0)
    const assistantCall = calls.find(c => c.outputTokens > 0 && c.inputTokens === 0)
    expect(userCall).toBeDefined()
    expect(assistantCall).toBeDefined()
    expect(userCall!.inputTokens).toBe(Math.ceil(40 / 4))
    expect(assistantCall!.outputTokens).toBe(Math.ceil(20 / 4))
  })
})

// -----------------------------------------------------------------------------
// C6 — H4 mutation discriminator: arm B burns its dedup key before timestamp check
// -----------------------------------------------------------------------------
describe('cursor core decode: arm B dedup key burn (H4)', () => {
  it('adds the composer-input dedup key to seenKeys even when no call is emitted', () => {
    const seenKeys = new Set<string>()
    const cid = 'cid-h4'
    const { calls } = decodeCursor({
      bubbles: [b({ bubble_key: `bubbleId:${cid}:u1`, bubble_type: 1, created_at: null })],
      agentKvRows: [],
      userMessageRows: [],
      composerMetaRows: [{ composer_id: cid, used: 50, ctx: null, created_at: null }],
      agentKvTimestamp: AGENT_KV_TS,
      context,
      seenKeys,
    })

    expect(calls).toHaveLength(0)
    expect(seenKeys.has(`cursor:composer-input:${cid}`)).toBe(true)
  })
})

// -----------------------------------------------------------------------------
// C7 — toObservations
// -----------------------------------------------------------------------------
describe('cursor core decode: toObservations minimizes correctly', () => {
  it('produces a schema-valid envelope, filters synthetic tool names, orders turns, and fingerprints ids', () => {
    const cid = 'cid-obs'
    const { calls } = decodeCursor({
      bubbles: [
        b({
          bubble_key: `bubbleId:${cid}:a1`,
          bubble_type: 2,
          input_tokens: 100,
          output_tokens: 50,
          request_id: 'req-1',
          code_blocks: JSON.stringify([{ languageId: 'ts' }, { languageId: 'plaintext' }]),
        }),
      ],
      agentKvRows: [
        {
          role: 'assistant',
          content: JSON.stringify([{ type: 'tool-call', toolName: 'Shell', args: { command: 'ls' } }]),
          request_id: 'req-1',
          model: null,
        },
      ],
      userMessageRows: [],
      composerMetaRows: [],
      agentKvTimestamp: AGENT_KV_TS,
      context,
    })

    const { sessions } = toObservations(
      { sessionId: cid, projectPath: '/Users/victim/company/secret-plan.md', calls },
      { privacyKey: 'test-privacy-key', provider: 'cursor' },
    )
    const envelope = {
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      generator: { name: '@codeburn/core' as const, version: '0.0.0-test' },
      fingerprints: { algorithm: 'hmac-sha256-128' as const, keyId: 'test-key' },
      sessions,
    }

    const parsed = ObservationEnvelope.safeParse(envelope)
    expect(parsed.success).toBe(true)

    const session = parsed.data!.sessions[0]!
    expect(session.sessionRef).toMatch(/^[0-9a-f]{32}$/)
    expect(session.projectRef).toMatch(/^[0-9a-f]{32}$/)
    expect(session.calls).toHaveLength(calls.length)

    for (let i = 0; i < session.calls.length; i++) {
      expect(session.calls[i]!.turnIndex).toBe(i)
    }

    const allToolNames = session.calls.flatMap(c => c.toolNames)
    // Synthetic Cursor tools contain ':' and must be dropped by CANONICAL_TOOL_NAME.
    expect(allToolNames).not.toContain('cursor:edit')
    expect(allToolNames).not.toContain('lang:ts')
    // Canonical names survive.
    expect(allToolNames).toContain('Bash')
  })
})
