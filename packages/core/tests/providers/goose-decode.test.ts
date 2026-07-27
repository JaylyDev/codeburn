import { describe, expect, it } from 'vitest'

import { decodeGoose, toObservations } from '../../src/providers/goose/index.js'
import { ObservationEnvelope } from '../../src/observations.js'
import { OBSERVATION_SCHEMA_VERSION } from '../../src/schema.js'
import type { DecodeContext } from '../../src/contracts.js'
import type { GooseSessionRecords } from '../../src/providers/goose/index.js'

const context: DecodeContext = { privacyKey: 'k', providerId: 'goose', sourceRef: 'ref' }

function sessionRecords(overrides: Partial<GooseSessionRecords> = {}): GooseSessionRecords {
  return {
    sessionId: 'sess-1',
    session: {
      id: 'sess-1',
      workingDir: '/Users/me/project',
      createdAt: '2026-06-01T10:00:00Z',
      updatedAt: '2026-06-01T10:05:30Z',
      accumulatedInputTokens: 1500,
      accumulatedOutputTokens: 400,
      modelConfigJson: JSON.stringify({ model_name: 'gpt-5.5', reasoning: true }),
    },
    assistantToolMessages: [
      { contentJson: JSON.stringify([
        { type: 'text', text: 'working on it' },
        { type: 'toolRequest', toolCall: { value: { name: 'developer__shell', arguments: { command: 'npm test && npm run lint' } } } },
        { type: 'toolRequest', toolCall: { value: { name: 'developer__read_file', arguments: { file_path: 'src/index.ts' } } } },
      ]) },
      { contentJson: JSON.stringify([
        { type: 'toolRequest', toolCall: { value: { name: 'some_native_tool', arguments: {} } } },
      ]) },
    ],
    firstUserMessage: { contentJson: JSON.stringify([{ type: 'text', text: 'please refactor the shell wrapper and run tests' }]) },
    ...overrides,
  }
}

describe('goose rich decode (moved to @codeburn/core)', () => {
  it('decodes a session into a single rich call with mapped tools, raw commands, and a two-turn toolSequence', () => {
    const { calls } = decodeGoose({ records: [sessionRecords()], context })
    expect(calls).toHaveLength(1)
    const call = calls[0]!

    expect(call).not.toHaveProperty('costUSD')
    expect(call).not.toHaveProperty('costBasis')
    expect(call.model).toBe('gpt-5.5')
    expect(call.inputTokens).toBe(1500)
    expect(call.outputTokens).toBe(400)
    expect(call.tools).toEqual(['Bash', 'Read', 'some_native_tool'])
    expect(call.rawBashCommands).toEqual(['npm test && npm run lint'])
    expect(call.userMessage).toBe('please refactor the shell wrapper and run tests')
    expect(call.deduplicationKey).toBe('goose:sess-1')
    expect(call.timestamp).toBe('2026-06-01T10:05:30.000Z')
    // toolSequence included only when it has MORE than one turn.
    expect(call.toolSequence).toHaveLength(2)
    expect(call.toolSequence?.[0]?.[1]).toEqual({ tool: 'Read', file: 'src/index.ts' })
  })

  it('omits toolSequence when only one turn used tools', () => {
    const records = sessionRecords({
      assistantToolMessages: [
        { contentJson: JSON.stringify([{ type: 'toolRequest', toolCall: { value: { name: 'developer__shell', arguments: { command: 'ls' } } } }]) },
      ],
    })
    const { calls } = decodeGoose({ records: [records], context })
    expect(calls[0]!.toolSequence).toBeUndefined()
  })

  it('falls back to "unknown" model when model_config_json is missing/malformed', () => {
    const records = sessionRecords({ session: { ...sessionRecords().session, modelConfigJson: null } })
    expect(decodeGoose({ records: [records], context }).calls[0]!.model).toBe('unknown')
  })

  it('skips a session with zero accumulated tokens', () => {
    const records = sessionRecords({ session: { ...sessionRecords().session, accumulatedInputTokens: 0, accumulatedOutputTokens: 0 } })
    expect(decodeGoose({ records: [records], context }).calls).toEqual([])
  })

  it('resolves to an empty timestamp (never the clock) when both timestamp columns are unparseable', () => {
    const records = sessionRecords({ session: { ...sessionRecords().session, createdAt: 'not-a-date', updatedAt: null } })
    expect(decodeGoose({ records: [records], context }).calls[0]!.timestamp).toBe('')
  })

  it('threads a live seenKeys set so a repeated session id across passes drops', () => {
    const seen = new Set<string>()
    expect(decodeGoose({ records: [sessionRecords()], context, seenKeys: seen }).calls).toHaveLength(1)
    expect(decodeGoose({ records: [sessionRecords()], context, seenKeys: seen }).calls).toEqual([])
  })

  it('toObservations produces a schema-valid, content-free envelope and fingerprints the read_file path', () => {
    const { calls } = decodeGoose({ records: [sessionRecords()], context })
    const { sessions } = toObservations(
      { sessionId: 'sess-1', projectPath: '/Users/me/project', calls },
      { privacyKey: 'test-privacy-key', provider: 'goose' },
    )
    const envelope = {
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      generator: { name: '@codeburn/core', version: '0.0.0-test' },
      sessions,
    }
    expect(ObservationEnvelope.safeParse(envelope).success).toBe(true)
    const reads = sessions.flatMap(s => s.calls.flatMap(c => c.resourceReads ?? []))
    expect(reads.length).toBeGreaterThan(0)
    for (const ref of reads) expect(ref.resourceId).toMatch(/^[0-9a-f]{16}$/)
    expect(JSON.stringify(envelope)).not.toContain('please refactor')
  })
})
