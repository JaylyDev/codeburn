// @codeburn/core Kimi decoder: pure decode over host-supplied JSONL lines.
// The host reads the wire file and the configured model fallback; this decoder
// is stateless, does no fs/env/clock access, and carries no pricing.

import type { DecodeContext } from '../../contracts.js'
import type { RecordDiagnostic } from '../../diagnostics.js'
import type { KimiDecodedCall, KimiSessionRecords, JsonObject } from './types.js'

export const kimiToolNameMap: Record<string, string> = {
  Shell: 'Bash',
  Bash: 'Bash',
  bash: 'Bash',
  ReadFile: 'Read',
  ReadMediaFile: 'Read',
  WriteFile: 'Write',
  StrReplaceFile: 'Edit',
  Grep: 'Grep',
  Glob: 'Glob',
  SearchWeb: 'WebSearch',
  FetchURL: 'WebFetch',
  Agent: 'Agent',
  AgentTool: 'Agent',
  TaskList: 'Agent',
  TaskOutput: 'Agent',
  TaskStop: 'Agent',
  AskUserQuestion: 'AskUser',
  SetTodoList: 'TodoWrite',
  Think: 'Think',
  EnterPlanMode: 'EnterPlanMode',
  ExitPlanMode: 'ExitPlanMode',
  SendDMail: 'DMail',
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null
}

function stringField(obj: JsonObject | null, key: string): string | undefined {
  const value = obj?.[key]
  return typeof value === 'string' ? value : undefined
}

function numericField(obj: JsonObject, ...keys: string[]): number {
  for (const key of keys) {
    const raw = obj[key]
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
    if (Number.isFinite(n) && n > 0) return Math.trunc(n)
  }
  return 0
}

function timestampToIso(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value !== 'number' || !Number.isFinite(value)) return ''

  const millis = value > 1_000_000_000_000 ? value : value * 1000
  const date = new Date(millis)
  return Number.isFinite(date.getTime()) ? date.toISOString() : ''
}

function extractUserText(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 500)
  if (!Array.isArray(value)) return ''

  return value
    .map(part => stringField(asObject(part), 'text') ?? '')
    .filter(Boolean)
    .join(' ')
    .slice(0, 500)
}

function extractEnvelope(record: JsonObject): { type: string; payload: JsonObject; timestamp: string } | null {
  const message = asObject(record['message'])
  const envelope = message ?? record
  const type = stringField(envelope, 'type')
  const payload = asObject(envelope['payload'])
  if (!type || !payload) return null
  return { type, payload, timestamp: timestampToIso(record['timestamp']) }
}

function extractUsage(payload: JsonObject): {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
} | null {
  const usage = asObject(payload['token_usage']) ?? asObject(payload['usage'])
  if (!usage) return null

  const cacheReadInputTokens = numericField(usage, 'input_cache_read', 'cache_read_input_tokens', 'cached_input_tokens')
  const cacheCreationInputTokens = numericField(usage, 'input_cache_creation', 'cache_creation_input_tokens')
  let inputTokens = numericField(usage, 'input_other', 'input_tokens')
  if (inputTokens === 0) {
    const totalInput = numericField(usage, 'input')
    inputTokens = Math.max(0, totalInput - cacheReadInputTokens - cacheCreationInputTokens)
  }
  const outputTokens = numericField(usage, 'output', 'output_tokens')

  if (
    inputTokens === 0 &&
    outputTokens === 0 &&
    cacheReadInputTokens === 0 &&
    cacheCreationInputTokens === 0
  ) {
    return null
  }

  return { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens }
}

function extractTool(payload: JsonObject): { tool: string; rawBashCommand?: string } | null {
  const fn = asObject(payload['function'])
  const rawName = stringField(fn, 'name') ?? stringField(payload, 'name')
  if (!rawName) return null

  const tool = kimiToolNameMap[rawName] ?? rawName
  const argsText = stringField(fn, 'arguments') ?? stringField(payload, 'arguments')
  let args: JsonObject | null = null
  if (argsText) {
    try {
      args = asObject(JSON.parse(argsText))
    } catch {
      args = null
    }
  }
  const command = stringField(args, 'command')

  return { tool, ...(tool === 'Bash' && command ? { rawBashCommand: command } : {}) }
}

function isKimiSessionRecords(value: unknown): value is KimiSessionRecords {
  return value !== null && typeof value === 'object' && 'lines' in (value as object)
}

export type KimiDecodeInput = {
  records: unknown[]
  context: DecodeContext
  seenKeys?: Set<string>
}

export type KimiDecodeResult = {
  calls: KimiDecodedCall[]
  diagnostics: RecordDiagnostic[]
}

/**
 * Decode a Kimi wire log into rich, cost-free calls. A single pass:
 * TurnBegin/SteerInput set the pending user message; ToolCall records collect
 tools; StatusUpdate records with usage flush a call. Dedup is keyed on
 * `kimi:<sessionId>:<messageId>` against the live `seenKeys` set.
 */
export function decodeKimi({ records, seenKeys: liveSeen }: KimiDecodeInput): KimiDecodeResult {
  const seen = liveSeen ?? new Set<string>()
  const session = records.find(isKimiSessionRecords)
  if (!session) return { calls: [], diagnostics: [] }

  const { lines, configuredModel, sessionName } = session
  const calls: KimiDecodedCall[] = []
  const tools: string[] = []
  const rawBashCommands: string[] = []
  let currentUserMessage = ''
  let index = 0

  for (const line of lines) {
    if (!line.trim()) continue

    let record: JsonObject | null = null
    try {
      record = asObject(JSON.parse(line))
    } catch {
      continue
    }
    if (!record) continue

    const envelope = extractEnvelope(record)
    if (!envelope || envelope.type === 'metadata') continue

    if (envelope.type === 'TurnBegin' || envelope.type === 'SteerInput') {
      currentUserMessage = extractUserText(envelope.payload['user_input'])
      continue
    }

    if (envelope.type === 'TurnEnd') {
      currentUserMessage = ''
      tools.length = 0
      rawBashCommands.length = 0
      continue
    }

    if (envelope.type === 'ToolCall' || envelope.type === 'ToolCallRequest') {
      const extracted = extractTool(envelope.payload)
      if (!extracted) continue
      tools.push(extracted.tool)
      if (extracted.rawBashCommand) rawBashCommands.push(extracted.rawBashCommand)
      continue
    }

    if (envelope.type !== 'StatusUpdate') continue

    const usage = extractUsage(envelope.payload)
    if (!usage) continue

    const rawMessageId = stringField(envelope.payload, 'message_id')
    const dedupKey = `kimi:${sessionName}:${rawMessageId ?? index}`
    index++
    if (seen.has(dedupKey)) continue
    seen.add(dedupKey)

    const model =
      stringField(envelope.payload, 'model') ??
      stringField(envelope.payload, 'model_name') ??
      configuredModel

    calls.push({
      provider: 'kimi',
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      cachedInputTokens: usage.cacheReadInputTokens,
      reasoningTokens: 0,
      webSearchRequests: 0,
      // The legacy kimi decode accumulated tools in a Set, deduping per turn.
      // Preserve that here so the observation/host tool list matches byte-for-byte.
      tools: [...new Set(tools)],
      rawBashCommands: [...rawBashCommands],
      timestamp: envelope.timestamp,
      speed: 'standard',
      deduplicationKey: dedupKey,
      userMessage: currentUserMessage,
      sessionId: sessionName,
      projectPath: '',
    })

    tools.length = 0
    rawBashCommands.length = 0
  }

  return { calls, diagnostics: [] }
}
