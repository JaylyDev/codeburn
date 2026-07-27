// @codeburn/core Kimicode decoder: pure decode over host-supplied JSONL records.
// The host reads wire.jsonl; this decoder extracts token buckets, tool calls,
// and user message threading with no fs, env, clock, or pricing.

import type { DecodeContext } from '../../contracts.js'
import type { RecordDiagnostic } from '../../diagnostics.js'
import type { KimicodeDecodedCall, JsonObject, RequestContext } from './types.js'

// Kimicode tool ids mapped to the canonical vocabulary. Unknown ids pass through.
export const kimicodeToolNameMap: Record<string, string> = {
  Bash: 'Bash',
  Shell: 'Bash',
  bash: 'Bash',
  shell: 'Bash',
  Read: 'Read',
  ReadFile: 'Read',
  read_file: 'Read',
  Write: 'Write',
  WriteFile: 'Write',
  write_file: 'Write',
  Edit: 'Edit',
  EditFile: 'Edit',
  edit_file: 'Edit',
  Grep: 'Grep',
  grep: 'Grep',
  Glob: 'Glob',
  glob: 'Glob',
  Agent: 'Agent',
  Task: 'Agent',
}

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function nonNegativeNumber(value: unknown): number {
  const number = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() ? Number(value) : NaN
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : 0
}

function timestampIso(value: unknown): string {
  if (typeof value === 'string') {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? '' : date.toISOString()
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return ''
  const milliseconds = value > 1_000_000_000_000 ? value : value * 1000
  const date = new Date(milliseconds)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}

function turnIdFromStep(value: unknown): string {
  const turnStep = stringValue(value)
  if (!turnStep) return ''
  return turnStep.split('.', 1)[0] ?? ''
}

function inputText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .map(part => {
      const record = asObject(part)
      return record?.['type'] === 'text' ? stringValue(record['text']) : ''
    })
    .filter(Boolean)
    .join('\n')
}

function toolDetails(value: unknown): { name: string; bashCommands: string[] } | null {
  const event = asObject(value)
  if (!event || stringValue(event['type']) !== 'tool.call') return null
  const rawName = stringValue(event['name'])
  if (!rawName) return null
  const name = kimicodeToolNameMap[rawName] ?? rawName

  let args = asObject(event['args'])
  if (!args && typeof event['args'] === 'string') {
    try {
      args = asObject(JSON.parse(event['args']))
    } catch {
      args = null
    }
  }
  const command = stringValue(args?.['command'])
  return {
    name,
    bashCommands: name === 'Bash' && command ? [command] : [],
  }
}

export type KimicodeDecodeInput = {
  records: unknown[]
  context: DecodeContext
  seenKeys?: Set<string>
  // Extra context passed by the host when splitting the raw wire.jsonl
  sessionId?: string
  agentId?: string
  project?: string
  projectPath?: string
  // Session state.json's updatedAt/createdAt (host-read, host-side I/O), used
  // as the last-resort timestamp fallback when a usage record and its request
  // both omit `time`. Raw values; this decoder normalizes them with the same
  // `timestampIso` it uses for every other timestamp.
  stateUpdatedAt?: unknown
  stateCreatedAt?: unknown
}

export type KimicodeDecodeResult = {
  calls: KimicodeDecodedCall[]
  diagnostics: RecordDiagnostic[]
}

/**
 * Decode kimicode wire.jsonl records into rich, cost-free calls. A single pass
 * over the lines: events set up pending state (model alias, prompt, tools);
 * usage.record flushes a call. Dedup is keyed on
 * `kimicode:<sessionId>:<agentId>:<lineIndex>:<usageOrdinal>` against live seenKeys.
 */
export function decodeKimicode({
  records,
  seenKeys: liveSeen,
  sessionId = '',
  agentId = '',
  project = '',
  projectPath = '',
  stateUpdatedAt,
  stateCreatedAt,
}: KimicodeDecodeInput): KimicodeDecodeResult {
  const seen = liveSeen ?? new Set<string>()
  const calls: KimicodeDecodedCall[] = []
  const diagnostics: RecordDiagnostic[] = []
  const fallbackTimestamp = timestampIso(stateUpdatedAt) || timestampIso(stateCreatedAt)

  const aliasModels = new Map<string, string>()
  const prompts = new Map<string, string>()
  let currentPrompt = ''
  let currentRequest: RequestContext | null = null
  let pendingTools: string[] = []
  let pendingBashCommands: string[] = []
  let usageOrdinal = 0

  for (let lineIndex = 0; lineIndex < records.length; lineIndex++) {
    const line = records[lineIndex]
    if (typeof line !== 'string' || !line.trim()) continue

    let record: JsonObject | null
    try {
      record = asObject(JSON.parse(line))
    } catch {
      continue
    }
    if (!record) continue

    const type = stringValue(record['type'])
    if (type === 'turn.prompt') {
      pendingTools = []
      pendingBashCommands = []
      currentPrompt = inputText(record['input'])
      continue
    }

    if (type === 'llm.request') {
      const model = stringValue(record['model'])
      const modelAlias = stringValue(record['modelAlias'])
      const turnId = turnIdFromStep(record['turnStep'])
      if (model && modelAlias) aliasModels.set(modelAlias, model)
      if (turnId && currentPrompt) prompts.set(turnId, currentPrompt)
      currentRequest = {
        model,
        modelAlias,
        turnId,
        timestamp: timestampIso(record['time']),
      }
      continue
    }

    if (type === 'context.append_loop_event') {
      const tool = toolDetails(record['event'])
      if (tool) {
        pendingTools.push(tool.name)
        pendingBashCommands.push(...tool.bashCommands)
      }
      continue
    }

    if (type !== 'usage.record') continue
    const usage = asObject(record['usage'])
    if (!usage) continue

    const usageAlias = stringValue(record['model'])
    const realModel = aliasModels.get(usageAlias) ?? (currentRequest?.model || 'kimicode-unknown')
    const turnId = currentRequest?.turnId || ''
    const inputTokens = nonNegativeNumber(usage['inputOther'])
    const outputTokens = nonNegativeNumber(usage['output'])
    const cacheReadInputTokens = nonNegativeNumber(usage['inputCacheRead'])
    const cacheCreationInputTokens = nonNegativeNumber(usage['inputCacheCreation'])
    const timestamp = timestampIso(record['time']) || currentRequest?.timestamp || fallbackTimestamp
    if (!timestamp) {
      pendingTools = []
      pendingBashCommands = []
      continue
    }

    const deduplicationKey = `kimicode:${sessionId}:${agentId}:${lineIndex + 1}:${usageOrdinal}`
    usageOrdinal++
    if (seen.has(deduplicationKey)) {
      pendingTools = []
      pendingBashCommands = []
      continue
    }
    seen.add(deduplicationKey)

    calls.push({
      provider: 'kimicode',
      model: realModel,
      inputTokens,
      outputTokens,
      cacheCreationInputTokens,
      cacheReadInputTokens,
      cachedInputTokens: cacheReadInputTokens,
      reasoningTokens: 0,
      webSearchRequests: 0,
      tools: pendingTools,
      rawBashCommands: pendingBashCommands,
      timestamp,
      speed: 'standard',
      deduplicationKey,
      turnId: turnId || undefined,
      userMessage: prompts.get(turnId) ?? currentPrompt,
      sessionId,
      project,
      projectPath,
    })

    pendingTools = []
    pendingBashCommands = []
  }

  return { calls, diagnostics }
}
