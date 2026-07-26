// Claude rich decode: pure over supplied JSONL records/lines. No fs, no env, no
// clock, no pricing. May carry content in-memory (user text, tool names) — this
// is the host-facing rich layer, NOT the minimized observation surface. The CLI
// prices and maps this output into its own ParsedApiCall / ParsedTurn shapes;
// `toObservations` (sibling module) is the minimizing transform.

import { BASH_TOOLS, EDIT_TOOLS } from './tool-vocab.js'
import {
  BASH_COMMAND_CAP,
  LARGE_JSONL_LINE_BYTES,
  MAX_ADDED_NAMES,
  MAX_TOOL_BLOCKS,
  RAW_HEAD_BYTES,
  USER_TEXT_CAP,
  getTopLevelRawJsonStringField,
  parseLargeJsonl,
} from './scanner.js'
import type {
  ApiUsageIteration,
  AssistantMessageContent,
  ContentBlock,
  DecodedCall,
  DecodedTurn,
  JournalEntry,
  SessionMeta,
  TokenUsage,
  ToolCall,
  ToolResultMeta,
  ToolUseBlock,
} from './types.js'

export function parseJsonlLine(line: string | Buffer): JournalEntry | null {
  if (Buffer.isBuffer(line)) {
    if (line.length > LARGE_JSONL_LINE_BYTES) return parseLargeJsonl(line)
    try {
      return JSON.parse(line.toString('utf-8')) as JournalEntry
    } catch {
      return null
    }
  }
  if (line.length > LARGE_JSONL_LINE_BYTES) return parseLargeJsonl(line)
  try {
    return JSON.parse(line) as JournalEntry
  } catch {
    return null
  }
}

/// Normalize a message's `content` into an array of content blocks. Defensive
/// against a `content` that is a plain string (some agents write it that way);
/// a raw string reaching `.filter`/`.some` would throw mid-parse.
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

export function shouldSkipLine(line: string, threshold: string): boolean {
  const head = line.length > RAW_HEAD_BYTES ? line.slice(0, RAW_HEAD_BYTES) : line
  const type = getTopLevelRawJsonStringField(head, 'type')
  if (type !== 'user' && type !== 'assistant') return false
  const ts = getTopLevelRawJsonStringField(head, 'timestamp')
  if (!ts || ts.length < 10) return false
  return ts < threshold
}

export function compactEntry(raw: JournalEntry): JournalEntry {
  const entry: JournalEntry = { type: raw.type }

  if (raw.timestamp !== undefined) entry.timestamp = raw.timestamp
  if (raw.sessionId !== undefined) entry.sessionId = raw.sessionId
  if (raw.cwd !== undefined) entry.cwd = raw.cwd
  // Preserved so groupIntoTurns can stamp each turn's git branch (rich capture).
  if (typeof raw.gitBranch === 'string' && raw.gitBranch) entry.gitBranch = raw.gitBranch
  // Preserved so groupIntoTurns can attribute each PR reference to its turn.
  // Only `pr-link` entries carry `prUrl`; every other field of theirs is dropped.
  if (raw.type === 'pr-link') {
    const prUrl = (raw as Record<string, unknown>)['prUrl']
    if (typeof prUrl === 'string' && prUrl) (entry as Record<string, unknown>)['prUrl'] = prUrl
  }

  const att = (raw as Record<string, unknown>)['attachment']
  if (att && typeof att === 'object') {
    const a = att as Record<string, unknown>
    if (a['type'] === 'deferred_tools_delta' && Array.isArray(a['addedNames'])) {
      const names: string[] = []
      for (let i = 0; i < Math.min(a['addedNames'].length, MAX_ADDED_NAMES); i++) {
        const n = a['addedNames'][i]
        if (typeof n === 'string') names.push(n)
      }
      ;(entry as Record<string, unknown>)['attachment'] = { type: 'deferred_tools_delta', addedNames: names }
    }
  }

  if (!raw.message) return entry

  if (raw.message.role === 'user') {
    const content = raw.message.content
    if (typeof content === 'string') {
      entry.message = { role: 'user', content: content.slice(0, USER_TEXT_CAP) }
    } else if (Array.isArray(content)) {
      let remaining = USER_TEXT_CAP
      const blocks: { type: 'text'; text: string }[] = []
      for (const b of content) {
        if (remaining <= 0) break
        if (!b || typeof b !== 'object' || b.type !== 'text') continue
        const text = (b as { text?: unknown }).text
        if (typeof text !== 'string') continue
        const sliced = text.slice(0, remaining)
        blocks.push({ type: 'text', text: sliced })
        remaining -= sliced.length
      }
      entry.message = { role: 'user', content: blocks }
    }
    return entry
  }

  const msg = raw.message as AssistantMessageContent
  if (!msg.usage || !msg.model) return entry

  const rawContent = msg.content
  const contentArr = Array.isArray(rawContent) ? rawContent : []
  const toolBlocks = contentArr.filter((b): b is ToolUseBlock => b != null && typeof b === 'object' && b.type === 'tool_use')
  const compactContent: ContentBlock[] = toolBlocks.slice(0, MAX_TOOL_BLOCKS).map(tb => {
    let input: Record<string, unknown> = {}
    if (tb.name === 'Skill') {
      const ri = (tb.input ?? {}) as Record<string, unknown>
      if (typeof ri['skill'] === 'string') input['skill'] = (ri['skill'] as string).slice(0, 200)
      if (typeof ri['name'] === 'string') input['name'] = (ri['name'] as string).slice(0, 200)
    } else if (tb.name === 'Read' || tb.name === 'FileReadTool' || EDIT_TOOLS.has(tb.name)) {
      const ri = (tb.input ?? {}) as Record<string, unknown>
      if (typeof ri['file_path'] === 'string') input['file_path'] = (ri['file_path'] as string).slice(0, BASH_COMMAND_CAP)
    } else if (tb.name === 'Agent' || tb.name === 'Task') {
      const ri = (tb.input ?? {}) as Record<string, unknown>
      if (typeof ri['subagent_type'] === 'string') input['subagent_type'] = (ri['subagent_type'] as string).slice(0, 200)
    } else if (BASH_TOOLS.has(tb.name)) {
      const ri = (tb.input ?? {}) as Record<string, unknown>
      if (typeof ri['command'] === 'string') {
        input['command'] = (ri['command'] as string).slice(0, BASH_COMMAND_CAP)
      }
    }
    return { type: 'tool_use' as const, id: tb.id ?? '', name: tb.name, input }
  })

  const u = msg.usage
  const compactUsage: AssistantMessageContent['usage'] = {
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
  }
  if (u.cache_creation_input_tokens) compactUsage.cache_creation_input_tokens = u.cache_creation_input_tokens
  if (u.cache_creation) {
    compactUsage.cache_creation = {
      ...(u.cache_creation.ephemeral_5m_input_tokens ? { ephemeral_5m_input_tokens: u.cache_creation.ephemeral_5m_input_tokens } : {}),
      ...(u.cache_creation.ephemeral_1h_input_tokens ? { ephemeral_1h_input_tokens: u.cache_creation.ephemeral_1h_input_tokens } : {}),
    }
  }
  if (u.cache_read_input_tokens) compactUsage.cache_read_input_tokens = u.cache_read_input_tokens
  if (u.server_tool_use) {
    compactUsage.server_tool_use = {
      ...(u.server_tool_use.web_search_requests ? { web_search_requests: u.server_tool_use.web_search_requests } : {}),
      ...(u.server_tool_use.web_fetch_requests ? { web_fetch_requests: u.server_tool_use.web_fetch_requests } : {}),
    }
  }
  if (u.speed) compactUsage.speed = u.speed
  // Preserve only advisor_message iterations (/advisor sub-usage) so
  // parseAdvisorCalls can attribute the advisor model's spend; drop the rest to
  // keep the cache small. Other iteration types (plain `message`, and the
  // `fallback_message` written when a turn retries on another model) are not
  // accounted here, a separate pre-existing gap, so they are not preserved.
  if (Array.isArray(u.iterations)) {
    const advisorIterations = u.iterations
      .filter((it): it is ApiUsageIteration => !!it && it.type === 'advisor_message')
      .map(it => {
        const compact: ApiUsageIteration = { type: 'advisor_message' }
        if (typeof it.model === 'string') compact.model = it.model
        if (it.input_tokens) compact.input_tokens = it.input_tokens
        if (it.output_tokens) compact.output_tokens = it.output_tokens
        if (it.cache_creation_input_tokens) compact.cache_creation_input_tokens = it.cache_creation_input_tokens
        if (it.cache_read_input_tokens) compact.cache_read_input_tokens = it.cache_read_input_tokens
        if (it.cache_creation) {
          compact.cache_creation = {
            ...(it.cache_creation.ephemeral_5m_input_tokens ? { ephemeral_5m_input_tokens: it.cache_creation.ephemeral_5m_input_tokens } : {}),
            ...(it.cache_creation.ephemeral_1h_input_tokens ? { ephemeral_1h_input_tokens: it.cache_creation.ephemeral_1h_input_tokens } : {}),
          }
        }
        if (it.server_tool_use?.web_search_requests) compact.server_tool_use = { web_search_requests: it.server_tool_use.web_search_requests }
        if (it.speed) compact.speed = it.speed
        return compact
      })
    if (advisorIterations.length > 0) compactUsage.iterations = advisorIterations
  }

  entry.message = {
    type: 'message',
    role: 'assistant',
    model: msg.model,
    usage: compactUsage,
    content: compactContent,
    ...(msg.id ? { id: msg.id } : {}),
  }

  return entry
}

function extractToolNames(content: ContentBlock[]): string[] {
  return content
    .filter((b): b is ToolUseBlock => b.type === 'tool_use')
    .map(b => b.name)
}

function extractMcpTools(tools: string[]): string[] {
  return tools.filter(t => t.startsWith('mcp__'))
}

function extractSkillNames(content: ContentBlock[]): string[] {
  return content
    .filter((b): b is ToolUseBlock => b.type === 'tool_use' && b.name === 'Skill')
    .map(b => {
      const input = (b.input ?? {}) as Record<string, unknown>
      const raw = input['skill'] ?? input['name']
      return typeof raw === 'string' ? raw.trim() : ''
    })
    .filter(name => name.length > 0)
}

function extractSubagentTypes(content: ContentBlock[]): string[] {
  return content
    .filter((b): b is ToolUseBlock => b.type === 'tool_use' && (b.name === 'Agent' || b.name === 'Task'))
    .map(b => {
      const input = (b.input ?? {}) as Record<string, unknown>
      const raw = input['subagent_type']
      return typeof raw === 'string' ? raw.trim() : ''
    })
    .filter(name => name.length > 0)
}

// Raw `command` strings from this content's bash-family tool_use blocks, in
// order. The host splits each into individual commands (its splitter carries a
// strip-ansi dependency that must not enter the zod-only core).
function extractRawBashCommands(content: ContentBlock[]): string[] {
  return content
    .filter((b): b is ToolUseBlock => b.type === 'tool_use' && BASH_TOOLS.has((b as ToolUseBlock).name))
    .map(b => (b.input as Record<string, unknown>)?.command)
    .filter((c): c is string => typeof c === 'string')
}

function getUserMessageText(entry: JournalEntry): string {
  if (!entry.message || entry.message.role !== 'user') return ''
  const content = entry.message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map(b => b.text)
      .join(' ')
  }
  return ''
}

export function getMessageId(entry: JournalEntry): string | null {
  if (entry.type !== 'assistant') return null
  const msg = entry.message as AssistantMessageContent | undefined
  return msg?.id ?? null
}

export function safeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

export function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function extractClaudeCacheCreation(usage: {
  cache_creation_input_tokens?: number
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number }
}): { totalTokens: number; oneHourTokens: number } {
  const legacyTotal = safeNumber(usage.cache_creation_input_tokens)
  const cacheCreation = usage.cache_creation
  const fiveMinuteTokens = safeNumber(cacheCreation?.ephemeral_5m_input_tokens)
  const oneHourTokens = safeNumber(cacheCreation?.ephemeral_1h_input_tokens)
  const splitTotal = fiveMinuteTokens + oneHourTokens

  if (splitTotal === 0) return { totalTokens: legacyTotal, oneHourTokens: 0 }

  // Valid Claude usage reports the legacy total and split total as equal.
  // Keep the larger value so malformed partial splits do not drop tokens.
  const totalTokens = Math.max(legacyTotal, splitTotal)
  return {
    totalTokens,
    oneHourTokens: Math.min(oneHourTokens, totalTokens),
  }
}

// ── Rich Session Capture (Claude) ──────────────────────────────────────

// Count added/removed lines from a Claude `toolUseResult.structuredPatch`. Each
// hunk's `lines` array holds unified-diff content lines: a leading '+' is an
// added line, '-' a removed line, ' ' context. Numbers only — patch text is
// never stored. Missing/empty/non-array patches count as zero.
export function countStructuredPatchLoc(patch: unknown): { added: number; removed: number } {
  let added = 0
  let removed = 0
  if (!Array.isArray(patch)) return { added, removed }
  for (const hunk of patch) {
    const lines = (hunk as { lines?: unknown } | null)?.lines
    if (!Array.isArray(lines)) continue
    for (const line of lines) {
      if (typeof line !== 'string') continue
      if (line.startsWith('+')) added++
      else if (line.startsWith('-')) removed++
    }
  }
  return { added, removed }
}

export function emptySessionMeta(): SessionMeta {
  return { prLinks: [], isSidechain: false, agentSpawnLinks: {}, ambiguousSpawnAgentIds: [] }
}

// Record tool-result metadata from a raw user entry into `map`, keyed by the
// tool_result block's tool_use_id. Must run on the RAW entry (before
// compactEntry drops toolUseResult / is_error). Large tool-result lines parsed
// as buffers lose toolUseResult (the byte scanner does not extract it) — an
// accepted gap for oversized outputs.
export function collectToolResultMeta(entry: JournalEntry, map: Map<string, ToolResultMeta>): void {
  if (entry.type !== 'user') return
  const msg = entry.message
  const content = msg && typeof msg === 'object' ? (msg as { content?: unknown }).content : undefined
  if (!Array.isArray(content)) return
  const tur = (entry as Record<string, unknown>)['toolUseResult']
  const turObj = tur && typeof tur === 'object' ? tur as Record<string, unknown> : undefined
  const loc = countStructuredPatchLoc(turObj?.['structuredPatch'])
  const interrupted = turObj?.['interrupted'] === true
  const userModified = turObj?.['userModified'] === true
  for (const b of content) {
    if (!b || typeof b !== 'object' || (b as { type?: unknown }).type !== 'tool_result') continue
    const id = (b as { tool_use_id?: unknown }).tool_use_id
    if (typeof id !== 'string' || !id) continue
    const isError = (b as { is_error?: unknown }).is_error === true
    map.set(id, { locAdded: loc.added, locRemoved: loc.removed, interrupted, userModified, isError })
  }
}

// Accumulate session-level metadata from a raw entry. `ai-title` is last-wins
// (Claude refines the title over the session); `pr-link` URLs union; any
// sidechain entry marks the session.
export function collectSessionMeta(entry: JournalEntry, meta: SessionMeta): void {
  if (entry.type === 'ai-title') {
    const t = (entry as Record<string, unknown>)['aiTitle']
    if (typeof t === 'string' && t.trim()) meta.title = t.trim().slice(0, 200)
  } else if (entry.type === 'pr-link') {
    const url = (entry as Record<string, unknown>)['prUrl']
    if (typeof url === 'string' && url && !meta.prLinks.includes(url)) meta.prLinks.push(url)
  }
  if (entry.isSidechain === true) {
    meta.isSidechain = true
    // A sidechain entry's own `sessionId` is the id of the session that spawned
    // it (32/32 on real data; cross-checked against the owning directory at
    // stamp time). First value wins; every entry in the file carries the same id.
    const sid = (entry as Record<string, unknown>)['sessionId']
    if (!meta.parentSessionId && typeof sid === 'string' && sid) meta.parentSessionId = sid
  }
  // Parent side: the `Agent`/`Task` spawn result records the spawned agent's id in
  // `toolUseResult.agentId`; pair it with the `tool_result` block's `tool_use_id`
  // (the spawn's `tool_use` id) so a child can be folded into the launching turn.
  // Read from the RAW entry (compaction strips `toolUseResult`).
  const tur = (entry as Record<string, unknown>)['toolUseResult']
  if (tur && typeof tur === 'object') {
    const agentId = (tur as Record<string, unknown>)['agentId']
    if (typeof agentId === 'string' && agentId && !(agentId in meta.agentSpawnLinks)) {
      const msg = entry.message
      const content = msg && typeof msg === 'object' ? (msg as { content?: unknown }).content : undefined
      if (Array.isArray(content)) {
        const results = content.filter((b): b is Record<string, unknown> =>
          !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'tool_result'
          && typeof (b as { tool_use_id?: unknown }).tool_use_id === 'string' && !!(b as { tool_use_id?: unknown }).tool_use_id)
        let spawnId: string | undefined
        if (results.length === 1) {
          spawnId = results[0]!['tool_use_id'] as string
        } else if (results.length > 1) {
          // Several batched tool results share one entry: pair the agentId with the
          // block whose `content` is the spawn result (equals `toolUseResult.content`),
          // so an unrelated sibling block cannot capture the id. When the match is
          // ambiguous (identical blocks, or none match) the spawn link is left
          // unset ON PURPOSE: the child then folds via the timestamp-bucket fallback
          // in resolveChild rather than risk pairing with the wrong id.
          const turContent = JSON.stringify((tur as Record<string, unknown>)['content'])
          const matches = results.filter(b => JSON.stringify(b['content']) === turContent)
          if (matches.length === 1) spawnId = matches[0]!['tool_use_id'] as string
        }
        if (spawnId) meta.agentSpawnLinks[agentId] = spawnId
        // We know this parent spawned `agentId` (its result named it) but could not
        // pair the exact tool_use: record it as an AMBIGUOUS pairing so a late child
        // can still fold via the grace window. Not the same as an absent spawn.
        else if (!meta.ambiguousSpawnAgentIds.includes(agentId)) meta.ambiguousSpawnAgentIds.push(agentId)
      }
    }
  }
}

// Decode one assistant message into a cost-free DecodedCall. Returns null for
// non-assistant entries or messages missing usage/model. Pricing and bash
// splitting are applied by the host.
export function decodeAssistantCall(entry: JournalEntry, toolResultMeta?: Map<string, ToolResultMeta>): DecodedCall | null {
  if (entry.type !== 'assistant') return null
  const msg = entry.message as AssistantMessageContent | undefined
  if (!msg?.usage || !msg?.model) return null

  const usage = msg.usage
  const cacheCreation = extractClaudeCacheCreation(usage)
  const tokens: TokenUsage = {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheCreationInputTokens: cacheCreation.totalTokens,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: usage.server_tool_use?.web_search_requests ?? 0,
  }

  // Defensive: a message whose `content` is a string (not an array of blocks)
  // would crash the helpers below; normalize so one bad record can't abort the
  // whole backfill (issue #441).
  const contentBlocks = normalizeContentBlocks(msg.content)
  const tools = extractToolNames(contentBlocks)
  const skills = extractSkillNames(contentBlocks)
  const subagentTypes = extractSubagentTypes(contentBlocks)

  const rawBashCommands = extractRawBashCommands(contentBlocks)

  // Subagent-spawn `tool_use` ids in this message (`Agent`/`Task` blocks). Kept so
  // groupIntoTurns can attach them to the turn and by-PR attribution can fold each
  // spawned sidechain back into the turn that launched it.
  const spawnIds = contentBlocks
    .filter((b): b is ToolUseBlock => b.type === 'tool_use' && (b.name === 'Agent' || b.name === 'Task') && !!b.id)
    .map(b => b.id)

  const toolSeq: ToolCall[][] = contentBlocks
    .filter((b): b is ToolUseBlock => b.type === 'tool_use')
    .map(b => {
      const call: ToolCall = { tool: b.name }
      const inp = (b.input ?? {}) as Record<string, unknown>
      if (typeof inp['file_path'] === 'string') call.file = inp['file_path'] as string
      if (typeof inp['command'] === 'string') call.command = inp['command'] as string
      return [call]
    })

  // Attribute tool-result metadata (edit LOC, interruptions, errors) to this
  // call by summing over the tool_use ids it issued. Omitted entirely when no
  // meta map is supplied (e.g. the guard usage path) or nothing was recorded.
  let locAdded = 0
  let locRemoved = 0
  let toolErrors = 0
  let interrupted = false
  let userModified = false
  if (toolResultMeta && toolResultMeta.size > 0) {
    for (const b of contentBlocks) {
      if (b.type !== 'tool_use') continue
      const m = toolResultMeta.get((b as ToolUseBlock).id)
      if (!m) continue
      locAdded += m.locAdded
      locRemoved += m.locRemoved
      if (m.isError) toolErrors++
      if (m.interrupted) interrupted = true
      if (m.userModified) userModified = true
    }
  }

  return {
    provider: 'claude',
    model: msg.model,
    usage: tokens,
    tools,
    mcpTools: extractMcpTools(tools),
    skills,
    subagentTypes,
    hasAgentSpawn: tools.includes('Agent'),
    hasPlanMode: tools.includes('EnterPlanMode'),
    speed: usage.speed ?? 'standard',
    timestamp: entry.timestamp ?? '',
    rawBashCommands,
    deduplicationKey: msg.id ?? `claude:${entry.timestamp}`,
    cacheCreationOneHourTokens: cacheCreation.oneHourTokens || undefined,
    toolSequence: toolSeq.length > 0 ? toolSeq : undefined,
    ...(spawnIds.length > 0 ? { spawnToolUseIds: spawnIds } : {}),
    ...(locAdded ? { locAdded } : {}),
    ...(locRemoved ? { locRemoved } : {}),
    ...(interrupted ? { interrupted: true } : {}),
    ...(userModified ? { userModified: true } : {}),
    ...(toolErrors ? { toolErrors } : {}),
  }
}

/// Claude Code's advisor tool (/advisor) escalates hard decisions to a stronger
/// advisor model mid-turn. Those tokens are recorded as `advisor_message`
/// records inside `message.usage.iterations` under the advisor's own model, and
/// are excluded from the top-level `message.usage` totals that decodeAssistantCall
/// reads. Emit them as separate calls so the advisor's spend is counted and
/// attributed to the advisor model rather than silently dropped.
export function decodeAdvisorCalls(entry: JournalEntry): DecodedCall[] {
  if (entry.type !== 'assistant') return []
  const msg = entry.message as AssistantMessageContent | undefined
  const iterations = msg?.usage?.iterations
  if (!msg?.usage || !Array.isArray(iterations)) return []

  const calls: DecodedCall[] = []
  const baseKey = msg.id ?? `claude:${entry.timestamp}`
  // Ordinal among advisor entries (not the raw array index) so the dedup key is
  // identical whether it is computed from the raw record (guard path) or the
  // compacted record whose non-advisor iterations were dropped (report path).
  let advisorOrdinal = 0
  for (const it of iterations) {
    if (!it || it.type !== 'advisor_message') continue
    const model = typeof it.model === 'string' && it.model ? it.model : msg.model
    if (!model) continue
    const index = advisorOrdinal++

    const cacheCreation = extractClaudeCacheCreation(it)
    const tokens: TokenUsage = {
      inputTokens: it.input_tokens ?? 0,
      outputTokens: it.output_tokens ?? 0,
      cacheCreationInputTokens: cacheCreation.totalTokens,
      cacheReadInputTokens: it.cache_read_input_tokens ?? 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: it.server_tool_use?.web_search_requests ?? 0,
    }
    const speed = it.speed ?? msg.usage.speed ?? 'standard'

    calls.push({
      provider: 'claude',
      model,
      usage: tokens,
      tools: [],
      mcpTools: [],
      skills: [],
      subagentTypes: [],
      hasAgentSpawn: false,
      hasPlanMode: false,
      speed,
      timestamp: entry.timestamp ?? '',
      rawBashCommands: [],
      deduplicationKey: `${baseKey}:advisor:${index}`,
      cacheCreationOneHourTokens: cacheCreation.oneHourTokens || undefined,
    })
  }
  return calls
}

export function dedupeStreamingMessageIds(entries: JournalEntry[]): JournalEntry[] {
  const firstIdxById = new Map<string, number>()
  const lastIdxById = new Map<string, number>()
  for (let i = 0; i < entries.length; i++) {
    const id = getMessageId(entries[i]!)
    if (!id) continue
    if (!firstIdxById.has(id)) firstIdxById.set(id, i)
    lastIdxById.set(id, i)
  }
  if (lastIdxById.size === 0) return entries
  const result: JournalEntry[] = []
  for (let i = 0; i < entries.length; i++) {
    const id = getMessageId(entries[i]!)
    if (id && lastIdxById.get(id) !== i) continue
    if (id && firstIdxById.get(id) !== i) {
      const firstTs = entries[firstIdxById.get(id)!]!.timestamp
      result.push({ ...entries[i]!, timestamp: firstTs ?? entries[i]!.timestamp })
      continue
    }
    result.push(entries[i]!)
  }
  return result
}

export function groupIntoTurns(entries: JournalEntry[], seenMsgIds: Set<string>, toolResultMeta?: Map<string, ToolResultMeta>): DecodedTurn[] {
  const turns: DecodedTurn[] = []
  let currentUserMessage = ''
  let currentCalls: DecodedCall[] = []
  let currentTimestamp = ''
  let currentSessionId = ''
  // Git branch of the turn currently being accumulated. Captured at turn start
  // from the user entry (gitBranch is on every user/assistant entry); a
  // continuation turn with no leading user text falls back to its first call.
  let currentBranch: string | undefined
  // GitHub PR URLs referenced within the turn currently being accumulated. A
  // `pr-link` entry is emitted after the assistant creates/references a PR, so it
  // lands inside the same turn (before the next user message) and attaches here.
  let currentPrRefs: string[] = []
  // Subagent-spawn `tool_use` ids emitted within the current turn (deduped),
  // carried from each call's `spawnToolUseIds`.
  let currentSpawnIds: string[] = []

  for (const entry of entries) {
    const entryBranch = typeof entry.gitBranch === 'string' && entry.gitBranch ? entry.gitBranch : undefined
    if (entry.type === 'user') {
      const text = getUserMessageText(entry)
      if (text.trim()) {
        if (currentCalls.length > 0) {
          turns.push({
            userMessage: currentUserMessage,
            assistantCalls: currentCalls,
            timestamp: currentTimestamp,
            sessionId: currentSessionId,
            ...(currentBranch ? { gitBranch: currentBranch } : {}),
            ...(currentPrRefs.length > 0 ? { prRefs: [...currentPrRefs].sort() } : {}),
            ...(currentSpawnIds.length > 0 ? { spawnToolUseIds: currentSpawnIds } : {}),
          })
        }
        currentUserMessage = text
        currentCalls = []
        currentTimestamp = entry.timestamp ?? ''
        currentSessionId = entry.sessionId ?? ''
        currentBranch = entryBranch
        currentPrRefs = extractPrUrlsFromText(text)
        currentSpawnIds = []
      }
    } else if (entry.type === 'assistant') {
      if (entryBranch && !currentBranch) currentBranch = entryBranch
      const msgId = getMessageId(entry)
      if (msgId && seenMsgIds.has(msgId)) continue
      if (msgId) seenMsgIds.add(msgId)
      const call = decodeAssistantCall(entry, toolResultMeta)
      if (call) {
        currentCalls.push(call)
        if (call.spawnToolUseIds) for (const id of call.spawnToolUseIds) if (!currentSpawnIds.includes(id)) currentSpawnIds.push(id)
      }
      for (const advisorCall of decodeAdvisorCalls(entry)) currentCalls.push(advisorCall)
    } else if (entry.type === 'pr-link') {
      const url = (entry as Record<string, unknown>)['prUrl']
      if (typeof url === 'string' && url && !currentPrRefs.includes(url)) currentPrRefs.push(url)
    }
  }

  if (currentCalls.length > 0) {
    turns.push({
      userMessage: currentUserMessage,
      assistantCalls: currentCalls,
      timestamp: currentTimestamp,
      sessionId: currentSessionId,
      ...(currentBranch ? { gitBranch: currentBranch } : {}),
      ...(currentPrRefs.length > 0 ? { prRefs: [...currentPrRefs].sort() } : {}),
      ...(currentSpawnIds.length > 0 ? { spawnToolUseIds: currentSpawnIds } : {}),
    })
  }

  return turns
}

// Map each subagent-spawn `tool_use` id to the PR set active at the turn that
// emitted it, walking the FULL turn list in order. A turn's own `prRefs` apply to
// spawns within it; otherwise the carried set does. First occurrence of a spawn id
// wins deterministically (tool_use ids are unique in practice; this only guards a
// pathological restatement). Drives cross-range subagent PR attribution.
export function buildSpawnPrSets(turns: Array<{ prRefs?: string[]; spawnToolUseIds?: string[] }>): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  let cur: string[] = []
  for (const turn of turns) {
    const active = turn.prRefs?.length ? turn.prRefs : cur
    for (const id of turn.spawnToolUseIds ?? []) if (!(id in out)) out[id] = active
    if (turn.prRefs?.length) cur = turn.prRefs
  }
  return out
}

// Fully-qualified MCP tool name shape: `mcp__<server>__<tool>`. Both server
// and tool segments must be non-empty.
function isMcpToolName(name: string): boolean {
  if (!name.startsWith('mcp__')) return false
  const rest = name.slice(5) // strip `mcp__`
  const sep = rest.indexOf('__')
  if (sep <= 0) return false                   // missing or empty server
  if (sep >= rest.length - 2) return false     // missing or empty tool
  return true
}

/**
 * Extract MCP tool inventory observed across a session's JSONL entries.
 * Claude Code emits `attachment.type === "deferred_tools_delta"` entries whose
 * `addedNames` array lists every tool available at that turn; union every
 * occurrence (tool inventory can change mid-session) and keep only `mcp__*`.
 */
export function extractMcpInventory(entries: JournalEntry[]): string[] {
  const inventory = new Set<string>()
  for (const entry of entries) {
    const att = entry['attachment']
    if (!att || typeof att !== 'object') continue
    const a = att as { type?: unknown; addedNames?: unknown }
    if (a.type !== 'deferred_tools_delta') continue
    if (!Array.isArray(a.addedNames)) continue
    for (const name of a.addedNames) {
      if (typeof name !== 'string') continue
      if (!isMcpToolName(name)) continue
      inventory.add(name)
    }
  }
  if (inventory.size === 0) return []
  return Array.from(inventory).sort()
}

const PR_URL_IN_TEXT_RE = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/g

export function extractPrUrlsFromText(text: string): string[] {
  return [...new Set(text.match(PR_URL_IN_TEXT_RE) ?? [])].sort()
}
