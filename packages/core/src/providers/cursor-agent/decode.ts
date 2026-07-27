// @codeburn/core Cursor Agent decoder: pure decode over host-supplied records.
// The host reads the sqlite summary and the transcript file; this decoder parses
// the transcript into user/assistant turns and maps each turn to a rich, cost-free
// call. No fs / env / clock / sqlite / pricing / strip-ansi.

import type { DecodeContext } from '../../contracts.js'
import type { RecordDiagnostic } from '../../diagnostics.js'
import type {
  AssistantTurn,
  ConversationSummaryRow,
  CursorAgentDecodedCall,
  CursorAgentRecord,
  ParsedTurn,
} from './types.js'

const CHARS_PER_TOKEN = 4
const MAX_USER_TEXT_LENGTH = 500
const DIGITS_ONLY = /^\d+$/
const USER_MARKER = /^\s*user:\s*/i
const ASSISTANT_MARKER = /^\s*A:\s*/
const THINKING_MARKER = /^\s*\[Thinking\]\s*/
const TOOL_CALL_MARKER = /^\s*\[Tool call\]\s*(.+?)\s*$/i
const TOOL_RESULT_MARKER = /^\s*\[Tool result\]\b/i
const USER_QUERY_OPEN = '<user_query>'
const USER_QUERY_CLOSE = '</user_query>'

function estimateTokens(charCount: number): number {
  if (charCount <= 0) return 0
  return Math.ceil(charCount / CHARS_PER_TOKEN)
}

function parseToolName(raw: string): string {
  const clean = raw.trim()
  if (clean.length === 0) return 'unknown'
  return clean.toLowerCase().replace(/\s+/g, '-')
}

function normalizeTimestamp(raw: string | number | null | undefined): string | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (trimmed.length === 0) return null
    if (DIGITS_ONLY.test(trimmed)) {
      const num = Number(trimmed)
      if (!Number.isNaN(num)) {
        const ms = num < 1e12 ? num * 1000 : num
        return new Date(ms).toISOString()
      }
    }
    const parsed = new Date(trimmed)
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()
    return null
  }

  const ms = raw < 1e12 ? raw * 1000 : raw
  return new Date(ms).toISOString()
}

function extractUserQuery(userBlock: string): string {
  const chunks: string[] = []
  let cursor = 0

  while (cursor < userBlock.length) {
    const openIndex = userBlock.indexOf(USER_QUERY_OPEN, cursor)
    if (openIndex === -1) break
    const start = openIndex + USER_QUERY_OPEN.length
    const closeIndex = userBlock.indexOf(USER_QUERY_CLOSE, start)
    if (closeIndex === -1) {
      chunks.push(userBlock.slice(start).trim())
      break
    }
    chunks.push(userBlock.slice(start, closeIndex).trim())
    cursor = closeIndex + USER_QUERY_CLOSE.length
  }

  const combined = chunks.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
  return combined.slice(0, MAX_USER_TEXT_LENGTH)
}

function normalizeContentBlocks<T extends { type?: string; text?: string }>(
  content: T[] | string | null | undefined,
): T[] {
  if (Array.isArray(content)) {
    const isBlock = (b: T): boolean => b != null && typeof b === 'object'
    return content.every(isBlock) ? content : content.filter(isBlock)
  }
  if (typeof content === 'string') return [{ type: 'text', text: content } as T]
  return []
}

function parseJsonlTranscript(raw: string): { turns: ParsedTurn[]; recognized: boolean } {
  const lines = raw.split(/\r?\n/).filter(l => l.trim())
  if (lines.length === 0) return { turns: [], recognized: false }

  const turns: ParsedTurn[] = []
  let currentUserMessage = ''

  for (const line of lines) {
    let entry: { role?: string; message?: { content?: Array<{ type?: string; text?: string; name?: string }> } }
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }

    if (entry.role === 'user') {
      const texts = normalizeContentBlocks(entry.message?.content)
        .filter(c => c.type === 'text')
        .map(c => c.text ?? '')
      const combined = texts.join(' ')
      currentUserMessage = extractUserQuery(combined) || combined.slice(0, MAX_USER_TEXT_LENGTH)
      continue
    }

    if (entry.role === 'assistant' && currentUserMessage) {
      const content = normalizeContentBlocks(entry.message?.content)
      const bodyParts: string[] = []
      const tools: string[] = []

      for (const block of content) {
        if (block.type === 'text' && block.text) {
          bodyParts.push(block.text)
        } else if (block.type === 'tool_use' && block.name) {
          tools.push(`cursor:${block.name.toLowerCase()}`)
        }
      }

      turns.push({
        userMessage: currentUserMessage,
        assistant: {
          body: bodyParts.join('\n').trim(),
          reasoning: '',
          tools,
        },
      })
      currentUserMessage = ''
    }
  }

  return { turns, recognized: turns.length > 0 }
}

function parseTranscript(raw: string): { turns: ParsedTurn[]; recognized: boolean } {
  const lines = raw.split(/\r?\n/)
  let recognized = false

  const pendingUsers: string[] = []
  const turns: ParsedTurn[] = []

  let active: 'none' | 'user' | 'assistant' = 'none'
  let userLines: string[] = []
  let assistantLines: string[] = []

  const flushUser = () => {
    if (userLines.length === 0) return
    const userQuery = extractUserQuery(userLines.join('\n'))
    if (userQuery.length > 0) pendingUsers.push(userQuery)
    userLines = []
  }

  const flushAssistant = () => {
    if (assistantLines.length === 0) return

    let output = ''
    let reasoning = ''
    const toolsByTurn = new Map<string, true>()

    for (const line of assistantLines) {
      if (TOOL_RESULT_MARKER.test(line)) continue

      const thinkingMatch = line.match(THINKING_MARKER)
      if (thinkingMatch) {
        const body = line.replace(THINKING_MARKER, '').trim()
        if (body.length > 0) reasoning += `${body}\n`
        continue
      }

      const toolMatch = line.match(TOOL_CALL_MARKER)
      if (toolMatch) {
        const parsedTool = parseToolName(toolMatch[1] ?? '')
        const toolKey = `cursor:${parsedTool}`
        toolsByTurn.set(toolKey, true)
        continue
      }

      output += `${line}\n`
    }

    if (pendingUsers.length > 0) {
      const userMessage = pendingUsers.shift()!
      const tools = Array.from(toolsByTurn.keys())
      turns.push({
        userMessage,
        assistant: {
          body: output.trim(),
          reasoning: reasoning.trim(),
          tools,
        },
      })
    }

    assistantLines = []
  }

  for (const line of lines) {
    if (USER_MARKER.test(line)) {
      recognized = true
      if (active === 'user') flushUser()
      if (active === 'assistant') flushAssistant()
      active = 'user'
      userLines = [line.replace(USER_MARKER, '')]
      continue
    }

    if (ASSISTANT_MARKER.test(line)) {
      recognized = true
      if (active === 'user') flushUser()
      if (active === 'assistant') flushAssistant()
      active = 'assistant'
      assistantLines = [line.replace(ASSISTANT_MARKER, '')]
      continue
    }

    if (active === 'user') {
      userLines.push(line)
      continue
    }

    if (active === 'assistant') {
      assistantLines.push(line)
    }
  }

  if (active === 'user') flushUser()
  if (active === 'assistant') flushAssistant()

  return { turns, recognized }
}

function resolveModel(raw: string | null | undefined): string {
  if (!raw || raw === 'default') return 'cursor-agent-auto'
  return raw
}

export type CursorAgentDecodeInput = {
  records: unknown[]
  context: DecodeContext
  // Optional live dedup set the host mutates in place (its shared cross-file
  // seenKeys). Simple sqlite providers never persist resume state, so there is
  // no serialized `seenKeys` fallback.
  seenKeys?: Set<string>
}

export type CursorAgentDecodeResult = {
  calls: CursorAgentDecodedCall[]
  diagnostics: RecordDiagnostic[]
}

/**
 * Decode one Cursor Agent source (host-supplied sqlite summary + transcript +
 * file mtime) into rich, cost-free calls. Dedup is keyed on
 * `cursor-agent:<conversationId>:<turnIndex>` against the live `seenKeys` set
 * (host-owned).
 */
// `context` is part of the decode contract but the rich layer never consumes it:
// minimization / fingerprinting happens in toObservations.
export function decodeCursorAgent({ records, seenKeys: liveSeen }: CursorAgentDecodeInput): CursorAgentDecodeResult {
  const seen = liveSeen ?? new Set<string>()
  const calls: CursorAgentDecodedCall[] = []
  const diagnostics: RecordDiagnostic[] = []

  const composite = records[0] as CursorAgentRecord | undefined
  if (!composite || typeof composite !== 'object') return { calls, diagnostics }

  const { summary, transcript, transcriptPath, fileMtime, conversationId } = composite
  const isJsonl = transcriptPath.endsWith('.jsonl')
  const parsed = isJsonl ? parseJsonlTranscript(transcript) : parseTranscript(transcript)

  // The pre-migration decode warned once per transcript whose parse produced
  // nothing recognizable. Reported as a diagnostic so the host can re-emit it.
  if (!parsed.recognized) {
    diagnostics.push({ index: 0, code: 'unknown-shape' })
    return { calls, diagnostics }
  }

  const timestamp = normalizeTimestamp(summary?.updatedAt) ?? fileMtime
  const model = resolveModel(summary?.model ?? null)

  for (let turnIndex = 0; turnIndex < parsed.turns.length; turnIndex++) {
    const turn = parsed.turns[turnIndex]!
    const inputTokens = estimateTokens(turn.userMessage.length)
    const outputTokens = estimateTokens(turn.assistant.body.length)
    const reasoningTokens = estimateTokens(turn.assistant.reasoning.length)
    const deduplicationKey = `cursor-agent:${conversationId}:${turnIndex}`

    if (seen.has(deduplicationKey)) continue
    seen.add(deduplicationKey)

    calls.push({
      provider: 'cursor-agent',
      model,
      inputTokens,
      outputTokens,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens,
      webSearchRequests: 0,
      tools: turn.assistant.tools,
      rawBashCommands: [],
      timestamp,
      speed: 'standard',
      deduplicationKey,
      userMessage: turn.userMessage,
      sessionId: conversationId,
    })
  }

  return { calls, diagnostics }
}
