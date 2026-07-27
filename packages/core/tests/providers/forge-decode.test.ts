import { describe, expect, it } from 'vitest'

import { decodeForge, toObservations } from '../../src/providers/forge/index.js'
import { ObservationEnvelope } from '../../src/observations.js'
import { OBSERVATION_SCHEMA_VERSION } from '../../src/schema.js'
import type { DecodeContext } from '../../src/contracts.js'
import type { ForgeConversationRow } from '../../src/providers/forge/index.js'

const context: DecodeContext = { privacyKey: 'k', providerId: 'forge', sourceRef: 'ref' }

function row(context_: unknown, overrides: Partial<ForgeConversationRow> = {}): ForgeConversationRow {
  return {
    conversation_id: 'conv-1',
    title: 'Forge Project',
    workspace_id: 123,
    context: JSON.stringify(context_),
    created_at: '2026-05-06 15:00:00',
    updated_at: '2026-05-06 15:20:41.379094',
    ...overrides,
  }
}

describe('forge rich decode (moved to @codeburn/core)', () => {
  it('maps tool calls, attributes the nearest previous user message, and emits raw bash commands', () => {
    const conv = {
      messages: [
        { message: { text: { role: 'User', content: 'implement forge' } } },
        {
          message: {
            text: {
              role: 'Assistant', content: '', model: 'claude-opus-4-6',
              tool_calls: [
                { name: 'shell', call_id: 'call-1', arguments: { command: 'git status && npm test' } },
                { name: 'Read', call_id: 'call-2', arguments: { file_path: '/tmp/a' } },
              ],
            },
          },
          usage: { prompt_tokens: { actual: 1200 }, completion_tokens: { actual: 300 }, cached_tokens: { actual: 200 } },
        },
      ],
    }
    const { calls } = decodeForge({ records: [row(conv)], context })
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call).not.toHaveProperty('costUSD')
    expect(call).not.toHaveProperty('costBasis')
    expect(call.model).toBe('claude-opus-4-6')
    expect(call.inputTokens).toBe(1000) // 1200 - 200 cached
    expect(call.cacheReadInputTokens).toBe(200)
    expect(call.tools).toEqual(['Bash', 'Read'])
    // Raw command strings survive host-side; base-name extraction is the CLI's job.
    expect(call.rawBashCommands).toEqual(['git status && npm test'])
    expect(call.userMessage).toBe('implement forge')
    expect(call.deduplicationKey).toBe('forge:conv-1:call-1')
    expect(call.timestamp).toBe('2026-05-06T15:20:41.379Z')
  })

  it('skips zero-token assistant messages', () => {
    const conv = {
      messages: [
        { message: { text: { role: 'User', content: 'zero tokens' } } },
        { message: { text: { role: 'Assistant', model: 'claude-opus-4-6' } }, usage: { prompt_tokens: { actual: 0 }, completion_tokens: { actual: 0 } } },
      ],
    }
    expect(decodeForge({ records: [row(conv)], context }).calls).toEqual([])
  })

  it('yields nothing for invalid JSON context without throwing', () => {
    expect(decodeForge({ records: [row(null, { context: '{invalid' })], context }).calls).toEqual([])
  })

  it('threads a live seenKeys set so a repeated call_id across passes drops', () => {
    const conv = {
      messages: [
        { message: { text: { role: 'User', content: 'hi' } } },
        { message: { text: { role: 'Assistant', model: 'm', tool_calls: [{ name: 'shell', call_id: 'call-1', arguments: {} }] } }, usage: { prompt_tokens: { actual: 5 }, completion_tokens: { actual: 5 } } },
      ],
    }
    const seen = new Set<string>()
    expect(decodeForge({ records: [row(conv)], context, seenKeys: seen }).calls).toHaveLength(1)
    expect(decodeForge({ records: [row(conv)], context, seenKeys: seen }).calls).toEqual([])
  })

  it('toObservations produces a schema-valid, content-free envelope', () => {
    const conv = {
      messages: [
        { message: { text: { role: 'User', content: 'implement forge' } } },
        { message: { text: { role: 'Assistant', model: 'claude-opus-4-6', tool_calls: [{ name: 'shell', call_id: 'call-1', arguments: { command: 'npm test' } }] } }, usage: { prompt_tokens: { actual: 100 }, completion_tokens: { actual: 20 } } },
      ],
    }
    const { calls } = decodeForge({ records: [row(conv)], context })
    const { sessions } = toObservations(
      { sessionId: 'conv-1', projectPath: '/Users/t/proj', calls },
      { privacyKey: 'test-privacy-key', provider: 'forge' },
    )
    const envelope = {
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      generator: { name: '@codeburn/core', version: '0.0.0-test' },
      fingerprints: { algorithm: 'hmac-sha256-128', keyId: 'test-key' },
      sessions,
    }
    expect(ObservationEnvelope.safeParse(envelope).success).toBe(true)
    expect(JSON.stringify(envelope)).not.toContain('implement forge')
  })
})
