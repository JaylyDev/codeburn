import { describe, expect, it } from 'vitest'

import { decodeHermes, toObservations } from '../../src/providers/hermes/index.js'
import { ObservationEnvelope } from '../../src/observations.js'
import { OBSERVATION_SCHEMA_VERSION } from '../../src/schema.js'
import type { DecodeContext } from '../../src/contracts.js'
import type { HermesMessageRow, HermesSessionRow } from '../../src/providers/hermes/types.js'

const context: DecodeContext = { privacyKey: 'k', providerId: 'hermes', sourceRef: 'ref' }

function makeComposite(session: HermesSessionRow, messages: HermesMessageRow[], profile = 'default') {
  return { session, messages, profile }
}

const BASE_SESSION: HermesSessionRow = {
  id: 'sess-a',
  source: 'cli',
  model: 'claude-sonnet-4-20250514',
  cwd: '/Users/me/projects/codeburn',
  billing_provider: 'openai-codex',
  input_tokens: 1000,
  output_tokens: 200,
  cache_read_tokens: 50,
  cache_write_tokens: 10,
  reasoning_tokens: 25,
  estimated_cost_usd: null,
  actual_cost_usd: null,
  api_call_count: 3,
  tool_call_count: 2,
  started_at: 1779549200,
  ended_at: null,
  title: 'Test',
}

describe('hermes rich decode (moved to @codeburn/core)', () => {
  it('decodes a session row + messages into a cost-free rich call', () => {
    const messages: HermesMessageRow[] = [
      { id: 1, role: 'user', content: 'Implement Hermes support', tool_calls: null, tool_name: null, timestamp: 1779549201 },
      {
        id: 2,
        role: 'assistant',
        content: null,
        tool_calls: JSON.stringify([
          { function: { name: 'read_file', arguments: JSON.stringify({ path: '/tmp/hermes.ts' }) } },
          { function: { name: 'terminal', arguments: JSON.stringify({ command: 'npm test' }) } },
        ]),
        tool_name: null,
        timestamp: 1779549202,
      },
    ]
    const { calls } = decodeHermes({ records: [makeComposite(BASE_SESSION, messages)], context })
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.provider).toBe('hermes')
    expect(call.model).toBe('claude-sonnet-4-20250514')
    expect(call.inputTokens).toBe(1000)
    expect(call.outputTokens).toBe(200)
    expect(call.cacheReadInputTokens).toBe(50)
    expect(call.cacheCreationInputTokens).toBe(10)
    expect(call.reasoningTokens).toBe(25)
    expect(call.tools).toEqual(['Read', 'Bash'])
    expect(call.rawBashCommands).toEqual(['npm test'])
    expect(call.userMessage).toBe('Implement Hermes support')
    expect(call.deduplicationKey).toBe('hermes:default:sess-a')
    expect(call.turnId).toBe('sess-a:session')
    expect(call.sessionId).toBe('sess-a')
    expect(call.project).toBe('Users-me-projects-codeburn')
    expect(call.projectPath).toBe('/Users/me/projects/codeburn')
    expect(call.recordedCost).toBeUndefined()
    expect(call).not.toHaveProperty('costUSD')
    expect(call).not.toHaveProperty('costBasis')
  })

  it('skips a zero-token session', () => {
    const session: HermesSessionRow = { ...BASE_SESSION, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0 }
    const { calls } = decodeHermes({ records: [makeComposite(session, [])], context })
    expect(calls).toHaveLength(0)
  })

  it('threads a live seenKeys set so a repeated session drops', () => {
    const messages: HermesMessageRow[] = [
      { id: 1, role: 'user', content: 'Hello', tool_calls: null, tool_name: null, timestamp: 1779549201 },
    ]
    const seen = new Set<string>()
    const first = decodeHermes({ records: [makeComposite(BASE_SESSION, messages)], context, seenKeys: seen }).calls
    expect(first).toHaveLength(1)
    const again = decodeHermes({ records: [makeComposite(BASE_SESSION, messages)], context, seenKeys: seen }).calls
    expect(again).toEqual([])
  })

  it('maps composio MCP tools before generic MCP prefixes', () => {
    const messages: HermesMessageRow[] = [
      {
        id: 1,
        role: 'assistant',
        content: null,
        tool_calls: JSON.stringify([
          { function: { name: 'mcp_composio_GMAIL_SEND_EMAIL', arguments: '{}' } },
          { function: { name: 'mcp__github__create_issue', arguments: '{}' } },
        ]),
        tool_name: null,
        timestamp: 1779549201,
      },
    ]
    const { calls } = decodeHermes({ records: [makeComposite(BASE_SESSION, messages)], context })
    expect(calls[0]!.tools).toEqual(['MCP', 'mcp__github__create_issue'])
  })

  it('maps browser_* tools to Browser', () => {
    const messages: HermesMessageRow[] = [
      {
        id: 1,
        role: 'assistant',
        content: null,
        tool_calls: JSON.stringify([
          { function: { name: 'browser_navigate', arguments: '{}' } },
          { function: { name: 'browser_click', arguments: '{}' } },
        ]),
        tool_name: null,
        timestamp: 1779549201,
      },
    ]
    const { calls } = decodeHermes({ records: [makeComposite(BASE_SESSION, messages)], context })
    expect(calls[0]!.tools).toEqual(['Browser'])
  })

  it('counts tool-result messages by their tool_name', () => {
    const messages: HermesMessageRow[] = [
      { id: 1, role: 'tool', content: null, tool_calls: null, tool_name: 'read_file', timestamp: 1779549201 },
    ]
    const { calls } = decodeHermes({ records: [makeComposite(BASE_SESSION, messages)], context })
    expect(calls[0]!.tools).toContain('Read')
  })

  it('falls back to unknown when model is missing', () => {
    const session: HermesSessionRow = { ...BASE_SESSION, model: null }
    const messages: HermesMessageRow[] = [
      { id: 1, role: 'user', content: 'Hello', tool_calls: null, tool_name: null, timestamp: 1779549201 },
    ]
    const { calls } = decodeHermes({ records: [makeComposite(session, messages)], context })
    expect(calls[0]!.model).toBe('unknown')
  })

  it('does not split multibyte characters when truncating the first user message', () => {
    const message = `${'a'.repeat(499)}😀truncated tail`
    const messages: HermesMessageRow[] = [
      { id: 1, role: 'user', content: message, tool_calls: null, tool_name: null, timestamp: 1779549201 },
    ]
    const { calls } = decodeHermes({ records: [makeComposite(BASE_SESSION, messages)], context })
    expect(calls[0]!.userMessage).toBe(`${'a'.repeat(499)}😀`)
  })

  it('prefers sessions.cwd over transcript project inference', () => {
    const messages: HermesMessageRow[] = [
      { id: 1, role: 'user', content: 'Current working directory: /tmp/decoy\nbuild it', tool_calls: null, tool_name: null, timestamp: 1779549201 },
    ]
    const { calls } = decodeHermes({ records: [makeComposite(BASE_SESSION, messages)], context })
    expect(calls[0]!.project).toBe('Users-me-projects-codeburn')
    expect(calls[0]!.projectPath).toBe('/Users/me/projects/codeburn')
  })

  it('infers project from transcript when sessions.cwd is absent', () => {
    const session: HermesSessionRow = { ...BASE_SESSION, cwd: null }
    const messages: HermesMessageRow[] = [
      { id: 1, role: 'user', content: 'Current working directory: /tmp/legacy-project\nbuild it', tool_calls: null, tool_name: null, timestamp: 1779549201 },
    ]
    const { calls } = decodeHermes({ records: [makeComposite(session, messages, 'legacy-profile')], context })
    expect(calls[0]!.project).toBe('tmp-legacy-project')
    expect(calls[0]!.projectPath).toBe('/tmp/legacy-project')
  })

  it('falls back to sanitized profile name when no project source exists', () => {
    const session: HermesSessionRow = { ...BASE_SESSION, cwd: null }
    const messages: HermesMessageRow[] = [
      { id: 1, role: 'user', content: 'Hello', tool_calls: null, tool_name: null, timestamp: 1779549201 },
    ]
    const { calls } = decodeHermes({ records: [makeComposite(session, messages, 'my profile')], context })
    expect(calls[0]!.project).toBe('my profile')
    expect(calls[0]!.projectPath).toBeUndefined()
  })

  it('chooses actual_cost_usd over estimated_cost_usd', () => {
    const session: HermesSessionRow = {
      ...BASE_SESSION,
      estimated_cost_usd: 0.99,
      actual_cost_usd: 0.123,
    }
    const messages: HermesMessageRow[] = [
      { id: 1, role: 'user', content: 'Hello', tool_calls: null, tool_name: null, timestamp: 1779549201 },
    ]
    const { calls } = decodeHermes({ records: [makeComposite(session, messages)], context })
    expect(calls[0]!.recordedCost).toBe(0.123)
  })

  it('falls back to estimated_cost_usd when actual_cost_usd is zero/null', () => {
    const session: HermesSessionRow = {
      ...BASE_SESSION,
      estimated_cost_usd: 0.456,
      actual_cost_usd: 0,
    }
    const messages: HermesMessageRow[] = [
      { id: 1, role: 'user', content: 'Hello', tool_calls: null, tool_name: null, timestamp: 1779549201 },
    ]
    const { calls } = decodeHermes({ records: [makeComposite(session, messages)], context })
    expect(calls[0]!.recordedCost).toBe(0.456)
  })

  it('omits recordedCost when no cost is recorded', () => {
    const session: HermesSessionRow = {
      ...BASE_SESSION,
      estimated_cost_usd: 0,
      actual_cost_usd: null,
    }
    const messages: HermesMessageRow[] = [
      { id: 1, role: 'user', content: 'Hello', tool_calls: null, tool_name: null, timestamp: 1779549201 },
    ]
    const { calls } = decodeHermes({ records: [makeComposite(session, messages)], context })
    expect(calls[0]!.recordedCost).toBeUndefined()
  })

  it('toObservations produces a schema-valid, content-free envelope', () => {
    const messages: HermesMessageRow[] = [
      { id: 1, role: 'user', content: 'Implement Hermes support', tool_calls: null, tool_name: null, timestamp: 1779549201 },
      {
        id: 2,
        role: 'assistant',
        content: null,
        tool_calls: JSON.stringify([
          { function: { name: 'read_file', arguments: JSON.stringify({ path: '/tmp/hermes.ts' }) } },
        ]),
        tool_name: null,
        timestamp: 1779549202,
      },
    ]
    const { calls } = decodeHermes({ records: [makeComposite(BASE_SESSION, messages)], context })
    const { sessions } = toObservations(
      { sessionId: 'sess-a', projectPath: '/Users/me/projects/codeburn', calls },
      { privacyKey: 'test-privacy-key', provider: 'hermes' },
    )
    const envelope = {
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      generator: { name: '@codeburn/core', version: '0.0.0-test' },
      fingerprints: { algorithm: 'hmac-sha256-128', keyId: 'test-key' },
      sessions,
    }
    expect(ObservationEnvelope.safeParse(envelope).success).toBe(true)
    const reads = sessions.flatMap(s => s.calls.flatMap(c => c.resourceReads ?? []))
    expect(reads.length).toBeGreaterThan(0)
    for (const ref of reads) expect(ref.resourceId).toMatch(/^[0-9a-f]{32}$/)
  })

  it('toObservations emits measured cost when recordedCost is present', () => {
    const session: HermesSessionRow = { ...BASE_SESSION, actual_cost_usd: 1.23 }
    const messages: HermesMessageRow[] = [
      { id: 1, role: 'user', content: 'Hello', tool_calls: null, tool_name: null, timestamp: 1779549201 },
    ]
    const { calls } = decodeHermes({ records: [makeComposite(session, messages)], context })
    const { sessions } = toObservations(
      { sessionId: 'sess-a', projectPath: '/Users/me/projects/codeburn', calls },
      { privacyKey: 'test-privacy-key', provider: 'hermes' },
    )
    const call = sessions[0]!.calls[0]!
    expect(call.costBasis).toBe('measured')
    expect(call.measuredCostUSD).toBe(1.23)
  })
})
