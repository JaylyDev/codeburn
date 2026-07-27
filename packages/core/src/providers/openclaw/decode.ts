// @codeburn/core OpenClaw decoder: pure decode over host-supplied JSONL records.
// No fs / env / clock — the host reads the file and hands the lines straight
// through. The rich output carries token buckets and any provider-reported cost
// but NO host-computed pricing. Bash base-name extraction stays host-side.

import type { DecodeContext } from '../../contracts.js'
import type { RecordDiagnostic } from '../../diagnostics.js'
import type { OpenClawDecodedCall, OpenClawEntry, OpenClawUsage } from './types.js'

export const openclawToolNameMap: Record<string, string> = {
  bash: 'Bash',
  exec: 'Bash',
  read: 'Read',
  edit: 'Edit',
  write: 'Write',
  glob: 'Glob',
  grep: 'Grep',
  task: 'Agent',
  dispatch_agent: 'Agent',
  fetch: 'WebFetch',
  search: 'WebSearch',
  todo: 'TodoWrite',
  patch: 'Patch',
}

function extractTools(
  content: Array<{ type?: string; name?: string; arguments?: Record<string, unknown> }> | undefined,
): { tools: string[]; rawBashCommands: string[] } {
  const tools: string[] = []
  const rawBashCommands: string[] = []
  if (!content) return { tools, rawBashCommands }

  for (const block of content) {
    if ((block.type === 'tool_use' || block.type === 'toolCall') && block.name) {
      const mapped = openclawToolNameMap[block.name] ?? block.name
      tools.push(mapped)
      if (mapped === 'Bash' && block.arguments && typeof block.arguments.command === 'string') {
        rawBashCommands.push(block.arguments.command)
      }
    }
  }
  return { tools, rawBashCommands }
}

function parseOpenClawLine(line: string): OpenClawEntry | null {
  if (!line.trim()) return null
  try {
    return JSON.parse(line) as OpenClawEntry
  } catch {
    return null
  }
}

export type OpenClawDecodeInput = {
  records: unknown[]
  context: DecodeContext
  seenKeys?: Set<string>
}

export type OpenClawDecodeResult = {
  calls: OpenClawDecodedCall[]
  diagnostics: RecordDiagnostic[]
}

/**
 * Decode an OpenClaw session JSONL file's records into rich, cost-free calls.
 * The host owns file I/O and the live cross-file dedup set; this function is
 * pure over the supplied records. Provider-reported cost is preserved as
 * `costUSD` with `costBasis: 'measured'`; otherwise the call carries
 * `costBasis: 'estimated'` for the host's pricing seam.
 */
export function decodeOpenClaw({ records, context, seenKeys: liveSeen }: OpenClawDecodeInput): OpenClawDecodeResult {
  const seen = liveSeen ?? new Set<string>()
  const calls: OpenClawDecodedCall[] = []
  const diagnostics: RecordDiagnostic[] = []

  let sessionId = ''
  let sessionTimestamp = ''
  let currentModel = ''
  let pendingUserMessage = ''

  const pendingCalls: {
    model: string
    usage: OpenClawUsage
    tools: string[]
    rawBashCommands: string[]
    timestamp: string
    userMessage: string
    dedupId: string
  }[] = []

  for (const rawLine of records) {
    const entry = typeof rawLine === 'string' ? parseOpenClawLine(rawLine) : (rawLine as OpenClawEntry | null)
    if (!entry) continue

    if (entry.type === 'session') {
      sessionId = entry.id ?? ''
      sessionTimestamp = entry.timestamp ?? ''
      continue
    }

    if (entry.type === 'model_change') {
      currentModel = entry.modelId ?? currentModel
      continue
    }

    if (entry.type === 'custom' && entry.customType === 'model-snapshot') {
      currentModel = entry.data?.modelId ?? currentModel
      continue
    }

    if (entry.type !== 'message' || !entry.message) continue

    const msg = entry.message
    if (msg.role === 'user') {
      if (!pendingUserMessage && Array.isArray(msg.content)) {
        const textBlock = msg.content.find(c => c.type === 'text' && c.text)
        pendingUserMessage = (textBlock?.text ?? '').slice(0, 500)
      }
      continue
    }

    if (msg.role !== 'assistant') continue

    const model = msg.model ?? currentModel
    if (msg.usage) {
      const { tools, rawBashCommands } = extractTools(msg.content)
      pendingCalls.push({
        model,
        usage: msg.usage,
        tools,
        rawBashCommands,
        timestamp: entry.timestamp ?? sessionTimestamp,
        userMessage: pendingUserMessage,
        dedupId: entry.id ?? '',
      })
      pendingUserMessage = ''
    }
  }

  // Fallback mirrors the host's `basename(sourceRef, '.jsonl')`: take the last
  // path segment and strip the .jsonl extension (the split-only pop kept it).
  if (!sessionId) sessionId = (context.sourceRef.split(/[/\\]/).pop() ?? '').replace(/\.jsonl$/, '')

  for (let i = 0; i < pendingCalls.length; i++) {
    const call = pendingCalls[i]!
    const dedupKey = `openclaw:${sessionId}:${call.dedupId || i}`
    if (seen.has(dedupKey)) continue
    seen.add(dedupKey)

    const u = call.usage
    const costFromProvider = u.cost?.total ?? 0

    const ts = new Date(call.timestamp)
    if (isNaN(ts.getTime()) || ts.getTime() < 1_000_000_000_000) continue

    const measured = costFromProvider > 0
    const decodedCall: OpenClawDecodedCall = {
      provider: 'openclaw',
      model: call.model || 'openclaw-auto',
      inputTokens: u.input,
      outputTokens: u.output,
      cacheCreationInputTokens: u.cacheWrite,
      cacheReadInputTokens: u.cacheRead,
      cachedInputTokens: u.cacheRead,
      reasoningTokens: 0,
      webSearchRequests: 0,
      ...(measured ? { costUSD: costFromProvider, costBasis: 'measured' as const } : { costBasis: 'estimated' as const }),
      tools: call.tools,
      rawBashCommands: call.rawBashCommands,
      timestamp: ts.toISOString(),
      speed: 'standard',
      deduplicationKey: dedupKey,
      userMessage: call.userMessage,
      sessionId,
    }

    calls.push(decodedCall)
  }

  return { calls, diagnostics }
}
