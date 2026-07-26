import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import { decodeKimicode, kimicodeToolNameMap } from '@codeburn/core/providers/kimicode'
import type { KimicodeDecodedCall } from '@codeburn/core/providers/kimicode'
import type { DecodeContext } from '@codeburn/core'
import { extractBashCommands } from '../bash-utils.js'
import { createBridgedProvider } from './bridge.js'
import type { ParsedProviderCall, ProbeRoot, Provider, SessionSource } from './types.js'

function kimicodeHomes(override?: string): string[] {
  const explicit = override || process.env['KIMI_CODE_HOME']
  if (explicit) return [resolve(explicit)]
  // Default stores. Beyond the CLI's own ~/.kimi-code, embedded runtimes keep
  // the same wire layout under their own home (Kimi desktop app, Kimi Code
  // IDE); each home is scanned so embedded-agent usage is not invisible.
  const home = homedir()
  const homes = [
    join(home, '.kimi-code'),
    join(home, 'Library', 'Application Support', 'kimi-desktop', 'daimon-share', 'daimon', 'runtime', 'kimi-code', 'home'),
  ]
  return [...new Set(homes.map(h => resolve(h)))]
}

async function directoryEntries(path: string) {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch {
    return []
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function readState(sessionDir: string): Promise<{ createdAt?: string; updatedAt?: string; workDir?: string }> {
  try {
    const state = JSON.parse(await readFile(join(sessionDir, 'state.json'), 'utf8'))
    if (!state || typeof state !== 'object') return {}
    return {
      createdAt: typeof state.createdAt === 'string' ? state.createdAt.trim() || undefined : undefined,
      updatedAt: typeof state.updatedAt === 'string' ? state.updatedAt.trim() || undefined : undefined,
      workDir: typeof state.workDir === 'string' ? state.workDir.trim() || undefined : undefined,
    }
  } catch {
    return {}
  }
}

function projectFromWorkDir(workDir: string, workDirKey: string): string {
  if (workDir) return basename(workDir.replace(/[\\/]+$/, '')) || workDir
  const match = /^wd_(.+)_[a-f0-9]{12}$/i.exec(workDirKey)
  return match?.[1] || workDirKey.replace(/^wd_/, '') || 'kimicode'
}

async function discoverSources(root: string): Promise<SessionSource[]> {
  const sources: SessionSource[] = []
  const sessionsDir = join(root, 'sessions')

  for (const workDirEntry of await directoryEntries(sessionsDir)) {
    if (!workDirEntry.isDirectory() || !workDirEntry.name.startsWith('wd_')) continue
    const workDirPath = join(sessionsDir, workDirEntry.name)

    for (const sessionEntry of await directoryEntries(workDirPath)) {
      // Session dir naming differs by host product: the CLI uses session_*,
      // embedded runtimes (desktop app, IDE) use conv-*/ctitle-*. Any directory
      // is accepted; the agents/*/wire.jsonl probe below gates real sessions.
      if (!sessionEntry.isDirectory()) continue
      const sessionDir = join(workDirPath, sessionEntry.name)
      const state = await readState(sessionDir)
      const project = projectFromWorkDir(state.workDir ?? '', workDirEntry.name)

      for (const agentEntry of await directoryEntries(join(sessionDir, 'agents'))) {
        if (!agentEntry.isDirectory()) continue
        const wirePath = join(sessionDir, 'agents', agentEntry.name, 'wire.jsonl')
        if (!await isFile(wirePath)) continue
        sources.push({
          path: wirePath,
          project,
          provider: 'kimicode',
          sourceId: agentEntry.name,
          sourceLabel: agentEntry.name,
          sourcePath: state.workDir,
        })
      }
    }
  }

  return sources.sort((a, b) => a.path.localeCompare(b.path))
}

function sessionDirForWire(path: string): string {
  return dirname(dirname(dirname(path)))
}

function sessionIdForWire(path: string): string {
  return basename(sessionDirForWire(path)).replace(/^session_/, '')
}

function agentIdForWire(path: string): string {
  return basename(dirname(path))
}

function toProviderCall(rich: KimicodeDecodedCall): ParsedProviderCall {
  return {
    provider: 'kimicode',
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
    // Kimicode's legacy decode did NOT dedup bash commands: pendingBashCommands
    // was a flat list of every extracted base name. Preserve that (no Set).
    bashCommands: rich.rawBashCommands.flatMap(c => extractBashCommands(c)),
    timestamp: rich.timestamp,
    speed: rich.speed,
    deduplicationKey: rich.deduplicationKey,
    turnId: rich.turnId,
    userMessage: rich.userMessage,
    sessionId: rich.sessionId,
    project: rich.project,
    projectPath: rich.projectPath,
  }
}

// Host-derived scalars the pure core decode needs, packed alongside the wire
// lines so they cross the bridge's fixed decode signature (same pattern as
// droid). The session-state timestamps feed the decoder's last-resort timestamp
// fallback; sessionId/agentId feed the dedup key; project/projectPath are stamped
// onto each call.
type KimicodeMeta = {
  sessionId: string
  agentId: string
  project: string
  projectPath?: string
  stateUpdatedAt?: string
  stateCreatedAt?: string
}
type KimicodePacked = { meta: KimicodeMeta; records: unknown[] }

async function readRecords(source: SessionSource): Promise<unknown[] | null> {
  let contents: string
  try {
    contents = await readFile(source.path, 'utf8')
  } catch {
    return null
  }

  const sessionDir = sessionDirForWire(source.path)
  const sessionId = sessionIdForWire(source.path)
  const agentId = source.sourceId || agentIdForWire(source.path)
  const state = await readState(sessionDir)
  const projectPath = state.workDir || source.sourcePath

  // Preserve legacy line indexing: the dedup key embeds `lineIndex + 1` over the
  // raw \r?\n split (blank lines included), so do NOT filter here.
  const lines = contents.split(/\r?\n/)
  const packed: KimicodePacked = {
    meta: {
      sessionId,
      agentId,
      project: source.project ?? '',
      projectPath,
      stateUpdatedAt: state.updatedAt,
      stateCreatedAt: state.createdAt,
    },
    records: lines,
  }
  return [packed]
}

function decode(input: { records: unknown[]; context: DecodeContext; seenKeys: Set<string> }): { calls: KimicodeDecodedCall[] } {
  const packed = input.records[0] as KimicodePacked | undefined
  if (!packed) return { calls: [] }
  return decodeKimicode({
    records: packed.records,
    context: input.context,
    seenKeys: input.seenKeys,
    sessionId: packed.meta.sessionId,
    agentId: packed.meta.agentId,
    project: packed.meta.project,
    projectPath: packed.meta.projectPath,
    stateUpdatedAt: packed.meta.stateUpdatedAt,
    stateCreatedAt: packed.meta.stateCreatedAt,
  })
}

export function createKimicodeProvider(homeOverride?: string): Provider {
  return createBridgedProvider<KimicodeDecodedCall>({
    name: 'kimicode',
    displayName: 'Kimi Code',

    modelDisplayName(model: string): string {
      return model
    },

    toolDisplayName(rawTool: string): string {
      return kimicodeToolNameMap[rawTool] ?? rawTool
    },

    async probeRoots(): Promise<ProbeRoot[]> {
      return kimicodeHomes(homeOverride).map(path => ({ path, label: 'Kimi Code home' }))
    },

    async discoverSessions(): Promise<SessionSource[]> {
      const all: SessionSource[] = []
      for (const home of kimicodeHomes(homeOverride)) {
        all.push(...await discoverSources(home))
      }
      return all.sort((a, b) => a.path.localeCompare(b.path))
    },

    async readRecords(source: SessionSource): Promise<unknown[] | null> {
      return readRecords(source)
    },

    decode,
    toProviderCall,
  })
}

export const kimicode = createKimicodeProvider()
