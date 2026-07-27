import { describe, it, expect } from 'vitest'

import {
  decodeKiroChatFile,
  decodeKiroCliSession,
  decodeKiroIdeFile,
  decodeKiroModernExecution,
  decodeKiroV2Session,
  extractStructuredToolNames,
  extractText,
  extractToolNames,
  finishKiroWorkspaceSession,
  parseKiroTimestamp,
  prepareKiroWorkspaceSession,
  toObservations,
} from '../../src/providers/kiro/index.js'
import { ObservationEnvelope } from '../../src/observations.js'
import { OBSERVATION_SCHEMA_VERSION } from '../../src/schema.js'
import type { DecodeContext } from '../../src/contracts.js'

const context: DecodeContext = { privacyKey: 'test-privacy-key', providerId: 'kiro', sourceRef: 'ref' }

describe('kiro core decode', () => {
  describe('C1 — parseKiroTimestamp', () => {
    it('accepts ms numbers, seconds numbers, numeric strings, and ISO strings', () => {
      expect(parseKiroTimestamp(1777333000000)!.toISOString()).toBe('2026-04-27T23:36:40.000Z')
      expect(parseKiroTimestamp(1777333000)!.toISOString()).toBe('2026-04-27T23:36:40.000Z')
      expect(parseKiroTimestamp('1777333000000')!.toISOString()).toBe('2026-04-27T23:36:40.000Z')
      expect(parseKiroTimestamp('2026-04-27T23:36:40.000Z')!.toISOString()).toBe('2026-04-27T23:36:40.000Z')
    })

    it('rejects garbage, undefined, empty string, sub-threshold values, Infinity and NaN', () => {
      expect(parseKiroTimestamp(undefined)).toBeNull()
      expect(parseKiroTimestamp('')).toBeNull()
      expect(parseKiroTimestamp('not-a-timestamp')).toBeNull()
      expect(parseKiroTimestamp(999_999_999)).toBeNull()
      expect(parseKiroTimestamp('999999999')).toBeNull()
      expect(parseKiroTimestamp(Number.POSITIVE_INFINITY)).toBeNull()
      expect(parseKiroTimestamp(Number.NaN)).toBeNull()
    })
  })

  describe('C2 — extractText', () => {
    it('returns strings, joins arrays, and recurses the six keys', () => {
      expect(extractText('plain')).toBe('plain')
      expect(extractText(['a', 'b'])).toBe('a\nb')
      expect(extractText({ content: 'c' })).toBe('c')
      expect(extractText({ text: 't' })).toBe('t')
      expect(extractText({ message: 'm' })).toBe('m')
      expect(extractText({ value: 'v' })).toBe('v')
      expect(extractText({ parts: 'p' })).toBe('p')
      expect(extractText({ entries: 'e' })).toBe('e')
    })

    it('handles deep nesting without cycles', () => {
      expect(extractText({ content: [{ text: [{ value: 'deep' }] }] })).toBe('deep')
    })

    it('returns empty for non-records', () => {
      expect(extractText(42)).toBe('')
      expect(extractText(null)).toBe('')
    })
  })

  describe('C3 — extractToolNames / extractStructuredToolNames', () => {
    it('extracts from <tool_use><name> tags and maps known names', () => {
      expect(extractToolNames('Use <tool_use><name>runCommand</name></tool_use> then <tool_use><name>readFile</name></tool_use>')).toEqual(['Bash', 'Read'])
    })

    it('passes unmapped names through verbatim', () => {
      expect(extractToolNames('<tool_use><name>custom_tool</name></tool_use>')).toEqual(['custom_tool'])
    })

    it('extracts direct names and array entries with mapping', () => {
      expect(extractStructuredToolNames({ toolName: 'writeFile' }, '')).toEqual(['Edit'])
      expect(extractStructuredToolNames({ toolCalls: [{ name: 'runCommand' }] }, '')).toEqual(['Bash'])
      expect(extractStructuredToolNames({ tools: [{ tool_name: 'read_file' }] }, '')).toEqual(['Read'])
    })

    it('honors includeDirectName: false', () => {
      expect(extractStructuredToolNames({ toolName: 'writeFile' }, '', { includeDirectName: false })).toEqual([])
    })
  })

  describe('C4 — decodeKiroCliSession turn-index asymmetry (H3)', () => {
    function makeMeta(turns: Array<{ end_timestamp?: string; metering_usage?: Array<{ value: number; unit: string }> }>): import('../../src/providers/kiro/types.js').KiroCliSessionMeta {
      return {
        session_id: 'sess-cli',
        cwd: '/tmp/p',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:01:00Z',
        session_state: { conversation_metadata: { user_turn_metadatas: turns } },
      }
    }

    it('does not advance turnIndex on zero-output turn', () => {
      const entries = [
        { version: '1', kind: 'Prompt' as const, data: { content: [{ kind: 'text', data: 'first' }] } },
        { version: '1', kind: 'AssistantMessage' as const, data: { content: [{ kind: 'text', data: 'first answer' }] } },
        { version: '1', kind: 'Prompt' as const, data: { content: [{ kind: 'text', data: 'second no output' }] } },
        { version: '1', kind: 'Prompt' as const, data: { content: [{ kind: 'text', data: 'third' }] } },
        { version: '1', kind: 'AssistantMessage' as const, data: { content: [{ kind: 'text', data: 'third answer' }] } },
      ]
      const meta = makeMeta([
        { end_timestamp: '2026-01-01T00:00:30Z', metering_usage: [{ value: 1, unit: 'credit' }] },
        { end_timestamp: '2026-01-01T00:01:30Z', metering_usage: [{ value: 2, unit: 'credit' }] },
      ])
      const { calls } = decodeKiroCliSession({ meta, entries, project: 'p', context })
      expect(calls).toHaveLength(2)
      expect(calls[0]!.deduplicationKey).toBe('kiro-cli:sess-cli:0')
      expect(calls[0]!.credits).toBe(1)
      expect(calls[1]!.deduplicationKey).toBe('kiro-cli:sess-cli:1')
      expect(calls[1]!.credits).toBe(2)
    })

    it('advances but does not burn on dedup', () => {
      const seen = new Set(['kiro-cli:sess-cli:0'])
      const entries = [
        { version: '1', kind: 'Prompt' as const, data: { content: [{ kind: 'text', data: 'first' }] } },
        { version: '1', kind: 'AssistantMessage' as const, data: { content: [{ kind: 'text', data: 'first answer' }] } },
        { version: '1', kind: 'Prompt' as const, data: { content: [{ kind: 'text', data: 'second' }] } },
        { version: '1', kind: 'AssistantMessage' as const, data: { content: [{ kind: 'text', data: 'second answer' }] } },
      ]
      const meta = makeMeta([
        { end_timestamp: '2026-01-01T00:00:30Z', metering_usage: [{ value: 1, unit: 'credit' }] },
        { end_timestamp: '2026-01-01T00:01:30Z', metering_usage: [{ value: 2, unit: 'credit' }] },
      ])
      const { calls } = decodeKiroCliSession({ meta, entries, project: 'p', context, seenKeys: seen })
      expect(calls).toHaveLength(1)
      expect(calls[0]!.deduplicationKey).toBe('kiro-cli:sess-cli:1')
      expect(seen.has('kiro-cli:sess-cli:1')).toBe(true)
    })

    it('advances but does not burn on invalid timestamp', () => {
      const entries = [
        { version: '1', kind: 'Prompt' as const, data: { content: [{ kind: 'text', data: 'first' }] } },
        { version: '1', kind: 'AssistantMessage' as const, data: { content: [{ kind: 'text', data: 'first answer' }] } },
      ]
      const meta = makeMeta([{ end_timestamp: 'not-a-date', metering_usage: [{ value: 1, unit: 'credit' }] }])
      const seen = new Set<string>()
      const { calls } = decodeKiroCliSession({ meta, entries, project: 'p', context, seenKeys: seen })
      expect(calls).toHaveLength(0)
      expect(seen.size).toBe(0)
    })

    it('a dropped bad-timestamp turn still consumes its metadata slot', () => {
      // Three output-bearing turns; turn 2's metadata timestamp is garbage. The
      // bad-timestamp arm advances turnIndex, so turn 3 pairs with slot 2. If
      // that arm stopped advancing, turn 3 would re-read slot 1 and be dropped.
      const entries = [
        { version: '1', kind: 'Prompt' as const, data: { content: [{ kind: 'text', data: 'first' }] } },
        { version: '1', kind: 'AssistantMessage' as const, data: { content: [{ kind: 'text', data: 'first answer' }] } },
        { version: '1', kind: 'Prompt' as const, data: { content: [{ kind: 'text', data: 'second' }] } },
        { version: '1', kind: 'AssistantMessage' as const, data: { content: [{ kind: 'text', data: 'second answer' }] } },
        { version: '1', kind: 'Prompt' as const, data: { content: [{ kind: 'text', data: 'third' }] } },
        { version: '1', kind: 'AssistantMessage' as const, data: { content: [{ kind: 'text', data: 'third answer' }] } },
      ]
      const meta = makeMeta([
        { end_timestamp: '2026-01-01T00:00:30Z', metering_usage: [{ value: 1, unit: 'credit' }] },
        { end_timestamp: 'not-a-date', metering_usage: [{ value: 9, unit: 'credit' }] },
        { end_timestamp: '2026-01-01T00:02:30Z', metering_usage: [{ value: 3, unit: 'credit' }] },
      ])
      const seen = new Set<string>()
      const { calls } = decodeKiroCliSession({ meta, entries, project: 'p', context, seenKeys: seen })
      expect(calls).toHaveLength(2)
      expect(calls[0]!.deduplicationKey).toBe('kiro-cli:sess-cli:0')
      expect(calls[0]!.credits).toBe(1)
      expect(calls[1]!.deduplicationKey).toBe('kiro-cli:sess-cli:2')
      expect(calls[1]!.credits).toBe(3)
      expect(calls[1]!.timestamp).toBe('2026-01-01T00:02:30.000Z')
      expect([...seen].sort()).toEqual(['kiro-cli:sess-cli:0', 'kiro-cli:sess-cli:2'])
    })
  })

  describe('C5 — decodeKiroV2Session state machine (H13)', () => {
    function makeLines(events: Array<{ id?: string; timestamp?: string; payload: Record<string, unknown> }>): string {
      return events.map(e => JSON.stringify({ id: e.id ?? 'x', timestamp: e.timestamp ?? '2026-07-14T13:39:40.000Z', payload: e.payload })).join('\n')
    }

    it('handles implicit turn (assistant without turn_start)', () => {
      const lines = makeLines([
        { payload: { type: 'user', content: 'user prompt' } },
        { payload: { type: 'assistant', operationType: 'Say', content: 'implicit answer' } },
      ])
      const { calls } = decodeKiroV2Session({ lines, meta: { id: 'sess-v2' }, fallbackSessionId: 'fallback', project: 'p', context })
      expect(calls).toHaveLength(1)
      expect(calls[0]!.userMessage).toBe('')
      expect(calls[0]!.inputTokens).toBe(0)
      expect(calls[0]!.outputTokens).toBe(4)
    })

    it('defensively flushes on user event mid-turn', () => {
      const lines = makeLines([
        { payload: { type: 'turn_start', executionId: 'exec-1' } },
        { payload: { type: 'assistant', operationType: 'Say', content: 'first' } },
        { payload: { type: 'user', content: 'new prompt' } },
        { payload: { type: 'turn_start', executionId: 'exec-2' } },
        { payload: { type: 'assistant', operationType: 'Say', content: 'second' } },
        { payload: { type: 'turn_end' } },
      ])
      const { calls } = decodeKiroV2Session({ lines, meta: { id: 'sess-v2' }, fallbackSessionId: 'fallback', project: 'p', context })
      expect(calls).toHaveLength(2)
    })

    it('trailing flush captures in-progress turn', () => {
      const lines = makeLines([
        { payload: { type: 'turn_start', executionId: 'exec-1' } },
        { payload: { type: 'assistant', operationType: 'Say', content: 'in progress' } },
      ])
      const { calls } = decodeKiroV2Session({ lines, meta: { id: 'sess-v2' }, fallbackSessionId: 'fallback', project: 'p', context })
      expect(calls).toHaveLength(1)
    })

    it('resetTurn does not clear pending user message', () => {
      const lines = makeLines([
        { payload: { type: 'user', content: 'pending' } },
        { payload: { type: 'turn_start', executionId: 'exec-1' } },
        { payload: { type: 'assistant', operationType: 'Say', content: 'answer' } },
        { payload: { type: 'turn_end' } },
      ])
      const { calls } = decodeKiroV2Session({ lines, meta: { id: 'sess-v2' }, fallbackSessionId: 'fallback', project: 'p', context })
      expect(calls).toHaveLength(1)
      expect(calls[0]!.userMessage).toBe('pending')
    })
  })

  describe('C6 — prepareKiroWorkspaceSession + finishKiroWorkspaceSession', () => {
    it('returns not-workspace-session when shape is wrong', () => {
      expect(prepareKiroWorkspaceSession({ chat: [] }).kind).toBe('not-workspace-session')
      expect(prepareKiroWorkspaceSession({ history: [], sessionId: 'x' }).kind).toBe('empty')
    })

    it('returns empty for stub-only or zero-content sessions', () => {
      expect(prepareKiroWorkspaceSession({
        sessionId: 'stub',
        history: [{ message: { role: 'user', content: 'hi' } }, { message: { role: 'assistant', content: 'On it.' }, executionId: 'exec-1' }],
      }).kind).toBe('empty')
      expect(prepareKiroWorkspaceSession({
        sessionId: 'empty',
        history: [{ message: { role: 'user', content: '' } }],
      }).kind).toBe('empty')
    })

    it('returns ready for real content and finish emits with injected timestamp', () => {
      const prepared = prepareKiroWorkspaceSession({
        sessionId: 'ws-real',
        selectedModel: 'claude-opus-4.8',
        history: [{ message: { role: 'user', content: 'hi' } }, { message: { role: 'assistant', content: 'hello' } }],
      })
      expect(prepared.kind).toBe('ready')
      if (prepared.kind !== 'ready') throw new Error('unexpected')
      const { calls } = finishKiroWorkspaceSession(prepared.draft, { timestamp: '2026-07-14T13:39:40.000Z' })
      expect(calls).toHaveLength(1)
      expect(calls[0]!.timestamp).toBe('2026-07-14T13:39:40.000Z')
      expect(calls[0]!.deduplicationKey).toBe('kiro:ws-session:ws-real')
    })

    it('finish does not burn dedup key when already seen', () => {
      const prepared = prepareKiroWorkspaceSession({
        sessionId: 'ws-dup',
        history: [{ message: { role: 'user', content: 'hi' } }, { message: { role: 'assistant', content: 'hello' } }],
      })
      if (prepared.kind !== 'ready') throw new Error('unexpected')
      const seen = new Set(['kiro:ws-session:ws-dup'])
      const { calls } = finishKiroWorkspaceSession(prepared.draft, { timestamp: '2026-07-14T13:39:40.000Z', seenKeys: seen })
      expect(calls).toHaveLength(0)
      expect(seen.size).toBe(1)
    })
  })

  describe('C7 — key-burn pins per arm', () => {
    it('A1 chat does not burn on skip', () => {
      const seen = new Set(['kiro:wf:exec'])
      const { calls } = decodeKiroChatFile({
        record: {
          executionId: 'exec',
          actionId: 'act',
          context: [],
          validations: {},
          chat: [
            { role: 'human', content: '<identity>x</identity>' },
            { role: 'human', content: 'hi' },
            { role: 'bot', content: 'hello' },
          ],
          metadata: { modelId: 'claude-haiku-4-5', modelProvider: 'qdev', workflow: 'act', workflowId: 'wf', startTime: 1777333000000, endTime: 1777333010000 },
        } as unknown as import('../../src/providers/kiro/types.js').KiroChatFile,
        fallbackChatSessionId: 'wf',
        context,
        seenKeys: seen,
      })
      expect(calls).toHaveLength(0)
      expect(seen.size).toBe(1)
    })

    it('A2 modern does not burn on invalid timestamp', () => {
      const seen = new Set<string>()
      const { calls } = decodeKiroModernExecution({
        record: { executionId: 'exec', sessionId: 'sess', startTime: 'bad', prompt: 'hi', response: 'hello' },
        fallbackExecutionId: 'exec',
        fallbackSessionId: 'sess',
        context,
        seenKeys: seen,
      })
      expect(calls).toHaveLength(0)
      expect(seen.size).toBe(0)
    })

    it('A3 finish does not burn when already seen', () => {
      const seen = new Set(['kiro:ws-session:ws'])
      const { calls } = finishKiroWorkspaceSession(
        { sessionId: 'ws', modelId: 'kiro-auto', inputChars: 2, outputChars: 2, pendingUserMessage: 'hi', allTools: [] },
        { timestamp: '2026-07-14T13:39:40.000Z', seenKeys: seen },
      )
      expect(calls).toHaveLength(0)
      expect(seen.size).toBe(1)
    })

    it('A4 CLI does not burn on invalid timestamp', () => {
      const seen = new Set<string>()
      const entries = [
        { version: '1', kind: 'Prompt' as const, data: { content: [{ kind: 'text', data: 'hi' }] } },
        { version: '1', kind: 'AssistantMessage' as const, data: { content: [{ kind: 'text', data: 'hello' }] } },
      ]
      const meta: import('../../src/providers/kiro/types.js').KiroCliSessionMeta = {
        session_id: 'sess',
        cwd: '/tmp/p',
        created_at: 'bad-date',
        updated_at: 'bad-date',
      }
      const { calls } = decodeKiroCliSession({ meta, entries, project: 'p', context, seenKeys: seen })
      expect(calls).toHaveLength(0)
      expect(seen.size).toBe(0)
    })

    it('A5 v2 does not burn on invalid timestamp', () => {
      const seen = new Set<string>()
      const lines = [
        JSON.stringify({ id: 'u', timestamp: '2026-07-14T13:39:00.000Z', payload: { type: 'user', content: 'hi' } }),
        JSON.stringify({ id: 'ts', timestamp: 'bad', payload: { type: 'turn_start', executionId: 'exec' } }),
        JSON.stringify({ id: 'a', timestamp: 'bad', payload: { type: 'assistant', operationType: 'Say', content: 'hello' } }),
        JSON.stringify({ id: 'te', timestamp: 'bad', payload: { type: 'turn_end' } }),
      ].join('\n')
      const { calls } = decodeKiroV2Session({ lines, meta: { id: 'sess' }, fallbackSessionId: 'sess', project: 'p', context, seenKeys: seen })
      expect(calls).toHaveLength(0)
      expect(seen.size).toBe(0)
    })
  })

  describe('C8 — toObservations minimizes correctly', () => {
    it('produces a schema-valid envelope with fingerprinted refs', () => {
      const { sessions } = toObservations({
        sessionId: 'sess-obs',
        projectPath: '/Users/victim/company/secret',
        calls: [{
          provider: 'kiro',
          arm: 'modern',
          model: 'claude-sonnet-4',
          inputTokens: 10,
          outputTokens: 5,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          cachedInputTokens: 0,
          reasoningTokens: 0,
          webSearchRequests: 0,
          credits: 0,
          tools: ['Bash', 'not canonical!'],
          bashCommands: [],
          timestamp: '2026-07-14T13:39:40.000Z',
          speed: 'standard',
          deduplicationKey: 'kiro:sess:1',
          userMessage: 'SECRET PROMPT',
          sessionId: 'sess-obs',
        }],
      }, { privacyKey: 'test-privacy-key', provider: 'kiro' })

      const envelope = {
        schemaVersion: OBSERVATION_SCHEMA_VERSION,
        generator: { name: '@codeburn/core', version: '0.0.0-test' },
        sessions,
      }
      expect(ObservationEnvelope.safeParse(envelope).success).toBe(true)
      expect(sessions[0]!.sessionRef).toMatch(/^[0-9a-f]{16}$/)
      expect(sessions[0]!.projectRef).toMatch(/^[0-9a-f]{16}$/)
      expect(sessions[0]!.calls[0]!.turnIndex).toBe(0)
      expect(sessions[0]!.calls[0]!.toolNames).toEqual(['Bash'])
      expect(JSON.stringify(envelope)).not.toContain('SECRET PROMPT')
      expect(JSON.stringify(envelope)).not.toContain('/Users/victim/company/secret')
    })

    it('maps costBasis to measured when credits are present', () => {
      const { sessions } = toObservations({
        sessionId: 'sess-obs2',
        projectPath: '/tmp',
        calls: [{
          provider: 'kiro',
          arm: 'modern',
          model: 'claude-sonnet-4',
          inputTokens: 10,
          outputTokens: 5,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          cachedInputTokens: 0,
          reasoningTokens: 0,
          webSearchRequests: 0,
          credits: 1.5,
          tools: [],
          bashCommands: [],
          timestamp: '2026-07-14T13:39:40.000Z',
          speed: 'standard',
          deduplicationKey: 'kiro:sess:2',
          userMessage: 'hi',
          sessionId: 'sess-obs2',
        }],
      }, { privacyKey: 'test-privacy-key' })
      expect(sessions[0]!.calls[0]!.costBasis).toBe('measured')
    })
  })
})
