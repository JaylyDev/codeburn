// @codeburn/core Open Design decoder: pure decode over supplied event JSONL records.
// No fs / env / clock — the host reads the file and hands lines straight through.

import type { DecodeContext } from '../../contracts.js'
import type { RecordDiagnostic } from '../../diagnostics.js'
import type { OpenDesignDecodedCall, OpenDesignEntry, TokenUsage } from './types.js'

export type OpenDesignDecodeInput = {
  records: unknown[]
  context: DecodeContext
  sessionId: string
  // Discovered source project (host-derived). Optional so a core unit test can
  // decode with only { records, context, sessionId }.
  project?: string
  seenKeys?: Set<string>
}

export type OpenDesignDecodeResult = {
  calls: OpenDesignDecodedCall[]
  diagnostics: RecordDiagnostic[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function tokenValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function timestampValue(value: unknown): string {
  const text = stringValue(value)
  if (text) return text
  if (typeof value !== 'number' || !Number.isFinite(value)) return ''

  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}

function parseEvent(line: string | Buffer): OpenDesignEntry | null {
  const text = (typeof line === 'string' ? line : line.toString('utf-8')).trim()
  if (!text) return null

  try {
    const parsed = JSON.parse(text) as unknown
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function parseUsage(data: unknown): TokenUsage | null {
  if (!isRecord(data) || data['type'] !== 'usage') return null
  const usage = data['usage']
  if (!isRecord(usage)) return null

  return {
    inputTokens: tokenValue(usage['input_tokens']),
    outputTokens: tokenValue(usage['output_tokens']),
    cacheReadTokens: tokenValue(usage['cached_read_tokens']),
    reasoningTokens: tokenValue(usage['thought_tokens']),
  }
}

/**
 * Decode Open Design event JSONL records into rich, cost-free calls.
 * Maintains state of currentModel as events indicate model transitions.
 */
export function decodeOpenDesign({ records, sessionId, project, seenKeys: liveSeen }: OpenDesignDecodeInput): OpenDesignDecodeResult {
  const seen = liveSeen ?? new Set<string>()
  const calls: OpenDesignDecodedCall[] = []
  const diagnostics: RecordDiagnostic[] = []

  let currentModel = ''
  let fallbackEventCounter = 0

  for (const rawRecord of records) {
    let entry: OpenDesignEntry
    if (typeof rawRecord === 'string') {
      entry = parseEvent(rawRecord) ?? {}
    } else {
      entry = rawRecord as OpenDesignEntry
    }

    const eventName = stringValue(entry.event)
    const data = entry.data

    if (eventName === 'start' && isRecord(data)) {
      const model = stringValue(data['model'])
      if (model) currentModel = model
      continue
    }

    if (eventName !== 'agent' || !isRecord(data)) continue

    if (data['type'] === 'status') {
      const model = stringValue(data['model'])
      if (model) currentModel = model
      continue
    }

    const usage = parseUsage(data)
    if (!usage || !currentModel) continue

    const eventId = stringValue(entry.id) ?? `line-${fallbackEventCounter++}`
    const dedupKey = `open-design:${sessionId}:${eventId}`
    if (seen.has(dedupKey)) continue
    seen.add(dedupKey)

    const uncachedInputTokens = Math.max(0, usage.inputTokens - usage.cacheReadTokens)

    calls.push({
      provider: 'open-design',
      model: currentModel,
      inputTokens: uncachedInputTokens,
      outputTokens: usage.outputTokens,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: usage.cacheReadTokens,
      cachedInputTokens: usage.cacheReadTokens,
      reasoningTokens: usage.reasoningTokens,
      webSearchRequests: 0,
      tools: [],
      rawBashCommands: [],
      timestamp: timestampValue(entry.timestamp),
      speed: 'standard',
      deduplicationKey: dedupKey,
      userMessage: '',
      sessionId,
      ...(project !== undefined ? { project } : {}),
    })
  }

  return { calls, diagnostics }
}
