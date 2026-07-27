// @codeburn/core Mistral Vibe decoder: pure decode over host-supplied records.
//
// The host reads `meta.json` and `messages.jsonl` and hands this decoder a record
// array whose first element is `{ metadata, sessionCost }` and whose remaining
// elements are the parsed messages. No fs/env/clock/pricing here: the host
// resolves the session-level dollar figure (including any generic price-table
// fallback), and this decoder only performs the pure arithmetic of allocating
// that figure and the session token totals evenly across the session's assistant
// messages.

import type { DecodeContext } from '../../contracts.js'
import type { RecordDiagnostic } from '../../diagnostics.js'
import type {
  MistralVibeDecodedCall,
  MistralVibeSessionRecord,
  VibeMessage,
  VibeMetadata,
  VibeModelConfig,
} from './types.js'

const DEFAULT_MODEL = 'mistral-medium-3.5'

// Mistral Vibe tool ids mapped to the canonical vocabulary. Unknown ids pass
// through unchanged so provider-native tools still show up.
export const mistralVibeToolNameMap: Record<string, string> = {
  bash: 'Bash',
  read_file: 'Read',
  write_file: 'Write',
  search_replace: 'Edit',
  grep: 'Grep',
  task: 'Agent',
  todo: 'TodoWrite',
  skill: 'Skill',
  web_fetch: 'WebFetch',
  web_search: 'WebSearch',
  ask_user_question: 'AskUser',
  exit_plan_mode: 'ExitPlanMode',
}

export type MistralVibeDecodeInput = {
  records: unknown[]
  context: DecodeContext
  // Optional live dedup set the host mutates in place. Threaded exactly like
  // qwen/codex; simple JSONL providers never persist resume state.
  seenKeys?: Set<string>
}

export type MistralVibeDecodeResult = {
  calls: MistralVibeDecodedCall[]
  diagnostics: RecordDiagnostic[]
}

function safeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function activeModelConfig(metadata: VibeMetadata): VibeModelConfig | null {
  const activeModel = metadata.config?.active_model
  const models = metadata.config?.models
  if (!activeModel || !Array.isArray(models)) return null
  return models.find(m => m.alias === activeModel || m.name === activeModel) ?? null
}

function resolveModel(metadata: VibeMetadata): string {
  const activeModel = metadata.config?.active_model
  if (activeModel) return activeModel
  const configured = activeModelConfig(metadata)
  return configured?.alias ?? configured?.name ?? DEFAULT_MODEL
}

function normalizeContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') return part.text
        return ''
      })
      .filter(Boolean)
      .join(' ')
  }
  return ''
}

function parseToolArguments(raw: string | Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!raw) return {}
  if (typeof raw === 'object') return raw
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function extractMessageTools(message: VibeMessage): { tools: string[]; rawBashCommands: string[] } {
  const tools: string[] = []
  const rawBashCommands: string[] = []

  if (message.role !== 'assistant') return { tools, rawBashCommands }

  for (const toolCall of message.tool_calls ?? []) {
    const rawName = toolCall.function?.name
    if (!rawName) continue

    const mappedName = mistralVibeToolNameMap[rawName] ?? rawName
    tools.push(mappedName)

    if (mappedName !== 'Bash') continue
    const args = parseToolArguments(toolCall.function?.arguments)
    const command = args['command']
    if (typeof command === 'string') {
      rawBashCommands.push(command)
    }
  }

  return {
    tools: [...new Set(tools)],
    rawBashCommands: [...new Set(rawBashCommands)],
  }
}

function extractTools(messages: VibeMessage[]): { tools: string[]; rawBashCommands: string[] } {
  const tools: string[] = []
  const rawBashCommands: string[] = []

  for (const message of messages) {
    const extracted = extractMessageTools(message)
    tools.push(...extracted.tools)
    rawBashCommands.push(...extracted.rawBashCommands)
  }

  return {
    tools: [...new Set(tools)],
    rawBashCommands: [...new Set(rawBashCommands)],
  }
}

function firstUserMessage(messages: VibeMessage[], fallback?: string | null): string {
  for (const message of messages) {
    if (message.role !== 'user') continue
    const text = normalizeContent(message.content).trim()
    if (text) return text.slice(0, 500)
  }
  return (fallback ?? '').slice(0, 500)
}

function allocateInteger(total: number, index: number, count: number): number {
  if (count <= 1) return total
  const base = Math.floor(total / count)
  const remainder = total % count
  return base + (index < remainder ? 1 : 0)
}

function allocateCost(total: number, count: number): number {
  return count <= 1 ? total : total / count
}

/**
 * Decode Mistral Vibe session records into rich, measured calls. The host
 * resolves the session-level cost and this decoder allocates it (and the session
 * token totals) evenly across assistant messages.
 *
 * Dedup is keyed on `mistral-vibe:<sessionId>:<messageId>` against the live
 * `seenKeys` set (host-owned). The allocation arithmetic is intentionally kept
 * byte-identical to the pre-migration in-CLI decode.
 */
export function decodeMistralVibe({ records, seenKeys: liveSeen }: MistralVibeDecodeInput): MistralVibeDecodeResult {
  const seen = liveSeen ?? new Set<string>()
  const calls: MistralVibeDecodedCall[] = []
  const diagnostics: RecordDiagnostic[] = []

  if (records.length === 0) return { calls, diagnostics }

  const sessionRecord = records[0] as MistralVibeSessionRecord
  const metadata = sessionRecord.metadata ?? {}
  const sessionCost = typeof sessionRecord.sessionCost === 'number' && Number.isFinite(sessionRecord.sessionCost)
    ? sessionRecord.sessionCost
    : 0

  const stats = metadata.stats ?? {}
  const inputTokens = safeNumber(stats.session_prompt_tokens)
  const outputTokens = safeNumber(stats.session_completion_tokens)
  if (inputTokens === 0 && outputTokens === 0) return { calls, diagnostics }

  const sessionId = metadata.session_id || sessionRecord.sessionIdFallback || ''
  const messages = records.slice(1) as VibeMessage[]
  const model = resolveModel(metadata)
  const assistantMessages = messages.filter(m => m.role === 'assistant')
  const fallbackTimestamp = metadata.end_time ?? metadata.start_time ?? ''

  if (assistantMessages.length === 0) {
    const deduplicationKey = `mistral-vibe:${sessionId}`
    if (seen.has(deduplicationKey)) return { calls, diagnostics }
    seen.add(deduplicationKey)
    const { tools, rawBashCommands } = extractTools(messages)

    calls.push({
      provider: 'mistral-vibe',
      model,
      inputTokens,
      outputTokens,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      measuredCostUSD: sessionCost,
      tools,
      rawBashCommands,
      timestamp: fallbackTimestamp,
      speed: 'standard',
      deduplicationKey,
      userMessage: firstUserMessage(messages, metadata.title),
      sessionId,
    })
    return { calls, diagnostics }
  }

  let currentUserMessage = (metadata.title ?? '').slice(0, 500)
  let turnOrdinal = 0
  let currentTurnId = `${sessionId}:prelude`
  let assistantOrdinal = 0

  for (const message of messages) {
    if (message.role === 'user') {
      const text = normalizeContent(message.content).trim()
      if (text) currentUserMessage = text.slice(0, 500)
      currentTurnId = `${sessionId}:turn-${turnOrdinal++}`
      continue
    }

    if (message.role !== 'assistant') continue

    const messageKey = message.message_id || `idx-${assistantOrdinal}`
    const deduplicationKey = `mistral-vibe:${sessionId}:${messageKey}`
    const allocationIndex = assistantOrdinal
    assistantOrdinal++

    if (seen.has(deduplicationKey)) continue
    seen.add(deduplicationKey)

    const { tools, rawBashCommands } = extractMessageTools(message)

    calls.push({
      provider: 'mistral-vibe',
      model,
      inputTokens: allocateInteger(inputTokens, allocationIndex, assistantMessages.length),
      outputTokens: allocateInteger(outputTokens, allocationIndex, assistantMessages.length),
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      measuredCostUSD: allocateCost(sessionCost, assistantMessages.length),
      tools,
      rawBashCommands,
      timestamp: message.timestamp ?? fallbackTimestamp,
      speed: 'standard',
      deduplicationKey,
      turnId: currentTurnId,
      userMessage: currentUserMessage,
      sessionId,
    })
  }

  return { calls, diagnostics }
}
