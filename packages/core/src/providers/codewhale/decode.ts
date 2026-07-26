// @codeburn/core CodeWhale decoder: pure decode over a host-supplied parsed
// session. The host reads the JSON file (with an optional prefix fallback for
// oversized transcripts); this decoder is stateless, does no fs/env/clock
// access, and performs no pricing calculations.

import type { DecodeContext } from '../../contracts.js'
import type { RecordDiagnostic } from '../../diagnostics.js'
import type {
  CodeWhaleDecodedCall,
  CodeWhaleMessage,
  CodeWhaleMetadata,
  CodeWhaleSessionRecords,
  CodeWhaleToolCall,
} from './types.js'

export const codeWhaleToolNameMap: Record<string, string> = {
  exec_shell: 'Bash',
  exec_shell_wait: 'Bash',
  exec_shell_interact: 'Bash',
  exec_shell_cancel: 'Bash',
  task_shell_start: 'Bash',
  task_shell_wait: 'Bash',
  terminal_run: 'Bash',
  terminal_send: 'Bash',
  terminal_wait: 'Bash',
  terminal_cancel: 'Bash',
  read_file: 'Read',
  write_file: 'Write',
  edit_file: 'Edit',
  fim_edit: 'Edit',
  apply_patch: 'Edit',
  list_dir: 'Glob',
  grep_files: 'Grep',
  web_search: 'WebSearch',
  fetch_url: 'WebFetch',
  'web.run': 'WebSearch',
  agent: 'Agent',
  'agents/list': 'Agent',
  'agents/message': 'Agent',
  'agents/followup': 'Agent',
  'agents/interrupt': 'Agent',
  'agents/wait': 'Agent',
  todo_write: 'TodoWrite',
  todo_add: 'TodoWrite',
  todo_update: 'TodoWrite',
  todo_list: 'TodoWrite',
  checklist_write: 'TodoWrite',
  checklist_add: 'TodoWrite',
  checklist_update: 'TodoWrite',
  checklist_list: 'TodoWrite',
  update_plan: 'TodoWrite',
  load_skill: 'Skill',
  request_user_input: 'AskUser',
}

export function mapCodeWhaleToolName(rawName: string): string {
  if (rawName.startsWith('mcp__')) return rawName
  if (rawName.startsWith('agents/')) return 'Agent'
  return Object.prototype.hasOwnProperty.call(codeWhaleToolNameMap, rawName)
    ? codeWhaleToolNameMap[rawName]!
    : rawName
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function safeNonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function safeTokenCount(value: unknown): number {
  return Math.floor(Math.min(safeNonNegativeNumber(value), Number.MAX_SAFE_INTEGER))
}

function normalizeTimestamp(value: string | undefined): string {
  if (!value) return ''
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : ''
}

function firstUserMessage(messages: CodeWhaleMessage[]): string {
  for (const message of messages) {
    if (message.role !== 'user') continue
    const text =
      typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? message.content
            .filter(block => block?.type === 'text' && typeof block.text === 'string')
            .map(block => block.text)
            .join(' ')
          : ''
    if (text.trim()) return Array.from(text.trim()).slice(0, 500).join('')
  }
  return ''
}

function toolInput(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function firstString(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = nonEmptyString(input[key])
    if (value) return value
  }
  return undefined
}

function collectTools(messages: CodeWhaleMessage[]): {
  tools: string[]
  rawBashCommands: string[]
  toolSequence: CodeWhaleToolCall[][]
  skills: string[]
  subagentTypes: string[]
  webSearchRequests: number
} {
  const tools: string[] = []
  const rawBashCommands: string[] = []
  const toolSequence: CodeWhaleToolCall[][] = []
  const skills: string[] = []
  const subagentTypes: string[] = []
  let webSearchRequests = 0

  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
    const turnTools: CodeWhaleToolCall[] = []

    for (const block of message.content) {
      if (block?.type !== 'tool_use' && block?.type !== 'server_tool_use') continue
      const rawName = nonEmptyString(block.name)
      if (!rawName) continue
      const mapped = mapCodeWhaleToolName(rawName)
      const input = toolInput(block.input)
      const toolCall: CodeWhaleToolCall = { tool: mapped }

      const file = firstString(input, ['file_path', 'path', 'target_file', 'file'])
      if (file) toolCall.file = file
      const command = firstString(input, ['command', 'cmd'])
      if (command) toolCall.command = command

      if (mapped === 'Bash' && command) {
        rawBashCommands.push(command)
      }
      if (mapped === 'Skill') {
        const skill = firstString(input, ['name', 'skill', 'skill_name'])
        if (skill) skills.push(skill)
      }
      if (mapped === 'Agent') {
        const subagentType = firstString(input, ['type', 'agent_type', 'profile'])
        if (subagentType) subagentTypes.push(subagentType)
      }
      if (mapped === 'WebSearch') webSearchRequests++

      tools.push(mapped)
      turnTools.push(toolCall)
    }

    if (turnTools.length > 0) toolSequence.push(turnTools)
  }

  return { tools, rawBashCommands, toolSequence, skills, subagentTypes, webSearchRequests }
}

function reportedCost(cost: CodeWhaleMetadata['cost']): { value: number; exact: boolean } {
  if (!cost || typeof cost !== 'object') return { value: 0, exact: false }
  const hasSessionCost = Object.prototype.hasOwnProperty.call(cost, 'session_cost_usd')
  const hasSubagentCost = Object.prototype.hasOwnProperty.call(cost, 'subagent_cost_usd')
  if (!hasSessionCost && !hasSubagentCost) return { value: 0, exact: false }
  return {
    value: safeNonNegativeNumber(cost.session_cost_usd) + safeNonNegativeNumber(cost.subagent_cost_usd),
    exact: true,
  }
}

function isCodeWhaleSessionRecords(value: unknown): value is CodeWhaleSessionRecords {
  return value !== null && typeof value === 'object' && 'metadata' in (value as object)
}

export type CodeWhaleDecodeInput = {
  records: unknown[]
  context: DecodeContext
  seenKeys?: Set<string>
}

export type CodeWhaleDecodeResult = {
  calls: CodeWhaleDecodedCall[]
  diagnostics: RecordDiagnostic[]
}

/**
 * Decode one CodeWhale session's composite record into a single rich, cost-free
 * call. The host owns file I/O and the live cross-file dedup set; this function
 * is pure over the supplied record.
 */
export function decodeCodeWhale({ records, seenKeys: liveSeen }: CodeWhaleDecodeInput): CodeWhaleDecodeResult {
  const seen = liveSeen ?? new Set<string>()
  const session = records.find(isCodeWhaleSessionRecords)
  if (!session) return { calls: [], diagnostics: [] }

  const { metadata, messages, fileMtime } = session
  const totalTokens = safeTokenCount(metadata.total_tokens)
  const model = metadata.model ?? metadata.model_provider ?? 'unknown'
  const localCost = reportedCost(metadata.cost)
  if (totalTokens === 0 && (!localCost.exact || localCost.value === 0)) return { calls: [], diagnostics: [] }

  const deduplicationKey = `codewhale:${metadata.id}`
  if (seen.has(deduplicationKey)) return { calls: [], diagnostics: [] }
  seen.add(deduplicationKey)

  const timestamp = normalizeTimestamp(metadata.updated_at) || normalizeTimestamp(metadata.created_at) || fileMtime
  const workspace = metadata.workspace

  const { tools, rawBashCommands, toolSequence, skills, subagentTypes, webSearchRequests } = collectTools(messages)

  const call: CodeWhaleDecodedCall = {
    provider: 'codewhale',
    model,
    inputTokens: totalTokens,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests,
    ...(localCost.exact ? { measuredCostUSD: localCost.value } : {}),
    tools,
    rawBashCommands,
    skills,
    subagentTypes,
    timestamp,
    speed: 'standard',
    deduplicationKey,
    turnId: `${metadata.id}:session`,
    ...(toolSequence.length > 0 ? { toolSequence } : {}),
    userMessage: firstUserMessage(messages),
    sessionId: metadata.id,
    project: workspace ? workspace.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).at(-1) ?? 'CodeWhale' : 'CodeWhale',
    projectPath: workspace ?? '',
  }

  return { calls: [call], diagnostics: [] }
}
