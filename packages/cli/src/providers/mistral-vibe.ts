import { readdir, stat } from 'fs/promises'
import { basename, join } from 'path'
import { homedir } from 'os'

import { decodeMistralVibe, mistralVibeToolNameMap } from '@codeburn/core/providers/mistral-vibe'
import type { MistralVibeDecodedCall, VibeMetadata } from '@codeburn/core/providers/mistral-vibe'

import { readSessionFile, readSessionLines } from '../fs-utils.js'
import { calculateCost } from '../models.js'
import { extractBashCommands } from '../bash-utils.js'
import { safeNumber } from '../parser.js'
import { createBridgedProvider } from './bridge.js'
import type { Provider, SessionSource, ParsedProviderCall } from './types.js'

const METADATA_FILENAME = 'meta.json'
const MESSAGES_FILENAME = 'messages.jsonl'
const DEFAULT_MODEL = 'mistral-medium-3.5'

const modelDisplayNames: Record<string, string> = {
  'mistral-medium-3.5': 'Mistral Medium 3.5',
  'mistral-vibe-cli-latest': 'Mistral Vibe CLI',
  'devstral-small': 'Devstral Small',
  'devstral-small-latest': 'Devstral Small',
  devstral: 'Devstral',
  local: 'Local',
}

type VibeModelConfig = {
  name?: string
  alias?: string
  input_price?: number
  output_price?: number
}

function getMistralVibeSessionsDir(override?: string): string {
  if (override) return override
  const configuredHome = process.env['VIBE_HOME']
  const vibeHome = configuredHome ? expandHome(configuredHome) : join(homedir(), '.vibe')
  return join(vibeHome, 'logs', 'session')
}

function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

async function isFile(path: string): Promise<boolean> {
  const s = await stat(path).catch(() => null)
  return Boolean(s?.isFile())
}

async function isDirectory(path: string): Promise<boolean> {
  const s = await stat(path).catch(() => null)
  return Boolean(s?.isDirectory())
}

async function hasSessionFiles(dir: string): Promise<boolean> {
  const [hasMetadata, hasMessages] = await Promise.all([
    isFile(join(dir, METADATA_FILENAME)),
    isFile(join(dir, MESSAGES_FILENAME)),
  ])
  return hasMetadata && hasMessages
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  const raw = await readSessionFile(path)
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    return typeof parsed === 'object' && parsed !== null ? parsed as T : null
  } catch {
    return null
  }
}

async function discoverSessionDirs(root: string): Promise<string[]> {
  const sessionDirs: string[] = []

  let entries: string[]
  try {
    entries = (await readdir(root)).sort()
  } catch {
    return sessionDirs
  }

  for (const entry of entries) {
    const dir = join(root, entry)
    if (!await isDirectory(dir)) continue

    if (await hasSessionFiles(dir)) {
      sessionDirs.push(dir)
    }

    const agentsDir = join(dir, 'agents')
    if (!await isDirectory(agentsDir)) continue

    let agentEntries: string[]
    try {
      agentEntries = (await readdir(agentsDir)).sort()
    } catch {
      continue
    }

    for (const agentEntry of agentEntries) {
      const agentDir = join(agentsDir, agentEntry)
      if (await isDirectory(agentDir) && await hasSessionFiles(agentDir)) {
        sessionDirs.push(agentDir)
      }
    }
  }

  return sessionDirs
}

function activeModelConfig(metadata: VibeMetadata): VibeModelConfig | null {
  const activeModel = metadata.config?.active_model
  const models = metadata.config?.models
  if (!activeModel || !Array.isArray(models)) return null
  return models.find(m => m.alias === activeModel || m.name === activeModel) ?? null
}

function resolveModel(metadata: VibeMetadata): string {
  const activeModel = metadata.config?.active_model
  if (activeModel) return activeModel
  const configured = activeModelConfig(metadata)
  return configured?.alias ?? configured?.name ?? DEFAULT_MODEL
}

// Session-cost resolution, host-side by construction (Phase 8 resolution of the
// Phase 0 misfit): this helper computes ONE session cost — a provider-reported
// `session_cost`, else Vibe's own per-million prices, else the generic price
// table — which the core decoder then ALLOCATES evenly across the session's
// assistant messages (allocateCost). Per-call token buckets therefore do not
// each reproduce their per-call dollar figure, so the generic 'estimated' pass
// cannot recreate the number. The allocated dollar figure is authoritative, so
// emitted calls are marked costBasis 'measured' and the pass passes costUSD
// through untouched. Only the last of the three branches consults the price
// table — which is why the whole resolution stays here: pricing tables may not
// cross into @codeburn/core.
function calculateSessionCost(metadata: VibeMetadata, model: string, inputTokens: number, outputTokens: number): number {
  const stats = metadata.stats ?? {}
  const sessionCost = safeNumber(stats.session_cost)
  if (sessionCost > 0) return sessionCost

  const configured = activeModelConfig(metadata)
  const inputPrice = safeNumber(stats.input_price_per_million) || safeNumber(configured?.input_price)
  const outputPrice = safeNumber(stats.output_price_per_million) || safeNumber(configured?.output_price)

  if (inputPrice > 0 || outputPrice > 0) {
    return (inputTokens / 1_000_000) * inputPrice + (outputTokens / 1_000_000) * outputPrice
  }

  return calculateCost(model, inputTokens, outputTokens, 0, 0, 0)
}

async function readMessages(path: string): Promise<unknown[]> {
  const messages: unknown[] = []
  for await (const line of readSessionLines(path)) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as unknown
      if (parsed && typeof parsed === 'object') messages.push(parsed)
    } catch {
      continue
    }
  }
  return messages
}

// Map one rich, measured decoder call into the host's ParsedProviderCall. The
// core decoder already allocated the session-level dollar figure across
// assistant messages, so this adapter passes it through untouched with
// `costBasis: 'measured'`.
function toProviderCall(rich: MistralVibeDecodedCall): ParsedProviderCall {
  return {
    provider: 'mistral-vibe',
    model: rich.model,
    inputTokens: rich.inputTokens,
    outputTokens: rich.outputTokens,
    cacheCreationInputTokens: rich.cacheCreationInputTokens,
    cacheReadInputTokens: rich.cacheReadInputTokens,
    cachedInputTokens: rich.cachedInputTokens,
    reasoningTokens: rich.reasoningTokens,
    webSearchRequests: rich.webSearchRequests,
    costUSD: rich.measuredCostUSD,
    costBasis: 'measured',
    tools: rich.tools,
    bashCommands: [...new Set(rich.rawBashCommands.flatMap(c => extractBashCommands(c)))],
    timestamp: rich.timestamp,
    speed: rich.speed,
    deduplicationKey: rich.deduplicationKey,
    ...(rich.turnId === undefined ? {} : { turnId: rich.turnId }),
    userMessage: rich.userMessage,
    sessionId: rich.sessionId,
  }
}

export function createMistralVibeProvider(sessionsDir?: string): Provider {
  const dir = getMistralVibeSessionsDir(sessionsDir)

  return createBridgedProvider<MistralVibeDecodedCall>({
    name: 'mistral-vibe',
    displayName: 'Mistral Vibe',

    modelDisplayName(model: string): string {
      return modelDisplayNames[model] ?? model
    },

    toolDisplayName(rawTool: string): string {
      return mistralVibeToolNameMap[rawTool] ?? rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      const dirs = await discoverSessionDirs(dir)
      const sources: SessionSource[] = []

      for (const sessionDir of dirs) {
        const metadata = await readJsonFile<VibeMetadata>(join(sessionDir, METADATA_FILENAME))
        if (!metadata) continue
        const cwd = metadata.environment?.working_directory
        sources.push({
          path: sessionDir,
          project: cwd ? basename(cwd) : basename(sessionDir),
          provider: 'mistral-vibe',
        })
      }

      return sources
    },

    // I/O adapter: read `meta.json` and `messages.jsonl`, resolve the session-
    // level cost host-side (including the generic price-table fallback), and hand
    // the core decoder `[{ metadata, sessionCost, sessionIdFallback }, ...messages]`.
    // The fallback id is the session directory's basename, which the pre-migration
    // decode used whenever `meta.json` omitted `session_id`.
    async readRecords(source: SessionSource): Promise<unknown[] | null> {
      const metadata = await readJsonFile<VibeMetadata>(join(source.path, METADATA_FILENAME))
      if (!metadata) return null

      const stats = metadata.stats ?? {}
      const inputTokens = safeNumber(stats.session_prompt_tokens)
      const outputTokens = safeNumber(stats.session_completion_tokens)
      if (inputTokens === 0 && outputTokens === 0) return []

      const messages = await readMessages(join(source.path, MESSAGES_FILENAME))
      const model = resolveModel(metadata)
      const sessionCost = calculateSessionCost(metadata, model, inputTokens, outputTokens)

      return [{ metadata, sessionCost, sessionIdFallback: basename(source.path) }, ...messages]
    },

    decode: decodeMistralVibe,
    toProviderCall,
  })
}

export const mistralVibe = createMistralVibeProvider()
