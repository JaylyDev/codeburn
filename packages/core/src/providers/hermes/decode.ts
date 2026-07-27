// @codeburn/core Hermes decoder: pure decode over host-supplied sqlite rows.
// The host opens state.db, runs the SQL, and hands the session row + messages +
// profile straight through. This decoder is pure: no fs / env / clock / sqlite /
// pricing / strip-ansi. It emits raw command strings; bash base-name extraction
// stays host-side.

import type { DecodeContext } from '../../contracts.js'
import type { RecordDiagnostic } from '../../diagnostics.js'
import type {
  HermesDecodedCall,
  HermesMessageRow,
  HermesSessionRow,
  HermesToolCall,
  HermesToolSequenceEntry,
} from './types.js'

// Hermes tool ids mapped to the canonical vocabulary. An id with no mapping
// passes through unchanged so a provider-native tool still shows up.
export const hermesToolNameMap: Record<string, string> = {
  terminal: 'Bash',
  execute_code: 'CodeExecution',
  read_file: 'Read',
  search_files: 'Grep',
  write_file: 'Write',
  patch: 'Edit',
  browser_navigate: 'Browser',
  browser_click: 'Browser',
  browser_type: 'Browser',
  browser_press: 'Browser',
  browser_scroll: 'Browser',
  browser_snapshot: 'Browser',
  browser_vision: 'Vision',
  browser_console: 'Browser',
  browser_get_images: 'Browser',
  web_search: 'WebSearch',
  web_extract: 'WebFetch',
  delegate_task: 'Agent',
  vision_analyze: 'Vision',
  process: 'Bash',
  todo: 'TodoWrite',
  skill_view: 'Skill',
  skill_manage: 'Skill',
  skills_list: 'Skill',
  memory: 'Memory',
  session_search: 'SessionSearch',
}

function sanitizeProject(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return 'hermes'
  return trimmed.replace(/^[/\\]+/, '').replace(/[:/\\]/g, '-')
}

function parseTimestamp(raw: number | null): string {
  if (raw == null) return ''
  const ms = raw < 1e12 ? raw * 1000 : raw
  return new Date(ms).toISOString()
}

function firstUserMessage(messages: HermesMessageRow[]): string {
  const msg = messages.find(m => m.role === 'user' && typeof m.content === 'string' && m.content.trim().length > 0)
  return Array.from(msg?.content ?? '').slice(0, 500).join('')
}

export function mapToolName(raw: string): string {
  // Composio MCP tools are matched first — the generic mcp_ prefix on line
  // below would also match composio names, so order matters here.
  if (raw.startsWith('mcp_composio_')) return 'MCP'
  if (raw.startsWith('mcp_') || raw.startsWith('mcp__')) return raw
  if (raw.startsWith('browser_')) return 'Browser'
  return hermesToolNameMap[raw] ?? raw
}

function parseToolCalls(raw: string | null): HermesToolCall[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as HermesToolCall[]) : []
  } catch {
    return []
  }
}

function collectTools(messages: HermesMessageRow[]): {
  tools: string[]
  toolSequence: HermesToolSequenceEntry[][]
  rawBashCommands: string[]
} {
  const tools: string[] = []
  const toolSequence: HermesToolSequenceEntry[][] = []
  const rawBashCommands: string[] = []

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      const currentTurnTools: HermesToolSequenceEntry[] = []
      for (const call of parseToolCalls(msg.tool_calls)) {
        const rawName = call.function?.name ?? ''
        if (!rawName) continue
        const mapped = mapToolName(rawName)
        tools.push(mapped)
        const toolCall: HermesToolSequenceEntry = { tool: mapped }
        const rawArgs = call.function?.arguments
        if (rawArgs) {
          try {
            const args = JSON.parse(rawArgs) as Record<string, unknown>
            const file = args['path'] ?? args['file_path']
            if (typeof file === 'string') toolCall.file = file
            const command = args['command']
            if (typeof command === 'string') {
              toolCall.command = command
              rawBashCommands.push(command)
            }
          } catch {
            // Ignore malformed arguments from historical sessions.
          }
        }
        currentTurnTools.push(toolCall)
      }
      if (currentTurnTools.length > 0) {
        toolSequence.push(currentTurnTools)
      }
    } else if (msg.role === 'tool' && msg.tool_name) {
      tools.push(mapToolName(msg.tool_name))
    }
  }

  return {
    tools: [...new Set(tools)],
    toolSequence: toolSequence.length > 0 ? toolSequence : [],
    rawBashCommands,
  }
}

function inferProject(messages: HermesMessageRow[], fallback: string): { project: string; projectPath?: string } {
  const cwdPattern = /^Current working directory:\s*([a-zA-Z]:\\[^\r\n`"]+|\/[^\r\n`"\\]+)/m
  for (const msg of messages) {
    if (msg.role !== 'user' && msg.role !== 'system') continue
    const text = msg.content ?? ''
    const match = cwdPattern.exec(text)
    if (match?.[1]) {
      const projectPath = match[1].trim()
      return { project: sanitizeProject(projectPath), projectPath }
    }
  }
  return { project: fallback }
}

export type HermesDecodeInput = {
  records: unknown[]
  context: DecodeContext
  // Optional live dedup set the host mutates in place (its shared cross-file
  // seenKeys). Simple sqlite providers never persist resume state, so there is
  // no serialized `seenKeys` fallback.
  seenKeys?: Set<string>
}

export type HermesDecodeResult = {
  calls: HermesDecodedCall[]
  diagnostics: RecordDiagnostic[]
}

/**
 * Decode one Hermes session (host-supplied session row + messages + profile)
 * into rich, cost-free calls. Dedup is keyed on `hermes:<profile>:<sessionId>`
 * against the live `seenKeys` set (host-owned).
 */
export function decodeHermes({ records, seenKeys: liveSeen }: HermesDecodeInput): HermesDecodeResult {
  const seen = liveSeen ?? new Set<string>()
  const calls: HermesDecodedCall[] = []
  const diagnostics: RecordDiagnostic[] = []

  const composite = records[0] as { session: HermesSessionRow; messages: HermesMessageRow[]; profile: string } | undefined
  if (!composite || typeof composite !== 'object') return { calls, diagnostics }
  const row = composite.session
  const messages = composite.messages ?? []
  const profile = composite.profile ?? 'default'

  if (!row || !row.id) return { calls, diagnostics }

  const inputTokens = row.input_tokens ?? 0
  const outputTokens = row.output_tokens ?? 0
  const cacheReadTokens = row.cache_read_tokens ?? 0
  const cacheWriteTokens = row.cache_write_tokens ?? 0
  const reasoningTokens = row.reasoning_tokens ?? 0
  if (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens + reasoningTokens === 0) {
    return { calls, diagnostics }
  }

  const model = row.model ?? 'unknown'
  const { tools, toolSequence, rawBashCommands } = collectTools(messages)
  // Hermes records the session's working directory in sessions.cwd.
  // Prefer it; fall back to scraping a "Current working directory:" line
  // from the transcript (older builds), then to the profile name.
  const cwd = row.cwd?.trim()
  const projectInfo = cwd
    ? { project: sanitizeProject(cwd), projectPath: cwd }
    : inferProject(messages, sanitizeProject(profile))
  const timestamp = parseTimestamp(row.started_at)
  const dedupKey = `hermes:${profile}:${row.id}`
  if (seen.has(dedupKey)) return { calls, diagnostics }
  seen.add(dedupKey)

  // Hermes bills reasoning tokens at the output rate (same as Gemini).
  // When Hermes stored an actual or estimated cost, pass it as measured;
  // otherwise the host pricing pass will estimate from token buckets.
  const recordedCost =
    (row.actual_cost_usd ?? 0) > 0 ? row.actual_cost_usd!
    : (row.estimated_cost_usd ?? 0) > 0 ? row.estimated_cost_usd!
    : undefined

  calls.push({
    provider: 'hermes',
    model,
    inputTokens,
    outputTokens,
    cacheCreationInputTokens: cacheWriteTokens,
    cacheReadInputTokens: cacheReadTokens,
    cachedInputTokens: cacheReadTokens,
    reasoningTokens,
    webSearchRequests: 0,
    tools,
    rawBashCommands,
    timestamp,
    speed: 'standard',
    deduplicationKey: dedupKey,
    turnId: `${row.id}:session`,
    toolSequence: toolSequence.length > 0 ? toolSequence : undefined,
    userMessage: firstUserMessage(messages),
    sessionId: row.id,
    ...(recordedCost !== undefined ? { recordedCost } : {}),
    project: projectInfo.project,
    ...(projectInfo.projectPath ? { projectPath: projectInfo.projectPath } : {}),
  })

  return { calls, diagnostics }
}
