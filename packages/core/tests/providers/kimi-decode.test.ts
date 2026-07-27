import { describe, expect, it } from 'vitest'

import { decodeKimi, toObservations } from '../../src/providers/kimi/index.js'
import { ObservationEnvelope } from '../../src/observations.js'
import { OBSERVATION_SCHEMA_VERSION } from '../../src/schema.js'
import type { DecodeContext } from '../../src/contracts.js'
import type { KimiSessionRecords } from '../../src/providers/kimi/types.js'

const context: DecodeContext = { privacyKey: 'k', providerId: 'kimi', sourceRef: 'ref' }

function record(timestamp: number, type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ timestamp, message: { type, payload } })
}

function session(opts: Partial<KimiSessionRecords> = {}): KimiSessionRecords {
  return {
    lines: opts.lines ?? [],
    configuredModel: opts.configuredModel ?? 'kimi-auto',
    sessionName: opts.sessionName ?? 'sess-a',
  }
}

describe('kimi rich decode (moved to @codeburn/core)', () => {
  it('decodes StatusUpdate usage, tools, and raw bash commands', () => {
    const records: KimiSessionRecords[] = [
      session({
        configuredModel: 'kimi-k2-thinking-turbo',
        lines: [
          record(1776162400, 'TurnBegin', { user_input: 'add status endpoint' }),
          record(1776162401, 'ToolCall', {
            type: 'function',
            id: 'call-shell',
            function: { name: 'Shell', arguments: JSON.stringify({ command: 'git status && npm test' }) },
          }),
          record(1776162402, 'ToolCall', {
            type: 'function',
            id: 'call-read',
            function: { name: 'ReadFile', arguments: JSON.stringify({ path: 'src/index.ts' }) },
          }),
          record(1776162403, 'StatusUpdate', {
            message_id: 'msg-1',
            token_usage: {
              input_other: 100,
              input_cache_read: 25,
              input_cache_creation: 10,
              output: 40,
            },
          }),
        ],
      }),
    ]

    const { calls } = decodeKimi({ records, context })
    expect(calls).toHaveLength(1)

    const call = calls[0]!
    expect(call.provider).toBe('kimi')
    expect(call.model).toBe('kimi-k2-thinking-turbo')
    expect(call.inputTokens).toBe(100)
    expect(call.outputTokens).toBe(40)
    expect(call.cacheReadInputTokens).toBe(25)
    expect(call.cacheCreationInputTokens).toBe(10)
    expect(call.cachedInputTokens).toBe(25)
    expect(call.tools).toEqual(['Bash', 'Read'])
    expect(call.rawBashCommands).toEqual(['git status && npm test'])
    expect(call.userMessage).toBe('add status endpoint')
    expect(call.deduplicationKey).toBe('kimi:sess-a:msg-1')
    expect(call.sessionId).toBe('sess-a')
  })

  it('dedups tools per turn (Set), matching the legacy in-CLI decode', () => {
    const records: KimiSessionRecords[] = [
      session({
        lines: [
          record(1776162400, 'TurnBegin', { user_input: 'x' }),
          record(1776162401, 'ToolCall', {
            type: 'function',
            function: { name: 'ReadFile', arguments: JSON.stringify({ path: 'a.ts' }) },
          }),
          record(1776162402, 'ToolCall', {
            type: 'function',
            function: { name: 'ReadFile', arguments: JSON.stringify({ path: 'b.ts' }) },
          }),
          record(1776162403, 'ToolCall', {
            type: 'function',
            function: { name: 'Shell', arguments: JSON.stringify({ command: 'ls' }) },
          }),
          record(1776162404, 'StatusUpdate', {
            message_id: 'msg-dup',
            token_usage: { input_other: 5, output: 7 },
          }),
        ],
      }),
    ]

    const { calls } = decodeKimi({ records, context })
    expect(calls).toHaveLength(1)
    // Two ReadFile calls collapse to one 'Read'; raw bash commands stay raw.
    expect(calls[0]!.tools).toEqual(['Read', 'Bash'])
    expect(calls[0]!.rawBashCommands).toEqual(['ls'])
  })

  it('filters thought parts and joins content parts for the user message', () => {
    const records: KimiSessionRecords[] = [
      session({
        lines: [
          record(1776023300, 'TurnBegin', {
            user_input: [
              { type: 'text', text: 'refactor parser' },
              { type: 'image_url', image_url: { url: 'file://diagram.png' } },
              { type: 'text', text: 'carefully' },
            ],
          }),
          record(1776023301, 'ToolCallRequest', {
            id: 'call-write',
            name: 'WriteFile',
            arguments: JSON.stringify({ path: 'src/parser.ts', content: 'x' }),
          }),
          record(1776023302, 'StatusUpdate', {
            message_id: 'msg-2',
            model_name: 'kimi-k2.6',
            token_usage: { input_other: 5, output: 7 },
          }),
        ],
      }),
    ]

    const { calls } = decodeKimi({ records, context })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.userMessage).toBe('refactor parser carefully')
    expect(calls[0]!.model).toBe('kimi-k2.6')
    expect(calls[0]!.tools).toEqual(['Write'])
  })

  it('deduplicates repeated message ids using the live seenKeys set', () => {
    const records: KimiSessionRecords[] = [
      session({
        lines: [
          record(1776023300, 'TurnBegin', { user_input: 'x' }),
          record(1776023301, 'StatusUpdate', { message_id: 'msg-3', token_usage: { input_other: 5, output: 7 } }),
          record(1776023302, 'StatusUpdate', { message_id: 'msg-3', token_usage: { input_other: 5, output: 7 } }),
        ],
      }),
    ]

    const seen = new Set<string>()
    expect(decodeKimi({ records, context, seenKeys: seen }).calls).toHaveLength(1)
    expect(decodeKimi({ records, context, seenKeys: seen }).calls).toEqual([])
  })

  it('toObservations produces a schema-valid, content-free envelope', () => {
    const records: KimiSessionRecords[] = [
      session({
        lines: [
          record(1776162400, 'TurnBegin', { user_input: 'add status endpoint' }),
          record(1776162403, 'StatusUpdate', {
            message_id: 'msg-1',
            token_usage: { input_other: 100, output: 40 },
          }),
        ],
      }),
    ]

    const { calls } = decodeKimi({ records, context })
    const { sessions } = toObservations(
      { sessionId: 'sess-a', projectPath: '', calls },
      { privacyKey: 'test-privacy-key', provider: 'kimi' },
    )
    const envelope = {
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      generator: { name: '@codeburn/core', version: '0.0.0-test' },
      fingerprints: { algorithm: 'hmac-sha256-128', keyId: 'test-key' },
      sessions,
    }
    expect(ObservationEnvelope.safeParse(envelope).success).toBe(true)
  })
})
