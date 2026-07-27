import { readdir, readFile, stat } from 'fs/promises'
import { basename, join } from 'path'
import { homedir } from 'os'

import { decodeCodebuff, codebuffToolNameMap } from '@codeburn/core/providers/codebuff'
import type { CodebuffDecodedCall } from '@codeburn/core/providers/codebuff'
import { extractBashCommands } from '../bash-utils.js'
import { createBridgedProvider } from './bridge.js'
import type { Provider, SessionSource, ParsedProviderCall } from './types.js'

// Codebuff (formerly Manicode) uses a credit-based billing system. The local
// chat-messages.json doesn't record per-call token counts the way Claude Code
// or Codex do -- only `credits` on completed assistant messages. We convert
// credits to USD using Codebuff's retail pay-as-you-go rate so the cost shows
// up in the dashboard even when tokens are absent. The rate intentionally
// rounds up to the public PAYG tier ($0.01 / credit) so we never understate
// spend; users on a subscription plan get a conservative upper bound.
const USD_PER_CREDIT = 0.01

// Codebuff's chat history lives under `~/.config/manicode/` (the legacy
// product name is still on disk). Development and staging channels use
// `manicode-dev` and `manicode-staging` -- we walk all three when present.
const CHANNELS = ['manicode', 'manicode-dev', 'manicode-staging'] as const

const modelDisplayNames: Record<string, string> = {
  codebuff: 'Codebuff',
  'codebuff-base': 'Codebuff Base',
  'codebuff-base2': 'Codebuff Base 2',
  'codebuff-lite': 'Codebuff Lite',
  'codebuff-max': 'Codebuff Max',
}

function getCodebuffBaseDir(override?: string): string {
  if (override && override.trim()) return override
  const envPath = process.env['CODEBUFF_DATA_DIR']
  if (envPath && envPath.trim()) return envPath
  return join(homedir(), '.config', 'manicode')
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, 'utf-8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

async function discoverChannel(root: string): Promise<SessionSource[]> {
  const sources: SessionSource[] = []
  const projectsDir = join(root, 'projects')

  let projectNames: string[]
  try {
    projectNames = await readdir(projectsDir)
  } catch {
    return sources
  }

  for (const projectName of projectNames) {
    const chatsDir = join(projectsDir, projectName, 'chats')
    let chatIds: string[]
    try {
      chatIds = await readdir(chatsDir)
    } catch {
      continue
    }

    for (const chatId of chatIds) {
      const chatDir = join(chatsDir, chatId)
      const dirStat = await stat(chatDir).catch(() => null)
      if (!dirStat?.isDirectory()) continue

      const messagesPath = join(chatDir, 'chat-messages.json')
      const messagesStat = await stat(messagesPath).catch(() => null)
      if (!messagesStat?.isFile()) continue

      // Resolve the real cwd from run-state.json so sessions group by the
      // originating project directory instead of the sanitized chat folder
      // name (which is often the same for many users).
      const runState = await readJson<{ cwd?: string; sessionState?: { cwd?: string; projectContext?: { cwd?: string }; fileContext?: { cwd?: string } } }>(
        join(chatDir, 'run-state.json'),
      )
      const cwd =
        runState?.sessionState?.projectContext?.cwd ??
        runState?.sessionState?.fileContext?.cwd ??
        runState?.sessionState?.cwd ??
        runState?.cwd ??
        null
      const project = cwd ? basename(cwd) : projectName

      sources.push({ path: chatDir, project, provider: 'codebuff' })
    }
  }

  return sources
}

async function discoverSessionsInBase(baseDir: string): Promise<SessionSource[]> {
  const results: SessionSource[] = []

  // Honor an explicit override: walk only the provided directory even if it
  // matches one of the channel names literally.
  if (process.env['CODEBUFF_DATA_DIR'] || baseDir !== join(homedir(), '.config', 'manicode')) {
    const rootStat = await stat(baseDir).catch(() => null)
    if (!rootStat?.isDirectory()) return results
    results.push(...await discoverChannel(baseDir))
    return results
  }

  const configDir = join(homedir(), '.config')
  for (const channel of CHANNELS) {
    const root = join(configDir, channel)
    const rootStat = await stat(root).catch(() => null)
    if (!rootStat?.isDirectory()) continue
    results.push(...await discoverChannel(root))
  }
  return results
}

function toProviderCall(rich: CodebuffDecodedCall): ParsedProviderCall {
  return {
    provider: 'codebuff',
    model: rich.model,
    inputTokens: rich.inputTokens,
    outputTokens: rich.outputTokens,
    cacheCreationInputTokens: rich.cacheCreationInputTokens,
    cacheReadInputTokens: rich.cacheReadInputTokens,
    cachedInputTokens: rich.cachedInputTokens,
    reasoningTokens: rich.reasoningTokens,
    webSearchRequests: rich.webSearchRequests,
    costBasis: 'estimated',
    ...(rich.credits > 0 ? { fallbackCostUSD: rich.credits * USD_PER_CREDIT } : {}),
    tools: rich.tools,
    bashCommands: rich.rawBashCommands.flatMap(c => extractBashCommands(c)),
    timestamp: rich.timestamp,
    speed: rich.speed,
    deduplicationKey: rich.deduplicationKey,
    userMessage: rich.userMessage,
    sessionId: rich.sessionId,
  }
}

export function createCodebuffProvider(baseDir?: string): Provider {
  const dir = getCodebuffBaseDir(baseDir)

  return createBridgedProvider<CodebuffDecodedCall>({
    name: 'codebuff',
    displayName: 'Codebuff',

    modelDisplayName(model: string): string {
      return modelDisplayNames[model] ?? model
    },

    toolDisplayName(rawTool: string): string {
      return codebuffToolNameMap[rawTool] ?? rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      return discoverSessionsInBase(dir)
    },

    async readRecords(source: SessionSource): Promise<unknown[] | null> {
      const messages = await readJson<unknown[]>(join(source.path, 'chat-messages.json'))
      if (!Array.isArray(messages)) return null
      return messages
    },

    decode: decodeCodebuff,
    toProviderCall,
  })
}

export const codebuff = createCodebuffProvider()
