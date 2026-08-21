import { readdir, stat } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { homedir } from 'os'

import { decodeGrok, grokToolNameMap } from '@codeburn/core/providers/grok'
import type { GrokDecodedCall, GrokSessionRecords, GrokSignals, GrokSummary } from '@codeburn/core/providers/grok'

import { readSessionFile } from '../fs-utils.js'
import { getShortModelName } from '../models.js'
import { extractBashCommands } from '../bash-utils.js'
import { createBridgedProvider } from './bridge.js'
import type { Provider, SessionSource, ParsedProviderCall } from './types.js'

function defaultSessionsDir(): string {
  const home = process.env['GROK_HOME'] ?? join(homedir(), '.grok')
  return join(home, 'sessions')
}

async function readJson<T>(path: string): Promise<T | null> {
  const content = await readSessionFile(path)
  if (content === null) return null
  try {
    return JSON.parse(content) as T
  } catch {
    return null
  }
}

function safeDecode(name: string): string {
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}

async function discoverSessions(sessionsDir: string): Promise<SessionSource[]> {
  const sources: SessionSource[] = []

  let cwdDirs: string[]
  try {
    cwdDirs = await readdir(sessionsDir)
  } catch {
    return sources
  }

  for (const cwdName of cwdDirs) {
    const cwdPath = join(sessionsDir, cwdName)
    const cwdStat = await stat(cwdPath).catch(() => null)
    if (!cwdStat?.isDirectory()) continue

    let sessionDirs: string[]
    try {
      sessionDirs = await readdir(cwdPath)
    } catch {
      continue
    }

    for (const sessionName of sessionDirs) {
      const sessionPath = join(cwdPath, sessionName)
      const sessionStat = await stat(sessionPath).catch(() => null)
      if (!sessionStat?.isDirectory()) continue

      const summary = await readJson<GrokSummary>(join(sessionPath, 'summary.json'))
      if (!summary) continue

      const cwd = summary.info?.cwd ?? safeDecode(cwdName)
      sources.push({ path: join(sessionPath, 'updates.jsonl'), project: basename(cwd), provider: 'grok' })
    }
  }

  return sources
}

function toProviderCall(rich: GrokDecodedCall): ParsedProviderCall {
  return {
    provider: 'grok',
    model: rich.model,
    inputTokens: rich.inputTokens,
    outputTokens: rich.outputTokens,
    cacheCreationInputTokens: rich.cacheCreationInputTokens,
    cacheReadInputTokens: rich.cacheReadInputTokens,
    cachedInputTokens: rich.cachedInputTokens,
    reasoningTokens: rich.reasoningTokens,
    webSearchRequests: rich.webSearchRequests,
    costBasis: 'estimated',
    costIsEstimated: true,
    tools: rich.tools,
    // The legacy grok decode deduped nothing: it pushed every extracted base
    // command into a flat list. Preserve that (no Set) so per-command counts match.
    bashCommands: rich.rawBashCommands.flatMap(c => extractBashCommands(c)),
    subagentTypes: rich.subagentTypes,
    timestamp: rich.timestamp,
    speed: rich.speed,
    deduplicationKey: rich.deduplicationKey,
    userMessage: rich.userMessage,
    sessionId: rich.sessionId,
    project: rich.project,
    projectPath: rich.projectPath,
  }
}

export function createGrokProvider(sessionsDir?: string): Provider {
  const dir = sessionsDir ?? defaultSessionsDir()

  return createBridgedProvider<GrokDecodedCall>({
    name: 'grok',
    displayName: 'Grok Build',

    modelDisplayName(model: string): string {
      if (model.startsWith('grok-build')) return 'Grok Build'
      return getShortModelName(model)
    },

    toolDisplayName(rawTool: string): string {
      return grokToolNameMap[rawTool] ?? rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      return discoverSessions(dir)
    },

    async readRecords(source: SessionSource): Promise<unknown[] | null> {
      const sessionDir = dirname(source.path)
      const [summary, updatesRaw] = await Promise.all([
        readJson<GrokSummary>(join(sessionDir, 'summary.json')),
        readSessionFile(source.path),
      ])
      if (!summary || updatesRaw === null) return null

      const signals = await readJson<GrokSignals>(join(sessionDir, 'signals.json'))
      const cwdEncoded = basename(dirname(sessionDir))
      const cwd = summary.info?.cwd ?? safeDecode(cwdEncoded)
      const record: GrokSessionRecords = {
        summary,
        signals,
        updatesLines: updatesRaw.split('\n').filter(l => l.trim()),
        sourceDir: sessionDir,
        sessionName: basename(sessionDir),
        project: basename(cwd),
      }
      return [record]
    },

    decode: decodeGrok,
    legacyDeduplicationSourceRef: source => dirname(source.path),
    toProviderCall,
  })
}

export const grok = createGrokProvider()
