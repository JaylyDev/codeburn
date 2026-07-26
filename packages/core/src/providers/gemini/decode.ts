// @codeburn/core Gemini decoder: pure decode over a host-supplied session.
// The host reads the JSON/JSONL file; this decoder extracts token buckets,
// tool calls, and user message threading with no fs, env, clock, or pricing.

import type { DecodeContext } from '../../contracts.js'
import type { RecordDiagnostic } from '../../diagnostics.js'
import type { GeminiDecodedCall, GeminiMessage, GeminiSession } from './types.js'

// Gemini tool ids mapped to the canonical vocabulary. Unknown ids pass through.
export const geminiToolNameMap: Record<string, string> = {
  read_file: 'Read',
  write_file: 'Write',
  edit_file: 'Edit',
  create_file: 'Write',
  delete_file: 'Delete',
  list_dir: 'LS',
  grep_search: 'Grep',
  search_files: 'Grep',
  find_files: 'Glob',
  run_command: 'Bash',
  web_search: 'WebSearch',
  ReadFile: 'Read',
  WriteFile: 'Write',
  EditFile: 'Edit',
  ListDir: 'LS',
  SearchText: 'Grep',
  Shell: 'Bash',
}

// Reconstruct a session from headerless JSONL lines (Gemini CLI >=0.39): a
// header line carrying sessionId/startTime, plus one line per message. Moved
// verbatim from the CLI's `parseJsonl`.
function parseGeminiJsonl(raw: string): GeminiSession | null {
  const lines = raw.split('\n').filter(l => l.trim())
  if (lines.length === 0) return null

  let sessionId = ''
  let startTime = ''
  let projectHash: string | undefined
  let lastUpdated: string | undefined
  let kind: string | undefined
  const messages: GeminiMessage[] = []

  for (const line of lines) {
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    if (obj['$set'] !== undefined) continue
    if (obj['sessionId'] && obj['startTime'] && !sessionId) {
      sessionId = obj['sessionId'] as string
      startTime = obj['startTime'] as string
      projectHash = obj['projectHash'] as string | undefined
      lastUpdated = obj['lastUpdated'] as string | undefined
      kind = obj['kind'] as string | undefined
    } else if (obj['id'] && obj['type']) {
      messages.push(obj as unknown as GeminiMessage)
    }
  }

  if (!sessionId) return null
  return { sessionId, projectHash, startTime, lastUpdated, kind, messages }
}

// Try single JSON first (Gemini CLI <=0.38), then JSONL (>=0.39). Moved
// verbatim from the CLI's `createParser`.
function parseGeminiRaw(raw: string): GeminiSession | null {
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && parsed.messages && parsed.sessionId) {
      return parsed as GeminiSession
    }
  } catch { /* not single JSON */ }

  return parseGeminiJsonl(raw)
}

export type GeminiDecodeInput = {
  // records[0] is the full raw text of one session file (single JSON object or
  // headerless JSONL); the host does no parsing, only the read.
  records: unknown[]
  context: DecodeContext
  seenKeys?: Set<string>
}

export type GeminiDecodeResult = {
  calls: GeminiDecodedCall[]
  diagnostics: RecordDiagnostic[]
}

/**
 * Decode a Gemini session (single JSON or JSONL) into rich, cost-free calls.
 * User messages set pending prompt; Gemini messages with token usage flush into
 * calls. Dedup is keyed on `gemini:<sessionId>:<messageId>` against live seenKeys.
 */
export function decodeGemini({ records, seenKeys: liveSeen }: GeminiDecodeInput): GeminiDecodeResult {
  const seen = liveSeen ?? new Set<string>()
  const calls: GeminiDecodedCall[] = []
  const diagnostics: RecordDiagnostic[] = []

  const raw = records[0]
  const data = typeof raw === 'string' ? parseGeminiRaw(raw) : null
  if (!data?.messages || !data.sessionId) return { calls, diagnostics }

  let lastUserMessage = ''
  let turnOrdinal = 0
  let currentTurnId = `${data.sessionId}:prelude`
  let geminiOrdinal = 0

  for (const msg of data.messages) {
    if (msg.type === 'user') {
      if (Array.isArray(msg.content)) {
        lastUserMessage = msg.content.map(c => c.text).join(' ').slice(0, 500)
      } else if (typeof msg.content === 'string') {
        lastUserMessage = msg.content.slice(0, 500)
      }
      currentTurnId = `${data.sessionId}:turn-${turnOrdinal++}`
      continue
    }

    if (msg.type !== 'gemini' || !msg.tokens || !msg.model) continue

    const t = msg.tokens
    const totalInput = t.input ?? 0
    const totalOutput = t.output ?? 0
    const totalCached = t.cached ?? 0
    const totalThoughts = t.thoughts ?? 0
    if (totalInput === 0 && totalOutput === 0 && totalCached === 0 && totalThoughts === 0) continue

    const messageKey = msg.id || `idx-${geminiOrdinal}`
    geminiOrdinal++
    const dedupKey = `gemini:${data.sessionId}:${messageKey}`
    if (seen.has(dedupKey)) continue

    const tools: string[] = []
    const bashCommands: string[] = []

    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        const mapped = geminiToolNameMap[tc.displayName ?? ''] ?? geminiToolNameMap[tc.name] ?? tc.displayName ?? tc.name
        tools.push(mapped)
        if (mapped === 'Bash' && tc.args && typeof tc.args.command === 'string') {
          bashCommands.push(tc.args.command)
        }
      }
    }

    // Gemini's `input` count includes `cached` tokens as a subset, so fresh
    // input must subtract cached to avoid double-charging at both rates.
    const freshInput = Math.max(0, totalInput - totalCached)

    const tsDate = new Date(msg.timestamp || data.startTime)
    if (isNaN(tsDate.getTime()) || tsDate.getTime() < 1_000_000_000_000) continue

    seen.add(dedupKey)

    calls.push({
      provider: 'gemini',
      model: msg.model,
      inputTokens: freshInput,
      outputTokens: totalOutput,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: totalCached,
      cachedInputTokens: totalCached,
      reasoningTokens: totalThoughts,
      webSearchRequests: 0,
      tools: [...new Set(tools)],
      rawBashCommands: bashCommands,
      timestamp: tsDate.toISOString(),
      speed: 'standard',
      deduplicationKey: dedupKey,
      turnId: currentTurnId,
      userMessage: lastUserMessage,
      sessionId: data.sessionId,
    })
  }

  return { calls, diagnostics }
}
