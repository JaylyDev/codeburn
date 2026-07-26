import { describe, expect, it } from 'vitest'

import {
  compactEntry,
  decodeAdvisorCalls,
  decodeAssistantCall,
  dedupeStreamingMessageIds,
  groupIntoTurns,
  parseJsonlLine,
} from '../../src/providers/claude/index.js'
import type { JournalEntry } from '../../src/providers/claude/index.js'

function assistantLine(id: string, ts: string, opts: { model?: string; input?: number; output?: number; content?: unknown[]; speed?: string } = {}): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    sessionId: 's1',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: opts.model ?? 'claude-opus-4-8',
      usage: { input_tokens: opts.input ?? 100, output_tokens: opts.output ?? 20, cache_read_input_tokens: 5, ...(opts.speed ? { speed: opts.speed } : {}) },
      content: opts.content ?? [],
    },
  })
}

function userLine(text: string, ts: string): string {
  return JSON.stringify({ type: 'user', timestamp: ts, sessionId: 's1', message: { role: 'user', content: text } })
}

describe('claude rich decode (moved to @codeburn/core)', () => {
  it('decodes an assistant message into a cost-free DecodedCall carrying tokens/tools/meta', () => {
    const entry = parseJsonlLine(assistantLine('msg_1', '2026-07-17T10:00:00.000Z', {
      content: [
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls -la' } },
        { type: 'tool_use', id: 't2', name: 'mcp__server__do', input: {} },
      ],
    }))!
    const call = decodeAssistantCall(compactEntry(entry))!
    expect(call.provider).toBe('claude')
    expect(call.model).toBe('claude-opus-4-8')
    expect(call.usage.inputTokens).toBe(100)
    expect(call.usage.outputTokens).toBe(20)
    expect(call.usage.cacheReadInputTokens).toBe(5)
    expect(call.tools).toEqual(['Bash', 'mcp__server__do'])
    expect(call.mcpTools).toEqual(['mcp__server__do'])
    expect(call.rawBashCommands).toEqual(['ls -la'])
    // No pricing crosses into the decode layer.
    expect(call as Record<string, unknown>).not.toHaveProperty('costUSD')
    expect(call as Record<string, unknown>).not.toHaveProperty('savingsUSD')
  })

  it('returns null for non-assistant entries and messages without usage/model', () => {
    expect(decodeAssistantCall({ type: 'user', message: { role: 'user', content: 'hi' } } as JournalEntry)).toBeNull()
    expect(decodeAssistantCall({ type: 'assistant', message: { type: 'message', role: 'assistant', content: [] } } as unknown as JournalEntry)).toBeNull()
  })

  it('emits advisor_message iterations as separate cost-free calls under their own model', () => {
    const raw = JSON.parse(assistantLine('msg_2', '2026-07-17T10:01:00.000Z')) as JournalEntry
    ;(raw.message as { usage: Record<string, unknown> }).usage.iterations = [
      { type: 'advisor_message', model: 'claude-sonnet-4', input_tokens: 40, output_tokens: 8 },
      { type: 'message', model: 'ignore-me', input_tokens: 999 },
    ]
    const advisors = decodeAdvisorCalls(raw)
    expect(advisors).toHaveLength(1)
    expect(advisors[0]!.model).toBe('claude-sonnet-4')
    expect(advisors[0]!.usage.inputTokens).toBe(40)
    expect(advisors[0]!.deduplicationKey).toBe('msg_2:advisor:0')
  })

  it('groups user/assistant entries into turns and dedupes streamed message ids', () => {
    const lines = [
      userLine('first task', '2026-07-17T10:00:00.000Z'),
      assistantLine('msg_a', '2026-07-17T10:00:01.000Z'),
      assistantLine('msg_a', '2026-07-17T10:00:02.000Z'), // streamed restatement of same id
      userLine('second task', '2026-07-17T10:05:00.000Z'),
      assistantLine('msg_b', '2026-07-17T10:05:01.000Z'),
    ]
    const entries = lines.map(l => compactEntry(parseJsonlLine(l)!))
    const turns = groupIntoTurns(dedupeStreamingMessageIds(entries), new Set<string>())
    expect(turns).toHaveLength(2)
    expect(turns[0]!.userMessage).toBe('first task')
    expect(turns[0]!.assistantCalls).toHaveLength(1) // streamed dup collapsed
    expect(turns[1]!.userMessage).toBe('second task')
  })

  it('scans a >32KB assistant line via the buffer path identically to JSON.parse', () => {
    const bigCommand = 'x'.repeat(40 * 1024)
    const line = assistantLine('msg_big', '2026-07-17T10:10:00.000Z', {
      content: [{ type: 'tool_use', id: 'tb', name: 'Bash', input: { command: bigCommand } }],
    })
    expect(line.length).toBeGreaterThan(32 * 1024)
    const fromBuffer = parseJsonlLine(Buffer.from(line, 'utf-8'))!
    const call = decodeAssistantCall(compactEntry(fromBuffer))!
    expect(call.model).toBe('claude-opus-4-8')
    // command captured but capped at 2000 chars by the large-line scanner.
    expect(call.rawBashCommands[0]!.length).toBe(2000)
  })
})
