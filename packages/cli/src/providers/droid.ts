import { readdir, stat, readFile } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

import { decodeDroid, droidToolNameMap, stripModelPrefix } from '@codeburn/core/providers/droid'
import type { DecodeContext } from '@codeburn/core'
import type { DroidDecodedCall, DroidJsonlEntry, DroidSettings } from '@codeburn/core/providers/droid'

import { readSessionFile, readSessionLines } from '../fs-utils.js'
import { getShortModelName } from '../models.js'
import { extractBashCommands } from '../bash-utils.js'
import { createBridgedProvider } from './bridge.js'
import type { Provider, SessionSource, ParsedProviderCall } from './types.js'

// Host-derived scalars the pure core decode needs, packed alongside the JSONL
// records so they cross the bridge's fixed decode signature.
type DroidMeta = { settings: DroidSettings }
type DroidPacked = { meta: DroidMeta; records: unknown[] }

function getFactoryDir(): string {
  return process.env['FACTORY_DIR'] ?? join(homedir(), '.factory')
}

// Display-name reduction (report layer). Reuses core's stripModelPrefix so the
// wrapper-stripping logic lives in exactly one place.
function parseModelForDisplay(raw: string): string {
  const stripped = stripModelPrefix(raw)
  const lower = stripped.toLowerCase()

  if (lower.includes('opus')) return getShortModelName(stripped)
  if (lower.includes('sonnet')) return getShortModelName(stripped)
  if (lower.includes('haiku')) return getShortModelName(stripped)
  if (lower.startsWith('gpt-')) return getShortModelName(stripped)
  if (lower.startsWith('o3') || lower.startsWith('o4')) return getShortModelName(stripped)
  if (lower.startsWith('gemini')) return getShortModelName(stripped)

  return stripped
}

/**
 * Extract meaningful shell command names from a Droid Execute call. Droid
 * frequently passes multi-line scripts (python -c "...", heredocs, etc.) where
 * splitting on ;/&&/| produces noise tokens like '}', 'await', 'import'. Reduce
 * to the primary command on the first logical line. Host-side (with its
 * strip-ansi dependency); the core decoder carries the raw command strings.
 */
function extractDroidBashCommands(command: string): string[] {
  if (!command || !command.trim()) return []
  const firstLine = command.split('\n')[0]!.trim()
  return extractBashCommands(firstLine)
}

// Map one rich, cost-free decoder call into the host's ParsedProviderCall. Cost
// re-enters here (`costBasis: 'estimated'`); the Droid base-name extraction runs
// on the raw command strings the decoder carried through.
function toProviderCall(rich: DroidDecodedCall): ParsedProviderCall {
  return {
    provider: 'droid',
    model: rich.model,
    inputTokens: rich.inputTokens,
    outputTokens: rich.outputTokens,
    cacheCreationInputTokens: rich.cacheCreationInputTokens,
    cacheReadInputTokens: rich.cacheReadInputTokens,
    cachedInputTokens: rich.cachedInputTokens,
    reasoningTokens: rich.reasoningTokens,
    webSearchRequests: rich.webSearchRequests,
    costBasis: 'estimated',
    tools: rich.tools,
    bashCommands: rich.rawBashCommands.flatMap(c => extractDroidBashCommands(c)),
    timestamp: rich.timestamp,
    speed: rich.speed,
    deduplicationKey: rich.deduplicationKey,
    userMessage: rich.userMessage,
    sessionId: rich.sessionId,
  }
}

function decode(input: { records: unknown[]; context: DecodeContext; seenKeys: Set<string> }): { calls: DroidDecodedCall[] } {
  const packed = input.records[0] as DroidPacked | undefined
  if (!packed) return { calls: [] }
  return decodeDroid({ records: packed.records, context: input.context, settings: packed.meta.settings, seenKeys: input.seenKeys })
}

function isInternalSession(cwd: string, factoryDir: string): boolean {
  // Skip sessions whose cwd is the .factory directory itself (internal housekeeping)
  const normalized = cwd.replace(/\/+$/, '')
  return normalized === factoryDir
}

function deriveProjectName(cwd: string): string {
  const normalized = cwd.replace(/\/+$/, '')
  const home = homedir()

  // Strip home directory prefix
  let relative = normalized.startsWith(home)
    ? normalized.slice(home.length).replace(/^\/+/, '')
    : normalized.replace(/^\/+/, '')

  if (!relative) relative = '~'

  // Walk from the right: use the "projects/<name>" segment if present,
  // otherwise the last meaningful path component.
  const parts = relative.split('/')
  const projectsIdx = parts.lastIndexOf('projects')
  if (projectsIdx !== -1 && projectsIdx + 1 < parts.length) {
    return parts.slice(projectsIdx + 1).join('/')
  }

  return parts.join('/')
}

async function readFirstJsonlLine(filePath: string): Promise<string | null> {
  for await (const line of readSessionLines(filePath)) {
    return line
  }
  return null
}

async function discoverSessionsInDir(
  sessionsDir: string,
  factoryDir: string,
): Promise<SessionSource[]> {
  const sources: SessionSource[] = []

  let entries: string[]
  try {
    entries = await readdir(sessionsDir)
  } catch {
    return sources
  }

  for (const entry of entries) {
    const subDir = join(sessionsDir, entry)
    const s = await stat(subDir).catch(() => null)
    if (!s?.isDirectory()) continue

    const files = await readdir(subDir).catch(() => [] as string[])
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue
      const filePath = join(subDir, file)

      const firstLine = await readFirstJsonlLine(filePath)
      if (!firstLine?.trim()) continue

      let startEntry: DroidJsonlEntry
      try {
        startEntry = JSON.parse(firstLine) as DroidJsonlEntry
      } catch {
        continue
      }

      if (startEntry.type !== 'session_start') continue

      const cwd = startEntry.cwd ?? entry
      if (isInternalSession(cwd, factoryDir)) continue

      sources.push({
        path: filePath,
        project: deriveProjectName(cwd),
        provider: 'droid',
      })
    }
  }

  return sources
}

export function createDroidProvider(factoryDir?: string): Provider {
  const base = factoryDir ?? getFactoryDir()
  const sessionsDir = join(base, 'sessions')

  return createBridgedProvider<DroidDecodedCall>({
    name: 'droid',
    displayName: 'Droid',

    modelDisplayName(model: string): string {
      return parseModelForDisplay(model)
    },

    toolDisplayName(rawTool: string): string {
      return droidToolNameMap[rawTool] ?? rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      return discoverSessionsInDir(sessionsDir, base)
    },

    // I/O adapter: read the JSONL turns and the companion settings file (which
    // carries session-level token usage + model). Both are packed so the pure
    // decoder — which distributes the session token totals across calls — can
    // consume them through the bridge.
    async readRecords(source: SessionSource): Promise<unknown[] | null> {
      const content = await readSessionFile(source.path)
      if (content === null) return null

      const settingsPath = source.path.replace(/\.jsonl$/, '.settings.json')
      let settings: DroidSettings = {}
      try {
        settings = JSON.parse(await readFile(settingsPath, 'utf-8')) as DroidSettings
      } catch {
        // No settings file or parse error — decoder yields nothing without usage.
      }

      const lines = content.split('\n').filter(l => l.trim())
      const packed: DroidPacked = { meta: { settings }, records: lines }
      return [packed]
    },

    decode,
    toProviderCall,
  })
}

export const droid = createDroidProvider()
