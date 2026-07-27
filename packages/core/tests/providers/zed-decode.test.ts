import zlib from 'node:zlib'

import { describe, expect, it } from 'vitest'

import { decodeZed, toObservations } from '../../src/providers/zed/index.js'
import { ObservationEnvelope } from '../../src/observations.js'
import { OBSERVATION_SCHEMA_VERSION } from '../../src/schema.js'
import type { DecodeContext } from '../../src/contracts.js'
import type { ZedThreadRow } from '../../src/providers/zed/index.js'

const context: DecodeContext = { privacyKey: 'k', providerId: 'zed', sourceRef: 'ref' }

const zstd = (zlib as { zstdCompressSync?: (buf: Buffer) => Buffer }).zstdCompressSync
const skipReason = !zstd ? 'zlib zstd not available — needs Node 22.15+; skipping' : null

function zstdRow(id: string, thread: unknown, opts: Partial<ZedThreadRow> = {}): ZedThreadRow {
  return {
    id,
    summary: opts.summary ?? 'a thread',
    updated_at: opts.updated_at ?? '2026-06-20T10:00:00Z',
    data_type: 'zstd',
    data: zstd!(Buffer.from(JSON.stringify(thread))),
    ...opts,
  }
}

describe.skipIf(skipReason !== null)('zed rich decode (moved to @codeburn/core)', () => {
  it('emits one call per request, plus a cumulative-remainder entry when the map undercounts', () => {
    const row = zstdRow('thread-1', {
      model: { provider: 'anthropic', model: 'claude-opus-4-8' },
      request_token_usage: {
        'req-1': { input_tokens: 1200, output_tokens: 300, cache_creation_input_tokens: 5000, cache_read_input_tokens: 90000 },
        'req-2': { input_tokens: 800, output_tokens: 150 },
      },
      cumulative_token_usage: { input_tokens: 2000, output_tokens: 450 },
    }, { summary: 'refactor the parser', updated_at: '2026-06-21T09:30:00Z' })

    const { calls } = decodeZed({ records: [row], context })
    expect(calls).toHaveLength(2)
    const first = calls.find(c => c.deduplicationKey === 'zed:thread-1:req-1')!
    expect(first.inputTokens).toBe(1200)
    expect(first.cacheCreationInputTokens).toBe(5000)
    expect(first.model).toBe('claude-opus-4-8')
    expect(first.userMessage).toBe('refactor the parser')
    expect(first.timestamp).toBe('2026-06-21T09:30:00.000Z')
    expect(calls.reduce((s, c) => s + c.inputTokens, 0)).toBe(2000)
  })

  it('skips non-zstd/json rows and malformed blobs, recording a diagnostic without dropping healthy threads', () => {
    const badType: ZedThreadRow = { id: 'bad-type', summary: null, updated_at: '2026-06-20T10:00:00Z', data_type: 'protobuf', data: Buffer.from('{}') }
    const badBlob: ZedThreadRow = { id: 'bad-blob', summary: null, updated_at: '2026-06-20T10:00:00Z', data_type: 'zstd', data: Buffer.from('not zstd at all') }
    const good = zstdRow('good', { model: { model: 'claude-opus-4-8' }, request_token_usage: { 'req-1': { input_tokens: 10, output_tokens: 5 } } })

    const { calls, diagnostics } = decodeZed({ records: [badType, badBlob, good], context })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.sessionId).toBe('good')
    expect(diagnostics.length).toBeGreaterThan(0)
  })

  it('reads legacy uncompressed json rows', () => {
    const row: ZedThreadRow = {
      id: 'legacy', summary: null, updated_at: '2026-06-22T11:00:00Z', data_type: 'json',
      data: Buffer.from(JSON.stringify({ model: { model: 'claude-sonnet-4-6' }, request_token_usage: { 'req-1': { input_tokens: 40, output_tokens: 8 } } })),
    }
    const { calls } = decodeZed({ records: [row], context })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.inputTokens).toBe(40)
    expect(calls[0]!.model).toBe('claude-sonnet-4-6')
  })

  it('skips threads whose usage is entirely zero', () => {
    const row = zstdRow('zero', {
      model: { model: 'claude-opus-4-8' },
      request_token_usage: { 'req-1': { input_tokens: 0, output_tokens: 0 } },
      cumulative_token_usage: { input_tokens: 0, output_tokens: 0 },
    })
    expect(decodeZed({ records: [row], context }).calls).toEqual([])
  })

  it('threads a live seenKeys set so a repeated thread across passes drops', () => {
    const row = zstdRow('thread-3', { model: { model: 'claude-opus-4-8' }, request_token_usage: { 'req-1': { input_tokens: 100, output_tokens: 50 } } })
    const seen = new Set<string>()
    expect(decodeZed({ records: [row], context, seenKeys: seen }).calls).toHaveLength(1)
    expect(decodeZed({ records: [row], context, seenKeys: seen }).calls).toEqual([])
  })

  it('toObservations produces a schema-valid, content-free envelope', () => {
    const row = zstdRow('thread-4', {
      model: { model: 'claude-opus-4-8' },
      request_token_usage: { 'req-1': { input_tokens: 100, output_tokens: 50 } },
    }, { summary: 'do the thing' })
    const { calls } = decodeZed({ records: [row], context })
    const { sessions } = toObservations(
      { sessionId: 'thread-4', projectPath: '/Users/t/proj', calls },
      { privacyKey: 'test-privacy-key', provider: 'zed' },
    )
    const envelope = {
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      generator: { name: '@codeburn/core', version: '0.0.0-test' },
      sessions,
    }
    expect(ObservationEnvelope.safeParse(envelope).success).toBe(true)
    // The thread summary must never cross into the envelope.
    expect(JSON.stringify(envelope)).not.toContain('do the thing')
  })
})
