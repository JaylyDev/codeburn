import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

import { decodeOpenClaw, openclawToolNameMap } from '@codeburn/core/providers/openclaw'
import type { OpenClawDecodedCall } from '@codeburn/core/providers/openclaw'
import { readSessionFile } from '../fs-utils.js'
import { extractBashCommands } from '../bash-utils.js'
import { createBridgedProvider } from './bridge.js'
import type { Provider, SessionSource, ParsedProviderCall } from './types.js'

type SessionIndex = Record<string, {
  sessionId: string
  sessionFile?: string
}>

function getOpenClawDirs(): string[] {
  const home = homedir()
  return [
    join(home, '.openclaw', 'agents'),
    join(home, '.clawdbot', 'agents'),
    join(home, '.moltbot', 'agents'),
    join(home, '.moldbot', 'agents'),
  ]
}

async function discoverInDir(agentsDir: string): Promise<SessionSource[]> {
  const sources: SessionSource[] = []

  let agentDirs: string[]
  try {
    const entries = await readdir(agentsDir, { withFileTypes: true })
    agentDirs = entries.filter(e => e.isDirectory()).map(e => e.name)
  } catch {
    return sources
  }

  for (const agent of agentDirs) {
    const sessionsDir = join(agentsDir, agent, 'sessions')

    let indexData: SessionIndex = {}
    try {
      const indexRaw = await readFile(join(sessionsDir, 'sessions.json'), 'utf-8')
      indexData = JSON.parse(indexRaw)
    } catch { /* no index, fall back to directory scan */ }

    const seenFiles = new Set<string>()

    for (const entry of Object.values(indexData)) {
      if (entry.sessionFile) {
        seenFiles.add(entry.sessionFile)
        sources.push({ path: entry.sessionFile, project: agent, provider: 'openclaw' })
      } else if (entry.sessionId) {
        const filePath = join(sessionsDir, `${entry.sessionId}.jsonl`)
        seenFiles.add(filePath)
        sources.push({ path: filePath, project: agent, provider: 'openclaw' })
      }
    }

    try {
      const files = await readdir(sessionsDir)
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue
        const filePath = join(sessionsDir, f)
        if (seenFiles.has(filePath)) continue
        sources.push({ path: filePath, project: agent, provider: 'openclaw' })
      }
    } catch { /* directory may not exist */ }
  }

  return sources
}

function toProviderCall(rich: OpenClawDecodedCall): ParsedProviderCall {
  return {
    provider: 'openclaw',
    model: rich.model,
    inputTokens: rich.inputTokens,
    outputTokens: rich.outputTokens,
    cacheCreationInputTokens: rich.cacheCreationInputTokens,
    cacheReadInputTokens: rich.cacheReadInputTokens,
    cachedInputTokens: rich.cachedInputTokens,
    reasoningTokens: rich.reasoningTokens,
    webSearchRequests: rich.webSearchRequests,
    ...(rich.costBasis === 'measured'
      ? { costUSD: rich.costUSD, costBasis: 'measured' as const }
      : { costBasis: 'estimated' as const }),
    tools: [...new Set(rich.tools)],
    bashCommands: [...new Set(rich.rawBashCommands.flatMap(c => extractBashCommands(c)))],
    timestamp: rich.timestamp,
    speed: rich.speed,
    deduplicationKey: rich.deduplicationKey,
    userMessage: rich.userMessage,
    sessionId: rich.sessionId,
  }
}

export function createOpenClawProvider(overrideDir?: string): Provider {
  return createBridgedProvider<OpenClawDecodedCall>({
    name: 'openclaw',
    displayName: 'OpenClaw',

    modelDisplayName(model: string): string {
      return model
    },

    toolDisplayName(rawTool: string): string {
      return openclawToolNameMap[rawTool] ?? rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      if (overrideDir) return discoverInDir(overrideDir)
      const all: SessionSource[] = []
      for (const dir of getOpenClawDirs()) {
        const sessions = await discoverInDir(dir)
        all.push(...sessions)
      }
      return all
    },

    async readRecords(source: SessionSource): Promise<unknown[] | null> {
      const raw = await readSessionFile(source.path)
      if (raw === null) return null
      return raw.split('\n').filter(l => l.trim())
    },

    decode: decodeOpenClaw,
    toProviderCall,
  })
}

export const openclaw = createOpenClawProvider()
