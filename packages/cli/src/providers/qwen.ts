import { readdir, stat } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

import { decodeQwen, qwenToolNameMap } from '@codeburn/core/providers/qwen'
import type { QwenDecodedCall } from '@codeburn/core/providers/qwen'

import { readSessionFile } from '../fs-utils.js'
import { extractBashCommands } from '../bash-utils.js'
import { createBridgedProvider } from './bridge.js'
import type { Provider, SessionSource, ParsedProviderCall } from './types.js'

function getQwenProjectsDir(): string {
  return process.env['QWEN_DATA_DIR'] ?? join(homedir(), '.qwen', 'projects')
}

function projectNameFromDirName(dirName: string): string {
  const parts = dirName.replace(/^-/, '').split('-')
  return parts[parts.length - 1] || dirName
}

// Map one rich, cost-free decoder call into the host's ParsedProviderCall. Cost
// re-enters here: `costBasis: 'estimated'` marks the call so the parser.ts
// pricing pass fills `costUSD` from the token buckets (byte-identical to the
// pre-migration in-decoder `calculateCost`, retired in Phase 0). Bash base-name
// extraction (and its `strip-ansi` dependency) stays CLI-side: the core decoder
// carries the raw command strings; the host reduces them to base names here.
function toProviderCall(rich: QwenDecodedCall): ParsedProviderCall {
  return {
    provider: 'qwen',
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
    bashCommands: [...new Set(rich.rawBashCommands.flatMap(c => extractBashCommands(c)))],
    timestamp: rich.timestamp,
    speed: rich.speed,
    deduplicationKey: rich.deduplicationKey,
    userMessage: rich.userMessage,
    sessionId: rich.sessionId,
  }
}

export function createQwenProvider(overrideDir?: string): Provider {
  const projectsDir = overrideDir ?? getQwenProjectsDir()

  return createBridgedProvider<QwenDecodedCall>({
    name: 'qwen',
    displayName: 'Qwen',

    modelDisplayName(model: string): string {
      return model
    },

    toolDisplayName(rawTool: string): string {
      return qwenToolNameMap[rawTool] ?? rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      const sources: SessionSource[] = []

      let projectDirs: string[]
      try {
        projectDirs = await readdir(projectsDir)
      } catch {
        return sources
      }

      for (const projDir of projectDirs) {
        const chatsDir = join(projectsDir, projDir, 'chats')
        const project = projectNameFromDirName(projDir)

        let chatFiles: string[]
        try {
          chatFiles = await readdir(chatsDir)
        } catch {
          continue
        }

        for (const file of chatFiles) {
          if (!file.endsWith('.jsonl')) continue
          const filePath = join(chatsDir, file)
          const s = await stat(filePath).catch(() => null)
          if (!s?.isFile()) continue
          sources.push({ path: filePath, project, provider: 'qwen' })
        }
      }

      return sources
    },

    // I/O adapter: read the chat file and split into JSONL records. The core
    // decoder parses each line and threads the shared dedup set.
    async readRecords(source: SessionSource): Promise<unknown[] | null> {
      const raw = await readSessionFile(source.path)
      if (raw === null) return null
      return raw.split('\n').filter(l => l.trim())
    },

    decode: decodeQwen,
    toProviderCall,
  })
}

export const qwen = createQwenProvider()
