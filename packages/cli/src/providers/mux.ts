import { readdir, readFile, stat } from 'fs/promises'
import { basename, dirname, join, resolve } from 'path'
import { homedir } from 'os'

import { decodeMux, muxToolNameMap } from '@codeburn/core/providers/mux'
import type { DecodeContext } from '@codeburn/core'
import type { MuxDecodedCall } from '@codeburn/core/providers/mux'

import { readSessionLines } from '../fs-utils.js'
import { getShortModelName } from '../models.js'
import { extractBashCommands } from '../bash-utils.js'
import { createBridgedProvider } from './bridge.js'
import type { Provider, SessionSource, ParsedProviderCall } from './types.js'

// Host-derived scalars the pure core decode needs, packed with the JSONL lines.
type MuxMeta = { workspaceId: string }
type MuxPacked = { meta: MuxMeta; records: unknown[] }

function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2))
  return p
}

function getMuxRoot(override?: string): string {
  if (override) return resolve(expandHome(override))
  const codeburnOverride = process.env['CODEBURN_MUX_DIR']
  if (codeburnOverride) return resolve(expandHome(codeburnOverride))
  const muxRoot = process.env['MUX_ROOT']
  if (muxRoot) return resolve(expandHome(muxRoot))
  return join(homedir(), '.mux')
}

// Splits on the first colon only, leaving any colon inside the id intact.
// Display-layer only; the decoder strips the prefix for the emitted call model.
function stripProvider(model: string): string {
  const i = model.indexOf(':')
  return i >= 0 ? model.slice(i + 1) : model
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : undefined
}

// config.json shape: { projects: [[projectPath, { workspaces: [{ id }] }], ...] }
async function loadProjectMap(root: string): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  let data: unknown
  try {
    data = JSON.parse(await readFile(join(root, 'config.json'), 'utf-8'))
  } catch {
    return map
  }
  const projects = asRecord(data)?.['projects']
  if (!Array.isArray(projects)) return map
  for (const pair of projects) {
    if (!Array.isArray(pair) || pair.length < 2) continue
    const projectPath = pair[0]
    if (typeof projectPath !== 'string') continue
    const label = basename(projectPath) || projectPath
    const workspaces = asRecord(pair[1])?.['workspaces']
    if (!Array.isArray(workspaces)) continue
    for (const ws of workspaces) {
      const id = asRecord(ws)?.['id']
      if (typeof id === 'string' && id) map.set(id, label)
    }
  }
  return map
}

async function pushChatSource(sources: SessionSource[], chatPath: string, project: string): Promise<void> {
  const s = await stat(chatPath).catch(() => null)
  if (s?.isFile()) sources.push({ path: chatPath, project, provider: 'mux' })
}

async function discoverSessions(root: string): Promise<SessionSource[]> {
  const sessionsDir = join(root, 'sessions')

  let workspaceIds: string[]
  try {
    workspaceIds = await readdir(sessionsDir)
  } catch {
    return []
  }

  const projectMap = await loadProjectMap(root)
  const sources: SessionSource[] = []
  for (const workspaceId of workspaceIds) {
    const workspaceDir = join(sessionsDir, workspaceId)
    const project = projectMap.get(workspaceId) ?? workspaceId

    // The workspace's own turns.
    await pushChatSource(sources, join(workspaceDir, 'chat.jsonl'), project)

    // Sub-agent turns. Each spawned sub-agent is a separate LLM-client session
    // recorded at subagent-transcripts/<childTaskId>/chat.jsonl — mux does NOT
    // mirror these into a top-level sessions/<id> dir, so they are only
    // reachable here. They carry real token usage (often the bulk of a
    // session's spend) and are attributed to the parent workspace's project.
    // Dedup stays correct: the parser keys off the child-task dir name, which
    // is distinct from every workspace id, so each call is still counted once.
    const subagentDir = join(workspaceDir, 'subagent-transcripts')
    let childTaskIds: string[]
    try {
      childTaskIds = await readdir(subagentDir)
    } catch {
      continue
    }
    for (const childTaskId of childTaskIds) {
      await pushChatSource(sources, join(subagentDir, childTaskId, 'chat.jsonl'), project)
    }
  }
  return sources
}

// Map one rich, cost-free decoder call into the host's ParsedProviderCall. Cost
// re-enters here; extractBashCommands (with its strip-ansi dependency) runs on
// the raw scripts the decoder carried through.
function toProviderCall(rich: MuxDecodedCall): ParsedProviderCall {
  return {
    provider: 'mux',
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
    bashCommands: rich.rawBashCommands.flatMap(c => extractBashCommands(c)),
    timestamp: rich.timestamp,
    speed: rich.speed,
    deduplicationKey: rich.deduplicationKey,
    userMessage: rich.userMessage,
    sessionId: rich.sessionId,
  }
}

function decode(input: { records: unknown[]; context: DecodeContext; seenKeys: Set<string> }): { calls: MuxDecodedCall[] } {
  const packed = input.records[0] as MuxPacked | undefined
  if (!packed) return { calls: [] }
  return decodeMux({ records: packed.records, context: input.context, workspaceId: packed.meta.workspaceId, seenKeys: input.seenKeys })
}

export function createMuxProvider(muxRoot?: string): Provider {
  const root = getMuxRoot(muxRoot)

  return createBridgedProvider<MuxDecodedCall>({
    name: 'mux',
    displayName: 'Mux',

    modelDisplayName(model: string): string {
      return getShortModelName(stripProvider(model))
    },

    toolDisplayName(rawTool: string): string {
      return muxToolNameMap[rawTool] ?? rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      return discoverSessions(root)
    },

    // I/O adapter: read the chat JSONL lines and pack the workspace id (derived
    // from the source path) the decoder folds into dedup keys and session ids.
    async readRecords(source: SessionSource): Promise<unknown[] | null> {
      const workspaceId = basename(dirname(source.path))
      const lines: string[] = []
      for await (const line of readSessionLines(source.path)) lines.push(line)
      const packed: MuxPacked = { meta: { workspaceId }, records: lines }
      return [packed]
    },

    decode,
    toProviderCall,
  })
}

export const mux = createMuxProvider()
