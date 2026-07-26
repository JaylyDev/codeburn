import { readdir, stat } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { homedir, platform } from 'os'

import { decodeOpenDesign } from '@codeburn/core/providers/open-design'
import type { DecodeContext } from '@codeburn/core'
import type { OpenDesignDecodedCall } from '@codeburn/core/providers/open-design'

import { readSessionLines } from '../fs-utils.js'
import { createBridgedProvider } from './bridge.js'
import type { Provider, SessionSource, ParsedProviderCall } from './types.js'

const PROVIDER_NAME = 'open-design'
const ENV_DIR = 'CODEBURN_OPEN_DESIGN_DIR'

const modelDisplayNames = new Map<string, string>([
  ['openai-codex:gpt-5.5', 'GPT-5.5'],
  ['glm-5.2', 'GLM-5.2'],
  ['GLM-5.2', 'GLM-5.2'],
])

// Host-derived scalars the pure core decode needs, packed with the event lines.
type OpenDesignMeta = { sessionId: string; project: string }
type OpenDesignPacked = { meta: OpenDesignMeta; records: unknown[] }

function getOpenDesignDir(): string {
  const override = process.env[ENV_DIR]
  if (override) return override

  const home = homedir()
  const os = platform()
  if (os === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Open Design')
  }
  if (os === 'win32') {
    return join(process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming'), 'Open Design')
  }
  return join(home, '.config', 'Open Design')
}

function namespaceFromDataDir(dataDir: string): string {
  const ns = basename(dirname(dataDir))
  return ns && ns !== 'namespaces' ? ns : PROVIDER_NAME
}

function namespaceFromRunsDir(runsDir: string): string {
  return namespaceFromDataDir(dirname(runsDir))
}

async function discoverRunsDir(runsDir: string, project: string): Promise<SessionSource[]> {
  const sources: SessionSource[] = []
  let runDirs: string[]
  try {
    runDirs = await readdir(runsDir)
  } catch {
    return sources
  }

  for (const runDir of runDirs) {
    const eventsPath = join(runsDir, runDir, 'events.jsonl')
    const s = await stat(eventsPath).catch(() => null)
    if (!s?.isFile()) continue
    sources.push({ path: eventsPath, project, provider: PROVIDER_NAME })
  }

  return sources
}

async function discoverNamespacesDir(namespacesDir: string): Promise<SessionSource[]> {
  const sources: SessionSource[] = []
  let namespaces: string[]
  try {
    namespaces = await readdir(namespacesDir)
  } catch {
    return sources
  }

  for (const ns of namespaces) {
    const runsDir = join(namespacesDir, ns, 'data', 'runs')
    sources.push(...await discoverRunsDir(runsDir, ns))
  }

  return sources
}

function dedupeSources(sources: SessionSource[]): SessionSource[] {
  const seen = new Set<string>()
  const out: SessionSource[] = []
  for (const source of sources) {
    if (seen.has(source.path)) continue
    seen.add(source.path)
    out.push(source)
  }
  return out
}

async function discoverOpenDesignSessions(baseDir: string): Promise<SessionSource[]> {
  const baseName = basename(baseDir)
  if (baseName === 'runs') {
    return discoverRunsDir(baseDir, namespaceFromRunsDir(baseDir))
  }
  if (baseName === 'data') {
    return discoverRunsDir(join(baseDir, 'runs'), namespaceFromDataDir(baseDir))
  }

  const sources: SessionSource[] = []
  sources.push(...await discoverRunsDir(join(baseDir, 'data', 'runs'), basename(baseDir) || PROVIDER_NAME))
  sources.push(...await discoverRunsDir(join(baseDir, 'runs'), basename(baseDir) || PROVIDER_NAME))
  sources.push(...await discoverNamespacesDir(baseName === 'namespaces' ? baseDir : join(baseDir, 'namespaces')))
  return dedupeSources(sources)
}

// Map one rich, cost-free decoder call into the host's ParsedProviderCall. Open
// Design records usage events only — no tools or shell commands.
function toProviderCall(rich: OpenDesignDecodedCall): ParsedProviderCall {
  return {
    provider: PROVIDER_NAME,
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
  }
}

function decode(input: { records: unknown[]; context: DecodeContext; seenKeys: Set<string> }): { calls: OpenDesignDecodedCall[] } {
  const packed = input.records[0] as OpenDesignPacked | undefined
  if (!packed) return { calls: [] }
  return decodeOpenDesign({ records: packed.records, context: input.context, ...packed.meta, seenKeys: input.seenKeys })
}

export function createOpenDesignProvider(overrideDir?: string): Provider {
  return createBridgedProvider<OpenDesignDecodedCall>({
    name: PROVIDER_NAME,
    displayName: 'Open Design',

    modelDisplayName(model: string): string {
      return modelDisplayNames.get(model) ?? model
    },

    toolDisplayName(rawTool: string): string {
      return rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      return discoverOpenDesignSessions(overrideDir ?? getOpenDesignDir())
    },

    // I/O adapter: read the run's events.jsonl lines and pack the session id
    // (derived from the run dir) plus the discovered project so the decoder can
    // reproduce the pre-migration call shape.
    async readRecords(source: SessionSource): Promise<unknown[] | null> {
      const sessionId = basename(dirname(source.path))
      const lines: string[] = []
      for await (const line of readSessionLines(source.path)) lines.push(line)
      const packed: OpenDesignPacked = { meta: { sessionId, project: source.project }, records: lines }
      return [packed]
    },

    decode,
    toProviderCall,
  })
}

export const openDesign = createOpenDesignProvider()
