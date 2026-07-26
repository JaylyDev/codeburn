import { readdir, stat } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

import { decodeGemini, geminiToolNameMap } from '@codeburn/core/providers/gemini'
import type { GeminiDecodedCall } from '@codeburn/core/providers/gemini'

import { readSessionFile } from '../fs-utils.js'
import { extractBashCommands } from '../bash-utils.js'
import { createBridgedProvider } from './bridge.js'
import type { Provider, SessionSource, ParsedProviderCall } from './types.js'

// Map one rich, cost-free decoder call into the host's ParsedProviderCall. Cost
// re-enters here: `costBasis: 'estimated'` marks the call so the parser.ts
// pricing pass fills `costUSD` from the token buckets. Bash base-name
// extraction (and its `strip-ansi` dependency) stays CLI-side: the core decoder
// carries the raw command strings; the host reduces them to base names here.
function toProviderCall(rich: GeminiDecodedCall): ParsedProviderCall {
  return {
    provider: 'gemini',
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
    turnId: rich.turnId,
    userMessage: rich.userMessage,
    sessionId: rich.sessionId,
  }
}

function getGeminiTmpDir(): string {
  return join(homedir(), '.gemini', 'tmp')
}

async function discoverSessions(): Promise<SessionSource[]> {
  const sources: SessionSource[] = []
  const tmpDir = getGeminiTmpDir()

  let projectDirs: string[]
  try {
    const entries = await readdir(tmpDir, { withFileTypes: true })
    projectDirs = entries.filter(e => e.isDirectory()).map(e => e.name)
  } catch {
    return sources
  }

  for (const project of projectDirs) {
    const chatsDir = join(tmpDir, project, 'chats')
    let files: string[]
    try {
      const entries = await readdir(chatsDir)
      files = entries.filter(f => f.startsWith('session-') && (f.endsWith('.json') || f.endsWith('.jsonl')))
    } catch {
      continue
    }

    for (const file of files) {
      const filePath = join(chatsDir, file)
      const s = await stat(filePath).catch(() => null)
      if (!s?.isFile()) continue
      sources.push({ path: filePath, project, provider: 'gemini' })
    }
  }

  return sources
}

export function createGeminiProvider(): Provider {
  return createBridgedProvider<GeminiDecodedCall>({
    name: 'gemini',
    displayName: 'Gemini',

    modelDisplayName(model: string): string {
      if (model === 'gemini-auto') return 'Gemini (auto)'
      const display: Record<string, string> = {
        'gemini-3-flash-preview': 'Gemini 3 Flash',
        'gemini-3.5-flash': 'Gemini 3.5 Flash',
        'gemini-3.1-pro-preview': 'Gemini 3.1 Pro',
        'gemini-2.5-pro': 'Gemini 2.5 Pro',
        'gemini-2.5-flash': 'Gemini 2.5 Flash',
        'gemini-2.0-flash': 'Gemini 2.0 Flash',
      }
      return display[model] ?? model
    },

    toolDisplayName(rawTool: string): string {
      return geminiToolNameMap[rawTool] ?? rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      return discoverSessions()
    },

    // I/O adapter: read the raw session file. The core decoder does its own
    // format detection (single JSON <=0.38 vs headerless JSONL >=0.39).
    async readRecords(source: SessionSource): Promise<unknown[] | null> {
      const raw = await readSessionFile(source.path)
      if (raw === null) return null
      return [raw]
    },

    decode: decodeGemini,
    toProviderCall,
  })
}

export const gemini = createGeminiProvider()
