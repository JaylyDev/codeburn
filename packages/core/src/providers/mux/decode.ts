// @codeburn/core Mux decoder: pure decode over supplied chat JSONL records.
// No fs / env / clock — the host reads the file and hands lines straight through.

import type { DecodeContext } from '../../contracts.js'
import type { RecordDiagnostic } from '../../diagnostics.js'
import type { MuxDecodedCall, MuxMessage, MuxPart } from './types.js'

// Mux tool ids mapped to the canonical vocabulary.
export const muxToolNameMap: Record<string, string> = {
  bash: 'Bash',
  file_read: 'Read',
  file_edit_replace_string: 'Edit',
  file_edit_replace_lines: 'Edit',
  file_edit_insert: 'Edit',
  file_edit_operation: 'Edit',
  web_fetch: 'WebFetch',
  web_search: 'WebSearch',
  task: 'Agent',
  todo: 'TodoWrite',
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : undefined
}

// Matches the host's canonical safeNumber (@codeburn/core claude decode): a
// number is kept only when finite and strictly positive, else 0.
function safeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

// Guard against non-finite / out-of-range ms, which make toISOString() throw.
function toIsoTimestamp(ts: unknown, createdAt: unknown): string {
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    const d = new Date(ts)
    if (!Number.isNaN(d.getTime())) return d.toISOString()
  }
  return typeof createdAt === 'string' ? createdAt : ''
}

function stripProvider(model: string): string {
  const i = model.indexOf(':')
  return i >= 0 ? model.slice(i + 1) : model
}

export type MuxDecodeInput = {
  records: unknown[]
  context: DecodeContext
  workspaceId: string
  seenKeys?: Set<string>
}

export type MuxDecodeResult = {
  calls: MuxDecodedCall[]
  diagnostics: RecordDiagnostic[]
}

/**
 * Decode Mux JSONL records into rich, cost-free calls.
 */
export function decodeMux({ records, workspaceId, seenKeys: liveSeen }: MuxDecodeInput): MuxDecodeResult {
  const seen = liveSeen ?? new Set<string>()
  const calls: MuxDecodedCall[] = []
  const diagnostics: RecordDiagnostic[] = []

  let pendingUserMessage = ''
  let lineIdx = 0

  for (const rawRecord of records) {
    lineIdx++
    let msg: MuxMessage
    if (typeof rawRecord === 'string') {
      try {
        msg = JSON.parse(rawRecord) as MuxMessage
      } catch {
        continue
      }
    } else {
      msg = rawRecord as MuxMessage
    }

    if (!msg || typeof msg !== 'object') continue

    if (msg.role === 'user') {
      const texts = (Array.isArray(msg.parts) ? msg.parts : [])
        .filter(p => p?.type === 'text' && typeof p.text === 'string')
        .map(p => p.text as string)
        .filter(Boolean)
      if (texts.length > 0) pendingUserMessage = texts.join(' ').slice(0, 500)
      continue
    }

    if (msg.role !== 'assistant') continue
    const meta = msg.metadata
    const usage = asRecord(meta?.usage)
    if (!meta || !usage) continue

    const pm = meta.providerMetadata ?? {}
    const anthropic = asRecord(pm['anthropic'])

    // mux reports inputTokens inclusive of cache read+creation and
    // outputTokens inclusive of reasoning; decompose to codeburn's convention.
    const cacheRead = safeNumber(usage['cachedInputTokens'])
    const cacheCreate = safeNumber(anthropic?.['cacheCreationInputTokens'])
    const reasoning = safeNumber(usage['reasoningTokens'])
    const inputTokens = Math.max(0, safeNumber(usage['inputTokens']) - cacheRead - cacheCreate)
    const outputTokens = Math.max(0, safeNumber(usage['outputTokens']) - reasoning)

    if (inputTokens === 0 && outputTokens === 0 && cacheRead === 0 && cacheCreate === 0 && reasoning === 0) {
      continue
    }

    const rawModel = typeof meta.model === 'string' && meta.model ? meta.model : 'unknown'
    const model = stripProvider(rawModel)
    const id = typeof msg.id === 'string' && msg.id ? msg.id : `L${lineIdx}`
    const dedupKey = `mux:${workspaceId}:${id}`
    if (seen.has(dedupKey)) continue
    seen.add(dedupKey)

    const toolParts = (Array.isArray(msg.parts) ? msg.parts : []).filter(
      p => p?.type === 'dynamic-tool' && typeof p.toolName === 'string',
    )
    const tools = toolParts.map(p => muxToolNameMap[p.toolName!] ?? p.toolName!)
    // Emit the RAW shell scripts; the host runs extractBashCommands (with its
    // strip-ansi dependency) to reduce them to base-name programs.
    const rawBashCommands = toolParts
      .filter(p => p.toolName === 'bash')
      .flatMap(p => {
        const input = asRecord(p.input)
        const script = input?.['script'] ?? input?.['command']
        return typeof script === 'string' ? [script] : []
      })

    const timestamp = toIsoTimestamp(meta.timestamp, msg.createdAt)

    calls.push({
      provider: 'mux',
      model,
      inputTokens,
      outputTokens,
      cacheCreationInputTokens: cacheCreate,
      cacheReadInputTokens: cacheRead,
      cachedInputTokens: cacheRead,
      reasoningTokens: reasoning,
      webSearchRequests: 0,
      tools,
      rawBashCommands,
      timestamp,
      speed: 'standard',
      deduplicationKey: dedupKey,
      userMessage: pendingUserMessage,
      sessionId: workspaceId,
    })

    pendingUserMessage = ''
  }

  return { calls, diagnostics }
}
