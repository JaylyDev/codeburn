import type { Dirent } from 'fs'
import { existsSync } from 'fs'
import { readdir, readFile, stat } from 'fs/promises'
import { basename, dirname, extname, join } from 'path'
import { homedir } from 'os'

import type { DecodeContext } from '@codeburn/core'
import type {
  KiroCliEntry,
  KiroCliSessionMeta,
  KiroDecodedCall,
  KiroV2SessionMeta,
} from '@codeburn/core/providers/kiro'
import {
  decodeKiroIdeFile,
  decodeKiroCliSession,
  decodeKiroV2Session,
  finishKiroWorkspaceSession,
  kiroToolNameMap,
  prepareKiroWorkspaceSession,
} from '@codeburn/core/providers/kiro'
import { readSessionFile } from '../fs-utils.js'
import type { Provider, SessionSource, SessionParser, ParsedProviderCall } from './types.js'

// Kiro bills in credits: individual plans are $20/mo for 1,000 credits and
// overage is billed at $0.04 per additional credit. We price credits at the
// public overage rate (the marginal price), mirroring the Codebuff provider's
// USD_PER_CREDIT approach, so we never understate real cost.
const USD_PER_KIRO_CREDIT = 0.04

const modelDisplayNames: Record<string, string> = {
  'claude-sonnet-4-6': 'Sonnet 4.6',
  'claude-sonnet-4-5': 'Sonnet 4.5',
  'claude-sonnet-4': 'Sonnet 4',
  'claude-haiku-4-5': 'Haiku 4.5',
  'claude-3-7-sonnet': 'Sonnet 3.7',
  'claude-3-5-sonnet': 'Sonnet 3.5',
  'claude-3-5-haiku': 'Haiku 3.5',
}

const modelDisplayEntries = Object.entries(modelDisplayNames).sort((a, b) => b[0].length - a[0].length)

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

export function toProviderCall(rich: KiroDecodedCall): ParsedProviderCall {
  const base = {
    provider: 'kiro' as const,
    model: rich.model,
    inputTokens: rich.inputTokens,
    outputTokens: rich.outputTokens,
    cacheCreationInputTokens: rich.cacheCreationInputTokens,
    cacheReadInputTokens: rich.cacheReadInputTokens,
    cachedInputTokens: rich.cachedInputTokens,
    reasoningTokens: rich.reasoningTokens,
    webSearchRequests: rich.webSearchRequests,
    ...(rich.credits > 0
      ? { costUSD: rich.credits * USD_PER_KIRO_CREDIT, costBasis: 'measured' as const }
      : { costBasis: 'estimated' as const }),
    costIsEstimated: rich.credits === 0,
    tools: rich.tools,
    bashCommands: rich.bashCommands,
    timestamp: rich.timestamp,
    speed: rich.speed,
    deduplicationKey: rich.deduplicationKey,
    userMessage: rich.userMessage,
    sessionId: rich.sessionId,
  }
  if (rich.arm === 'chat') return { ...base, toolSequence: rich.toolSequence }
  if (rich.arm === 'cli' || rich.arm === 'v2') return { ...base, project: rich.project! }
  return base
}

function createParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
  const context: DecodeContext = { privacyKey: '', providerId: 'kiro', sourceRef: source.path }
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      const path = source.path

      // v2 IDE store: ~/.kiro/sessions/<hash>/sess_<id>/messages.jsonl — a
      // self-contained event log. Must be checked BEFORE the generic .jsonl
      // (CLI) branch, since it also ends in .jsonl but has a different schema.
      if (/[/\\]sess_[^/\\]+[/\\]messages\.jsonl$/.test(path)) {
        const content = await readSessionFile(path)
        if (content === null) return

        // Companion session.json carries the real model + session metadata.
        let meta: KiroV2SessionMeta = {}
        try {
          const raw = await readFile(join(dirname(path), 'session.json'), 'utf-8')
          meta = JSON.parse(raw) as KiroV2SessionMeta
        } catch { /* fall back to defaults below */ }

        const result = decodeKiroV2Session({
          lines: content,
          meta,
          fallbackSessionId: basename(dirname(path)),
          project: source.project,
          context,
          seenKeys,
        })
        for (const call of result.calls) yield toProviderCall(call)
        return
      }

      // CLI session: path points to a .jsonl file
      if (path.endsWith('.jsonl')) {
        const jsonlContent = await readSessionFile(path)
        if (jsonlContent === null) return

        const entries: KiroCliEntry[] = []
        for (const line of jsonlContent.split('\n')) {
          if (!line.trim()) continue
          try { entries.push(JSON.parse(line) as KiroCliEntry) } catch { /* skip malformed lines */ }
        }
        if (entries.length === 0) return

        // Load companion .json for metadata
        const metaPath = path.replace(/\.jsonl$/, '.json')
        let meta: KiroCliSessionMeta
        try {
          const raw = await readFile(metaPath, 'utf-8')
          meta = JSON.parse(raw) as KiroCliSessionMeta
        } catch {
          // Minimal fallback
          meta = { session_id: basename(path, '.jsonl'), cwd: '', created_at: '', updated_at: '' }
        }

        const result = decodeKiroCliSession({
          meta,
          entries,
          project: basename(meta.cwd || ''),
          context,
          seenKeys,
        })
        for (const call of result.calls) yield toProviderCall(call)
        return
      }

      // IDE session: original path
      const content = await readSessionFile(path)
      if (content === null) return

      let data: unknown
      try {
        data = JSON.parse(content)
      } catch {
        return
      }

      const record = asRecord(data)
      if (!record) return

      // Workspace-session files (newer Kiro builds): have history[] with message.role/content
      // and a top-level sessionId/selectedModel/workspaceDirectory.
      const prepared = prepareKiroWorkspaceSession(record)
      if (prepared.kind === 'ready') {
        let timestamp: string
        try {
          const s = await stat(source.path)
          timestamp = new Date(s.mtimeMs).toISOString()
        } catch {
          return
        }
        const result = finishKiroWorkspaceSession(prepared.draft, { timestamp, seenKeys })
        for (const call of result.calls) yield toProviderCall(call)
        return
      }
      if (prepared.kind === 'empty') return

      const result = decodeKiroIdeFile({
        record,
        fallbackChatSessionId: basename(path, '.chat'),
        fallbackExecutionId: basename(path),
        fallbackSessionId: basename(dirname(path)),
        context,
        seenKeys,
      })
      for (const call of result.calls) yield toProviderCall(call)
    },
  }
}

// --- Discovery ---

function getKiroAgentDir(override?: string): string[] {
  if (override) return [override]
  if (process.platform === 'darwin') {
    return [join(homedir(), 'Library', 'Application Support', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent')]
  }
  if (process.platform === 'win32') {
    return [join(homedir(), 'AppData', 'Roaming', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent')]
  }
  // On Linux, scan both ~/.kiro-server/data/... (remote dev boxes) and
  // ~/.config/Kiro/... (local installs). Both can have data simultaneously
  // if the user switches between local and remote, or if .kiro-server exists
  // but is stale while .config/Kiro has current sessions.
  const paths: string[] = []
  const kiroServer = join(homedir(), '.kiro-server', 'data', 'User', 'globalStorage', 'kiro.kiroagent')
  const kiroConfig = join(homedir(), '.config', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent')
  if (existsSync(kiroServer)) paths.push(kiroServer)
  if (existsSync(kiroConfig)) paths.push(kiroConfig)
  // Fallback to config path if neither exists (will just find nothing)
  return paths.length > 0 ? paths : [kiroConfig]
}

function getKiroWorkspaceStorageDir(override?: string): string {
  if (override) return override
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Kiro', 'User', 'workspaceStorage')
  }
  if (process.platform === 'win32') {
    return join(homedir(), 'AppData', 'Roaming', 'Kiro', 'User', 'workspaceStorage')
  }
  return join(homedir(), '.config', 'Kiro', 'User', 'workspaceStorage')
}

async function readWorkspaceProject(workspaceDir: string): Promise<string> {
  try {
    const raw = await readFile(join(workspaceDir, 'workspace.json'), 'utf-8')
    const data = JSON.parse(raw) as { folder?: string }
    if (data.folder) {
      const url = data.folder.replace(/^file:\/\//, '')
      return basename(decodeURIComponent(url))
    }
  } catch {}
  return basename(workspaceDir)
}

async function resolveWorkspaceProject(agentDir: string, workspaceStorageDir: string, workspaceHash: string): Promise<string> {
  const wsDir = join(workspaceStorageDir, workspaceHash)
  const project = await readWorkspaceProject(wsDir)
  if (project !== workspaceHash) return project

  try {
    const sessionsPath = join(agentDir, 'workspace-sessions')
    const dirs = await readdir(sessionsPath)
    for (const dir of dirs) {
      const decoded = Buffer.from(dir.replace(/_$/, ''), 'base64').toString('utf-8')
      if (decoded) return basename(decoded)
    }
  } catch {}

  return workspaceHash
}

async function discoverSessions(agentDir: string, workspaceStorageDir: string, cliSessionsDir: string): Promise<SessionSource[]> {
  const sources: SessionSource[] = []

  // --- Kiro CLI sessions (~/.kiro/sessions/cli/) ---
  try {
    const cliEntries = await readdir(cliSessionsDir, { withFileTypes: true })
    for (const entry of cliEntries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      const jsonlPath = join(cliSessionsDir, entry.name)
      // Derive project from companion .json
      const metaPath = jsonlPath.replace(/\.jsonl$/, '.json')
      let project = 'kiro-cli'
      try {
        const raw = await readFile(metaPath, 'utf-8')
        const meta = JSON.parse(raw) as { cwd?: string }
        if (meta.cwd) project = basename(meta.cwd)
      } catch {}
      sources.push({ path: jsonlPath, project, provider: 'kiro' })
    }
  } catch {}

  // --- Kiro IDE sessions ---
  let workspaceDirs: string[]
  try {
    const entries = await readdir(agentDir, { withFileTypes: true })
    workspaceDirs = entries.filter(e => e.isDirectory() && e.name.length === 32).map(e => e.name)
  } catch {
    return sources
  }

  for (const wsHash of workspaceDirs) {
    const wsPath = join(agentDir, wsHash)
    const project = await resolveWorkspaceProject(agentDir, workspaceStorageDir, wsHash)

    let entries: Dirent[]
    try {
      entries = await readdir(wsPath, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const entryPath = join(wsPath, entry.name)
      if (entry.isFile() && (entry.name.endsWith('.chat') || extname(entry.name) === '')) {
        sources.push({ path: entryPath, project, provider: 'kiro' })
        continue
      }

      if (!entry.isDirectory()) continue

      const childEntries = await readdir(entryPath, { withFileTypes: true }).catch(() => [])
      for (const child of childEntries) {
        if (child.name.startsWith('.')) continue
        if (!child.isFile()) continue
        if (extname(child.name) !== '') continue
        sources.push({ path: join(entryPath, child.name), project, provider: 'kiro' })
      }
    }
  }

  // --- Kiro IDE workspace-sessions (newer builds store session state here) ---
  // These files contain history[].message with user prompts and assistant stubs
  // plus executionId references. They capture sessions not written as per-execution files.
  try {
    const wsSessionsDir = join(agentDir, 'workspace-sessions')
    const wsSessionDirs = await readdir(wsSessionsDir, { withFileTypes: true })
    for (const dir of wsSessionDirs) {
      if (!dir.isDirectory()) continue
      // Directory name is base64-encoded workspace path
      let project = 'kiro-ide'
      try {
        const decoded = Buffer.from(dir.name.replace(/_/g, '='), 'base64').toString('utf-8')
        if (decoded) project = basename(decoded)
      } catch {}
      // Skip bare homedir as project name
      if (project === basename(homedir())) project = 'kiro-ide'

      const sessionFiles = await readdir(join(wsSessionsDir, dir.name), { withFileTypes: true }).catch(() => [])
      for (const sf of sessionFiles) {
        if (!sf.isFile() || !sf.name.endsWith('.json') || sf.name === 'sessions.json') continue
        sources.push({ path: join(wsSessionsDir, dir.name, sf.name), project, provider: 'kiro' })
      }
    }
  } catch {}

  return sources
}

// Discover v2 IDE sessions under ~/.kiro/sessions/<workspaceHash>/sess_*/.
// Each session is a self-contained directory (session.json + messages.jsonl);
// the emitted source points at messages.jsonl and routes to parseV2Session.
async function discoverV2Sessions(sessionsRoot: string): Promise<SessionSource[]> {
  const sources: SessionSource[] = []
  let hashDirs: Dirent[]
  try {
    hashDirs = await readdir(sessionsRoot, { withFileTypes: true })
  } catch {
    return sources
  }

  for (const hd of hashDirs) {
    // Skip the CLI store (scanned separately) and any stray files.
    if (!hd.isDirectory() || hd.name === 'cli') continue
    const hashPath = join(sessionsRoot, hd.name)

    let sessDirs: Dirent[]
    try {
      sessDirs = await readdir(hashPath, { withFileTypes: true })
    } catch {
      continue
    }

    for (const sd of sessDirs) {
      if (!sd.isDirectory() || !sd.name.startsWith('sess_')) continue
      const sessDir = join(hashPath, sd.name)
      const messagesPath = join(sessDir, 'messages.jsonl')
      if (!existsSync(messagesPath)) continue

      // Project from session.json workspacePaths; fall back to a generic label.
      let project = 'kiro-ide'
      try {
        const raw = await readFile(join(sessDir, 'session.json'), 'utf-8')
        const sj = JSON.parse(raw) as { workspacePaths?: string[] }
        const wp = sj.workspacePaths?.[0]
        if (wp) project = basename(wp)
      } catch {}
      if (project === basename(homedir())) project = 'kiro-ide'

      sources.push({ path: messagesPath, project, provider: 'kiro' })
    }
  }

  return sources
}

export function createKiroProvider(agentDirOverride?: string, workspaceStorageDirOverride?: string, cliSessionsDirOverride?: string, v2SessionsRootOverride?: string): Provider {
  const agentDirs = getKiroAgentDir(agentDirOverride)
  const wsDir = getKiroWorkspaceStorageDir(workspaceStorageDirOverride)
  // When overrides are provided (tests), don't scan real CLI sessions unless explicitly given
  const cliDir = cliSessionsDirOverride ?? (agentDirOverride ? join(agentDirOverride, '..', 'cli-sessions') : join(process.env['KIRO_HOME'] || join(homedir(), '.kiro'), 'sessions', 'cli'))
  // v2 IDE sessions live under ~/.kiro/sessions/<hash>/sess_*/, a sibling of the
  // CLI store (.../sessions/cli). Derive the root from cliDir ONLY when cliDir was
  // itself explicit (default path or cliSessionsDirOverride). When only
  // agentDirOverride is set (tests), the derived cliDir parent would point at an
  // arbitrary directory (e.g. the system tmpdir) — scan nothing in that case.
  const v2Root = v2SessionsRootOverride ??
    (cliSessionsDirOverride ? dirname(cliSessionsDirOverride) :
      agentDirOverride ? undefined : dirname(cliDir))

  return {
    name: 'kiro',
    displayName: 'Kiro',

    modelDisplayName(model: string): string {
      if (model === 'kiro-auto') return 'Kiro (auto)'
      for (const [key, name] of modelDisplayEntries) {
        if (model === key || model.startsWith(key + '-')) return name
      }
      return model
    },

    toolDisplayName(rawTool: string): string {
      if (rawTool.startsWith('mcp__')) return rawTool
      return kiroToolNameMap[rawTool] ?? rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      const allSources: SessionSource[] = []
      for (const agentDir of agentDirs) {
        const sources = await discoverSessions(agentDir, wsDir, cliDir)
        allSources.push(...sources)
      }
      // v2 IDE sessions: scan the resolved v2 root (undefined = skip, see above).
      if (v2Root) allSources.push(...await discoverV2Sessions(v2Root))
      // CLI sessions are only scanned once (first agentDir pass includes them);
      // deduplicate by path in case multiple agentDirs share the same CLI dir.
      const seen = new Set<string>()
      return allSources.filter(s => {
        if (seen.has(s.path)) return false
        seen.add(s.path)
        return true
      })
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createParser(source, seenKeys)
    },
  }
}

export const kiro = createKiroProvider()
