// @codeburn/core Goose decoder: pure decode over a host-supplied composite
// session record (session row + assistant tool-message rows + first user
// message row, all BLOB columns already converted to text host-side). No
// fs/env/sqlite/pricing/clock here — the pre-migration decode fell back to
// `new Date()` when both timestamp columns were unparseable; that clock read
// stays host-side (the CLI's `toProviderCall` applies it), so this decoder
// emits an empty timestamp in that case instead.

import type { DecodeContext } from '../../contracts.js'
import type { RecordDiagnostic } from '../../diagnostics.js'
import type {
  GooseContentItem,
  GooseDecodedCall,
  GooseMessageRow,
  GooseModelConfig,
  GooseSessionRecords,
  GooseToolCall,
} from './types.js'

export const gooseToolNameMap: Record<string, string> = {
  developer__shell: 'Bash',
  developer__text_editor: 'Edit',
  developer__read_file: 'Read',
  developer__write_file: 'Write',
  developer__list_directory: 'LS',
  developer__search_files: 'Grep',
  computercontroller__shell: 'Bash',
}

function parseModelConfig(raw: string | null): GooseModelConfig {
  if (!raw) return {}
  try {
    return JSON.parse(raw) as GooseModelConfig
  } catch {
    return {}
  }
}

function extractToolsFromMessages(messages: GooseMessageRow[]): { tools: string[]; rawBashCommands: string[]; toolSequence: GooseToolCall[][] } {
  const tools: string[] = []
  const rawBashCommands: string[] = []
  const seen = new Set<string>()
  const toolSequence: GooseToolCall[][] = []

  for (const row of messages) {
    let items: GooseContentItem[]
    try {
      items = JSON.parse(row.contentJson) as GooseContentItem[]
    } catch {
      continue
    }
    const msgCalls: GooseToolCall[] = []
    for (const item of items) {
      if (item.type !== 'toolRequest') continue
      const rawName = item.toolCall?.value?.name ?? ''
      if (!rawName) continue
      const mapped = gooseToolNameMap[rawName] ?? rawName.split('__').pop() ?? rawName
      if (!seen.has(mapped)) {
        seen.add(mapped)
        tools.push(mapped)
      }
      const call: GooseToolCall = { tool: mapped }
      const args = item.toolCall?.value?.arguments
      if (args && typeof args === 'object') {
        const fp = (args as Record<string, unknown>)['file_path']
        if (typeof fp === 'string') call.file = fp
        const cmd = (args as Record<string, unknown>)['command']
        if (typeof cmd === 'string') call.command = cmd
      }
      msgCalls.push(call)
      if (mapped === 'Bash') {
        const cmd = args && typeof args === 'object' ? (args as Record<string, unknown>)['command'] : undefined
        if (typeof cmd === 'string') rawBashCommands.push(cmd)
      }
    }
    if (msgCalls.length > 0) toolSequence.push(msgCalls)
  }

  return { tools, rawBashCommands, toolSequence }
}

function getFirstUserMessage(row: GooseMessageRow | null): string {
  if (!row) return ''
  try {
    const items = JSON.parse(row.contentJson) as GooseContentItem[]
    const text = items.find(i => i.type === 'text') as { text?: string } | undefined
    return (text?.text ?? '').slice(0, 500)
  } catch {
    return ''
  }
}

// Resolve updated_at/created_at into an ISO timestamp, exactly as the
// pre-migration decode did, EXCEPT the final `new Date()` (current time)
// fallback: that clock read is not deterministic and must stay host-side, so
// this returns '' when neither column parses.
function resolveTimestamp(updatedAt: string | null, createdAt: string | null): string {
  const raw = updatedAt || createdAt || ''
  let ts = new Date(raw)
  if (isNaN(ts.getTime())) ts = new Date(raw + 'Z')
  if (isNaN(ts.getTime())) return ''
  return ts.toISOString()
}

function isGooseSessionRecords(value: unknown): value is GooseSessionRecords {
  return value !== null && typeof value === 'object' && 'session' in (value as object) && 'assistantToolMessages' in (value as object)
}

export type GooseDecodeInput = {
  records: unknown[]
  context: DecodeContext
  seenKeys?: Set<string>
}

export type GooseDecodeResult = {
  calls: GooseDecodedCall[]
  diagnostics: RecordDiagnostic[]
}

/**
 * Decode one Goose session's composite record into a single rich, cost-free
 * call. A session with zero accumulated tokens is skipped; dedup is keyed on
 * `goose:<sessionId>` against the live `seenKeys` set (host-owned).
 * `toolSequence` is included only when it has MORE THAN ONE turn (matches the
 * pre-migration `toolSequence.length > 1 ? toolSequence : undefined` exactly).
 */
export function decodeGoose({ records, seenKeys: liveSeen }: GooseDecodeInput): GooseDecodeResult {
  const seen = liveSeen ?? new Set<string>()
  const calls: GooseDecodedCall[] = []

  const session = records.find(isGooseSessionRecords)
  if (!session) return { calls, diagnostics: [] }

  const { sessionId, session: sessionRow, assistantToolMessages, firstUserMessage } = session

  const inputTokens = sessionRow.accumulatedInputTokens ?? 0
  const outputTokens = sessionRow.accumulatedOutputTokens ?? 0
  if (inputTokens === 0 && outputTokens === 0) return { calls, diagnostics: [] }

  const dedupKey = `goose:${sessionId}`
  if (seen.has(dedupKey)) return { calls, diagnostics: [] }
  seen.add(dedupKey)

  const config = parseModelConfig(sessionRow.modelConfigJson)
  const model = config.model_name ?? 'unknown'

  const { tools, rawBashCommands, toolSequence } = extractToolsFromMessages(assistantToolMessages)
  const userMessage = getFirstUserMessage(firstUserMessage)

  calls.push({
    provider: 'goose',
    model,
    inputTokens,
    outputTokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
    tools,
    rawBashCommands,
    toolSequence: toolSequence.length > 1 ? toolSequence : undefined,
    timestamp: resolveTimestamp(sessionRow.updatedAt, sessionRow.createdAt),
    speed: 'standard',
    deduplicationKey: dedupKey,
    userMessage,
    sessionId,
  })

  return { calls, diagnostics: [] }
}
