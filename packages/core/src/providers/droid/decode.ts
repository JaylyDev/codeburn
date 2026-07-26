// @codeburn/core Droid decoder: pure decode over supplied JSONL records + settings.
// No fs / env / clock — the host reads both the JSONL and settings files and hands them through.
// The rich output carries token buckets but NO pricing (cost leaves the decoder).

import type { DecodeContext } from '../../contracts.js'
import type { RecordDiagnostic } from '../../diagnostics.js'
import type { DroidDecodedCall, DroidJsonlEntry, DroidSettings, DroidContent } from './types.js'

// Normalize content blocks: ensure array of block objects with minimal validation.
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

// Droid tool ids mapped to the canonical vocabulary.
export const droidToolNameMap: Record<string, string> = {
  Read: 'Read',
  Create: 'Create',
  Edit: 'Edit',
  MultiEdit: 'MultiEdit',
  LS: 'LS',
  Glob: 'Glob',
  Grep: 'Grep',
  Execute: 'Bash',
  AskUser: 'AskUser',
  TodoWrite: 'TodoWrite',
  Skill: 'Skill',
  Task: 'Agent',
  WebSearch: 'WebSearch',
  FetchUrl: 'FetchUrl',
  GenerateDroid: 'GenerateDroid',
  ExitSpecMode: 'ExitSpecMode',
}

// Strip Droid's model wrapper to the bare id (e.g. "custom:GLM-5.1-[Proxy]-0"
// -> "GLM-5.1"). Exported so the CLI's display-name path reuses the exact same
// reduction rather than duplicating it.
export function stripModelPrefix(raw: string): string {
  return raw
    .replace(/^custom:/, '')
    .replace(/\[.*?\]/g, '')
    .replace(/-\d+$/, '')
    .replace(/-+$/, '')
    .replace(/^-/, '')
}

export type DroidDecodeInput = {
  records: unknown[]
  settings: DroidSettings
  context: DecodeContext
  seenKeys?: Set<string>
}

export type DroidDecodeResult = {
  calls: DroidDecodedCall[]
  diagnostics: RecordDiagnostic[]
}

/**
 * Decode Droid JSONL records into rich, cost-free calls.
 * Droid stores token usage at session level; we distribute it evenly across assistant calls.
 */
export function decodeDroid({ records, settings, seenKeys: liveSeen }: DroidDecodeInput): DroidDecodeResult {
  const seen = liveSeen ?? new Set<string>()
  const calls: DroidDecodedCall[] = []
  const diagnostics: RecordDiagnostic[] = []

  let sessionId = ''
  const sessionModelDisplay = settings.model ? stripModelPrefix(settings.model) : 'unknown'
  let currentUserMessage = ''

  // Collect all assistant messages with their tools
  const assistantCalls: Array<{
    id: string
    timestamp: string
    tools: string[]
    bashCommands: string[]
  }> = []

  let pendingTools: string[] = []
  let pendingBashCommands: string[] = []

  for (const rawRecord of records) {
    let entry: DroidJsonlEntry
    if (typeof rawRecord === 'string') {
      try {
        entry = JSON.parse(rawRecord) as DroidJsonlEntry
      } catch {
        continue
      }
    } else {
      entry = rawRecord as DroidJsonlEntry
    }

    if (entry.type === 'session_start') {
      sessionId = entry.id ?? ''
      continue
    }

    if (entry.type !== 'message' || !entry.message) continue

    const msg = entry.message

    if (msg.role === 'user') {
      const texts = normalizeContentBlocks(msg.content)
        .filter(c => c.type === 'text' && c.text)
        .map(c => c.text!)
        .filter(Boolean)
      // Skip system-reminder-only messages
      const nonSystemTexts = texts.filter(t => !t.startsWith('<system-reminder>'))
      if (nonSystemTexts.length > 0) {
        currentUserMessage = nonSystemTexts.join(' ').slice(0, 500)
      }
      continue
    }

    if (msg.role === 'assistant') {
      const toolUses = normalizeContentBlocks(msg.content).filter(c => c.type === 'tool_use')

      for (const tu of toolUses) {
        const toolName = tu.name ?? ''
        pendingTools.push(droidToolNameMap[toolName] ?? toolName)

        // Emit the RAW command string; the host runs Droid's base-name
        // extraction (first-line + extractBashCommands, with its strip-ansi dep).
        if (toolName === 'Execute' && tu.input && typeof tu.input['command'] === 'string') {
          pendingBashCommands.push(tu.input['command'] as string)
        }
      }

      const hasText = normalizeContentBlocks(msg.content).some(c => c.type === 'text' && c.text)

      if (pendingTools.length > 0 || hasText) {
        assistantCalls.push({
          id: entry.id ?? `msg-${assistantCalls.length}`,
          timestamp: entry.timestamp ?? '',
          tools: [...pendingTools],
          bashCommands: [...pendingBashCommands],
        })
        pendingTools = []
        pendingBashCommands = []
      }
      continue
    }
  }

  if (assistantCalls.length === 0) return { calls, diagnostics }

  const totalTokens = settings.tokenUsage
  if (!totalTokens) return { calls, diagnostics }

  const totalInput = totalTokens.inputTokens ?? 0
  const totalOutput = totalTokens.outputTokens ?? 0
  const totalCacheCreation = totalTokens.cacheCreationTokens ?? 0
  const totalCacheRead = totalTokens.cacheReadTokens ?? 0
  const totalThinking = totalTokens.thinkingTokens ?? 0
  const numCalls = assistantCalls.length

  // Distribute evenly across calls
  const inputPerCall = Math.floor(totalInput / numCalls)
  const outputPerCall = Math.floor(totalOutput / numCalls)
  const cacheCreationPerCall = Math.floor(totalCacheCreation / numCalls)
  const cacheReadPerCall = Math.floor(totalCacheRead / numCalls)
  const thinkingPerCall = Math.floor(totalThinking / numCalls)

  for (let i = 0; i < assistantCalls.length; i++) {
    const call = assistantCalls[i]

    // Assign remainder to the last call
    const isLast = i === assistantCalls.length - 1
    const inputTokens = isLast
      ? totalInput - inputPerCall * (numCalls - 1)
      : inputPerCall
    const outputTokens = isLast
      ? totalOutput - outputPerCall * (numCalls - 1)
      : outputPerCall
    const cacheCreationTokens = isLast
      ? totalCacheCreation - cacheCreationPerCall * (numCalls - 1)
      : cacheCreationPerCall
    const cacheReadTokens = isLast
      ? totalCacheRead - cacheReadPerCall * (numCalls - 1)
      : cacheReadPerCall
    const thinkingTokens = isLast
      ? totalThinking - thinkingPerCall * (numCalls - 1)
      : thinkingPerCall

    const dedupKey = `droid:${sessionId}:${call.id}`
    if (seen.has(dedupKey)) continue
    seen.add(dedupKey)

    const timestamp = call.timestamp || ''

    calls.push({
      provider: 'droid',
      model: sessionModelDisplay,
      inputTokens,
      outputTokens,
      cacheCreationInputTokens: cacheCreationTokens,
      cacheReadInputTokens: cacheReadTokens,
      cachedInputTokens: cacheReadTokens,
      reasoningTokens: thinkingTokens,
      webSearchRequests: 0,
      tools: call.tools,
      rawBashCommands: call.bashCommands,
      timestamp,
      speed: 'standard',
      deduplicationKey: dedupKey,
      userMessage: i === 0 ? currentUserMessage : '',
      sessionId,
    })
  }

  return { calls, diagnostics }
}
