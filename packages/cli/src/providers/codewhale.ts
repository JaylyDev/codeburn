import { open, readdir, stat } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'

import { decodeCodeWhale, mapCodeWhaleToolName } from '@codeburn/core/providers/codewhale'
import type { CodeWhaleDecodedCall, CodeWhaleSessionRecords, CodeWhaleMetadata, CodeWhaleMessage } from '@codeburn/core/providers/codewhale'

import { extractBashCommands } from '../bash-utils.js'
import { readSessionFile } from '../fs-utils.js'
import { getShortModelName } from '../models.js'
import { createBridgedProvider } from './bridge.js'
import type { Provider, SessionSource, ParsedProviderCall } from './types.js'

const METADATA_PREFIX_BYTES = 64 * 1024

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

function parseMetadata(value: unknown): CodeWhaleMetadata | null {
  if (!isRecord(value)) return null
  const id = nonEmptyString(value['id'])
  if (!id) return null

  return {
    id,
    created_at: nonEmptyString(value['created_at']),
    updated_at: nonEmptyString(value['updated_at']),
    total_tokens: safeTokenCount(value['total_tokens']),
    model: nonEmptyString(value['model']),
    model_provider: nonEmptyString(value['model_provider']),
    workspace: nonEmptyString(value['workspace']),
    cost: isRecord(value['cost']) ? (value['cost'] as CodeWhaleMetadata['cost']) : undefined,
  }
}

function findStringEnd(source: string, start: number): number {
  for (let i = start + 1; i < source.length; i++) {
    if (source.charCodeAt(i) === 0x5c) {
      i++
    } else if (source.charCodeAt(i) === 0x22) {
      return i
    }
  }
  return -1
}

function findObjectEnd(source: string, start: number): number {
  let depth = 0
  let inString = false
  for (let i = start; i < source.length; i++) {
    const ch = source.charCodeAt(i)
    if (inString) {
      if (ch === 0x5c) i++
      else if (ch === 0x22) inString = false
      continue
    }
    if (ch === 0x22) inString = true
    else if (ch === 0x7b) depth++
    else if (ch === 0x7d && --depth === 0) return i
  }
  return -1
}

// CodeWhale itself reads only the first 64 KiB when listing sessions. Mirror
// that fast path so discovery does not parse every multi-megabyte transcript.
function extractTopLevelMetadata(source: string): CodeWhaleMetadata | null {
  let depth = 0
  for (let i = 0; i < source.length; i++) {
    const ch = source.charCodeAt(i)
    if (ch === 0x7b) {
      depth++
      continue
    }
    if (ch === 0x7d) {
      depth--
      continue
    }
    if (ch !== 0x22) continue

    const end = findStringEnd(source, i)
    if (end === -1) return null
    if (depth !== 1) {
      i = end
      continue
    }

    let key: unknown
    try {
      key = JSON.parse(source.slice(i, end + 1))
    } catch {
      return null
    }
    i = end
    if (key !== 'metadata') continue

    let cursor = end + 1
    while (cursor < source.length && /\s/.test(source[cursor]!)) cursor++
    if (source[cursor] !== ':') continue
    cursor++
    while (cursor < source.length && /\s/.test(source[cursor]!)) cursor++
    if (source[cursor] !== '{') return null

    const objectEnd = findObjectEnd(source, cursor)
    if (objectEnd === -1) return null
    try {
      return parseMetadata(JSON.parse(source.slice(cursor, objectEnd + 1)))
    } catch {
      return null
    }
  }
  return null
}

async function readSessionMetadata(filePath: string): Promise<CodeWhaleMetadata | null> {
  const handle = await open(filePath, 'r').catch(() => null)
  if (!handle) return null

  try {
    try {
      const prefix = Buffer.alloc(METADATA_PREFIX_BYTES)
      const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0)
      const metadata = extractTopLevelMetadata(prefix.subarray(0, bytesRead).toString('utf-8'))
      if (metadata) return metadata
    } catch {
      return null
    }
  } finally {
    await handle.close().catch(() => {})
  }

  const raw = await readSessionFile(filePath)
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as { metadata?: unknown; messages?: unknown }
    return parseMetadata(parsed.metadata)
  } catch {
    return null
  }
}

function defaultSessionDirs(): string[] {
  const configuredHome = process.env['CODEWHALE_HOME']?.trim()
  if (configuredHome) return [join(configuredHome, 'sessions')]
  return [
    join(homedir(), '.codewhale', 'sessions'),
    join(homedir(), '.deepseek', 'sessions'),
  ]
}

function projectName(workspace: string | undefined): string {
  if (!workspace) return 'CodeWhale'
  const parts = workspace.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? 'CodeWhale'
}

async function discoverInDir(dir: string): Promise<Array<{ source: SessionSource; id: string }>> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const results: Array<{ source: SessionSource; id: string }> = []

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const path = join(dir, entry.name)
    const metadata = await readSessionMetadata(path)
    if (!metadata) continue
    results.push({
      id: metadata.id,
      source: {
        path,
        project: projectName(metadata.workspace),
        provider: 'codewhale',
      },
    })
  }

  return results
}

function toProviderCall(rich: CodeWhaleDecodedCall): ParsedProviderCall {
  const measured = rich.measuredCostUSD !== undefined
  return {
    provider: 'codewhale',
    model: rich.model,
    inputTokens: rich.inputTokens,
    outputTokens: rich.outputTokens,
    cacheCreationInputTokens: rich.cacheCreationInputTokens,
    cacheReadInputTokens: rich.cacheReadInputTokens,
    cachedInputTokens: rich.cachedInputTokens,
    reasoningTokens: rich.reasoningTokens,
    webSearchRequests: rich.webSearchRequests,
    ...(measured
      ? { costUSD: rich.measuredCostUSD, costBasis: 'measured' as const }
      : { costBasis: 'estimated' as const }),
    costIsEstimated: !measured,
    tools: rich.tools,
    // The legacy codewhale decode deduped nothing: it pushed every extracted base
    // command into a flat list. Preserve that (no Set) so per-command counts match.
    bashCommands: rich.rawBashCommands.flatMap(c => extractBashCommands(c)),
    skills: rich.skills,
    subagentTypes: rich.subagentTypes,
    timestamp: rich.timestamp,
    speed: rich.speed,
    deduplicationKey: rich.deduplicationKey,
    turnId: rich.turnId,
    toolSequence: rich.toolSequence,
    userMessage: rich.userMessage,
    sessionId: rich.sessionId,
    project: rich.project,
    projectPath: rich.projectPath,
  }
}

export function createCodeWhaleProvider(overrideDirs?: string | string[]): Provider {
  const configuredDirs = overrideDirs === undefined
    ? undefined
    : Array.isArray(overrideDirs) ? overrideDirs : [overrideDirs]

  return createBridgedProvider<CodeWhaleDecodedCall>({
    name: 'codewhale',
    displayName: 'CodeWhale',

    modelDisplayName(model: string): string {
      return getShortModelName(model)
    },

    toolDisplayName(rawTool: string): string {
      return mapCodeWhaleToolName(rawTool)
    },

    async discoverSessions(): Promise<SessionSource[]> {
      const seenSessionIds = new Set<string>()
      const sources: SessionSource[] = []

      for (const dir of configuredDirs ?? defaultSessionDirs()) {
        for (const candidate of await discoverInDir(dir)) {
          if (seenSessionIds.has(candidate.id)) continue
          seenSessionIds.add(candidate.id)
          sources.push(candidate.source)
        }
      }
      return sources
    },

    async readRecords(source: SessionSource): Promise<unknown[] | null> {
      const [raw, fileStat] = await Promise.all([
        readSessionFile(source.path),
        stat(source.path).catch(() => null),
      ])

      let metadata: CodeWhaleMetadata | null = null
      let messages: CodeWhaleMessage[] = []

      if (raw !== null) {
        try {
          const saved = JSON.parse(raw) as { metadata?: unknown; messages?: unknown }
          metadata = parseMetadata(saved.metadata)
          messages = Array.isArray(saved.messages) ? (saved.messages.filter(isRecord) as CodeWhaleMessage[]) : []
        } catch {
          // A truncated transcript can still have complete aggregate metadata at
          // the front of the file.
        }
      }
      metadata ??= await readSessionMetadata(source.path)
      if (!metadata) return null

      const fileMtime = fileStat?.mtime.toISOString() ?? ''
      const record: CodeWhaleSessionRecords = { metadata, messages, fileMtime }
      return [record]
    },

    decode: decodeCodeWhale,
    toProviderCall,
  })
}

export const codewhale = createCodeWhaleProvider()
