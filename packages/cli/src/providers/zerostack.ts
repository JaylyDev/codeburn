import { readdir } from 'fs/promises'
import { basename, join } from 'path'
import { homedir, platform } from 'os'

import { decodeZerostack, zerostackToolNameMap } from '@codeburn/core/providers/zerostack'
import type { DecodeContext } from '@codeburn/core'
import type { ZerostackDecodedCall } from '@codeburn/core/providers/zerostack'

import { readSessionFile } from '../fs-utils.js'
import { getShortModelName } from '../models.js'
import { createBridgedProvider } from './bridge.js'
import type { Provider, SessionSource, ParsedProviderCall } from './types.js'

// The host-derived scalars the core decoder needs, packed alongside the session
// records so they reach the pure decode through the bridge's fixed decode
// signature (records + context + seenKeys only).
type ZerostackMeta = { project: string; sessionIdFallback: string }
type ZerostackPacked = { meta: ZerostackMeta; records: unknown[] }

async function readSession(path: string): Promise<unknown | null> {
  const content = await readSessionFile(path)
  if (content === null) return null
  try {
    return JSON.parse(content) as unknown
  } catch {
    return null
  }
}

function toProviderCall(rich: ZerostackDecodedCall): ParsedProviderCall {
  return {
    provider: 'zerostack',
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
    bashCommands: rich.rawBashCommands,
    timestamp: rich.timestamp,
    speed: rich.speed,
    deduplicationKey: rich.deduplicationKey,
    userMessage: rich.userMessage,
    sessionId: rich.sessionId,
    ...(rich.project !== undefined ? { project: rich.project } : {}),
    ...(rich.projectPath !== undefined ? { projectPath: rich.projectPath } : {}),
  }
}

function decode(input: { records: unknown[]; context: DecodeContext; seenKeys: Set<string> }): { calls: ZerostackDecodedCall[] } {
  const packed = input.records[0] as ZerostackPacked | undefined
  if (!packed) return { calls: [] }
  return decodeZerostack({ records: packed.records, context: input.context, ...packed.meta, seenKeys: input.seenKeys })
}

function defaultSessionsDir(): string {
  const override = process.env['ZS_DATA_DIR']
  if (override) return join(override, 'sessions')
  const base =
    platform() === 'darwin'
      ? join(homedir(), 'Library', 'Application Support')
      : process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share')
  return join(base, 'zerostack', 'sessions')
}

export function createZerostackProvider(sessionsDir?: string): Provider {
  const dir = sessionsDir ?? defaultSessionsDir()

  return createBridgedProvider<ZerostackDecodedCall>({
    name: 'zerostack',
    displayName: 'Zerostack',

    modelDisplayName(model: string): string {
      // OpenRouter routes arrive prefixed (e.g. "deepseek/deepseek-v4-pro").
      return getShortModelName(model.replace(/^[^/]+\//, ''))
    },

    toolDisplayName(rawTool: string): string {
      return zerostackToolNameMap[rawTool] ?? rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      let files: string[]
      try {
        files = await readdir(dir)
      } catch {
        return []
      }

      const sources: SessionSource[] = []
      for (const file of files) {
        if (!file.endsWith('.json')) continue
        const path = join(dir, file)
        const session = await readSession(path)
        if (!session) continue
        const sessionObj = session as Record<string, unknown> | null
        const project = sessionObj?.working_dir ? basename(sessionObj.working_dir as string) : basename(file, '.json')
        sources.push({ path, project, provider: 'zerostack' })
      }
      return sources
    },

    async readRecords(source: SessionSource): Promise<unknown[] | null> {
      const session = await readSession(source.path)
      if (!session) return null
      const packed: ZerostackPacked = {
        meta: { project: source.project, sessionIdFallback: basename(source.path, '.json') },
        records: [session],
      }
      return [packed]
    },

    decode,
    legacyDeduplicationSourceRef: source => source.path,
    toProviderCall,
  })
}

export const zerostack = createZerostackProvider()
