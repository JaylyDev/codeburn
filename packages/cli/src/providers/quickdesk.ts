import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'

import { decodeQuickdesk, quickdeskToolNameMap } from '@codeburn/core/providers/quickdesk'
import type {
  QuickdeskDatabaseInput,
  QuickdeskDecodedCall,
  QuickdeskMetricsInput,
  QuickdeskSessionMetadata,
} from '@codeburn/core/providers/quickdesk'

import { blobToText, isSqliteAvailable, openDatabase } from '../sqlite.js'
import type { SqliteDatabase } from '../sqlite.js'
import { createBridgedProvider } from './bridge.js'
import type { ParsedProviderCall, ProbeRoot, Provider, SessionSource } from './types.js'

const METRICS_FILE_RE = /^metrics-(\d{4})-(\d{2})-(\d{2})\.jsonl$/

const modelDisplayNames: Record<string, string> = {
  'claude-sonnet-4-5': 'Sonnet 4.5',
  'claude-sonnet-4-6': 'Sonnet 4.6',
}

type ProfileBase = {
  path: string
  profile: string
}

type SqliteMasterRow = {
  name?: unknown
}

type TableInfoRow = {
  name?: unknown
}

type SessionRow = Record<string, unknown> & {
  id?: unknown
  title?: unknown
  agent_mode?: unknown
  created_at?: unknown
  deleted_at?: unknown
}

type MessageRow = Record<string, unknown> & {
  session_id?: unknown
  role?: unknown
  content?: unknown
  tool_names?: unknown
}

function quickworkHome(): string {
  return resolve(process.env['QUICKWORK_HOME'] || join(homedir(), '.quickwork'))
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function timestampSeconds(value: unknown): number | undefined {
  const number = finiteNumber(value)
  return number !== undefined && number >= 0 ? number : undefined
}

async function resolveProfileBases(): Promise<ProfileBase[]> {
  const root = quickworkHome()
  try {
    const parsed = asRecord(JSON.parse(await readFile(join(root, 'profiles.json'), 'utf8')))
    const entries = parsed?.['entries']
    if (Array.isArray(entries)) {
      const bases: ProfileBase[] = []
      const seenPaths = new Set<string>()
      for (const rawEntry of entries) {
        const entry = asRecord(rawEntry)
        const profile = stringValue(entry?.['id'])
        const dataPath = stringValue(entry?.['data_path'])
        if (!profile || !dataPath) continue
        const basePath = isAbsolute(dataPath) ? resolve(dataPath) : resolve(root, dataPath)
        if (seenPaths.has(basePath)) continue
        seenPaths.add(basePath)
        bases.push({ path: basePath, profile })
      }
      if (bases.length > 0) {
        const legacyDbPath = join(root, 'sessions', 'sessions.db')
        if (!seenPaths.has(root) && await isFile(legacyDbPath)) {
          bases.push({ path: root, profile: 'default' })
        }
        return bases
      }
    }
  } catch {
    // Missing, unreadable, or malformed profiles.json is the legacy root layout.
  }
  return [{ path: root, profile: 'default' }]
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function metricsFiles(basePath: string): Promise<string[]> {
  const metricsDir = join(basePath, 'metrics')
  try {
    const entries = await readdir(metricsDir, { withFileTypes: true })
    return entries
      .filter(entry => entry.isFile() && METRICS_FILE_RE.test(entry.name))
      .map(entry => join(metricsDir, entry.name))
      .sort()
  } catch {
    return []
  }
}

async function discoverSources(): Promise<SessionSource[]> {
  const sources: SessionSource[] = []
  for (const base of await resolveProfileBases()) {
    for (const metricsPath of await metricsFiles(base.path)) {
      sources.push({
        path: metricsPath,
        project: base.profile,
        provider: 'quickdesk',
        sourceId: 'metrics',
        sourcePath: base.path,
      })
    }
    const dbPath = join(base.path, 'sessions', 'sessions.db')
    if (await isFile(dbPath)) {
      sources.push({
        path: dbPath,
        project: base.profile,
        provider: 'quickdesk',
        sourceId: 'sessions-db',
        sourcePath: base.path,
      })
    }
  }
  return sources
}

function tableNames(db: SqliteDatabase): Set<string> {
  const rows = db.query<SqliteMasterRow>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('sessions', 'session_messages')",
  )
  return new Set(rows.map(row => stringValue(row.name)).filter(Boolean))
}

function tableColumns(db: SqliteDatabase, table: 'sessions' | 'session_messages'): Set<string> {
  const rows = db.query<TableInfoRow>(`PRAGMA table_info(${table})`)
  return new Set(rows.map(row => stringValue(row.name)).filter(Boolean))
}

function selectColumn(columns: Set<string>, name: string, fallback = 'NULL'): string {
  return columns.has(name) ? name : `${fallback} AS ${name}`
}

function toolNames(value: unknown): string[] {
  const text = value instanceof Uint8Array ? blobToText(value) : stringValue(value)
  if (!text) return []
  try {
    const parsed: unknown = JSON.parse(text)
    if (Array.isArray(parsed)) {
      return parsed.flatMap(entry => {
        if (typeof entry === 'string') return entry.trim() ? [entry.trim()] : []
        const record = asRecord(entry)
        const name = stringValue(record?.['name']) || stringValue(record?.['tool_name']) || stringValue(record?.['toolName'])
        return name ? [name] : []
      })
    }
  } catch {
    // Older stores may use a comma-separated tool_names value instead of JSON.
  }
  return text.split(',').map(name => name.trim()).filter(Boolean)
}

function uniqueMappedTools(values: string[]): string[] {
  return [...new Set(values.map(value => quickdeskToolNameMap[value] ?? value).filter(Boolean))]
}

function unixSecondsIso(value: number): string | null {
  const date = new Date(value * 1000)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function loadDatabaseSnapshot(basePath: string): { sessions: Map<string, QuickdeskSessionMetadata>; canEstimate: boolean } {
  const empty: { sessions: Map<string, QuickdeskSessionMetadata>; canEstimate: boolean } = { sessions: new Map(), canEstimate: false }
  if (!isSqliteAvailable()) return empty

  let db: SqliteDatabase
  try {
    db = openDatabase(join(basePath, 'sessions', 'sessions.db'))
  } catch {
    return empty
  }

  try {
    const tables = tableNames(db)
    if (!tables.has('sessions')) return empty

    const sessionColumns = tableColumns(db, 'sessions')
    if (!sessionColumns.has('id')) return empty
    const deletionKnown = sessionColumns.has('deleted_at')
    const sessionRows = db.query<SessionRow>(
      `SELECT id,
              ${selectColumn(sessionColumns, 'title')},
              ${selectColumn(sessionColumns, 'agent_mode')},
              ${selectColumn(sessionColumns, 'created_at')},
              ${selectColumn(sessionColumns, 'deleted_at')}
       FROM sessions`,
    )

    const sessions = new Map<string, QuickdeskSessionMetadata>()
    for (const row of sessionRows) {
      const id = stringValue(row.id)
      if (!id) continue
      sessions.set(id, {
        id,
        title: stringValue(row.title),
        agentMode: stringValue(row.agent_mode),
        createdAt: timestampSeconds(row.created_at),
        deleted: deletionKnown && row.deleted_at !== null && row.deleted_at !== undefined,
        firstUserMessage: '',
        inputChars: 0,
        outputChars: 0,
        tools: [],
      })
    }

    if (!tables.has('session_messages')) {
      return { sessions, canEstimate: false }
    }

    const messageColumns = tableColumns(db, 'session_messages')
    if (!messageColumns.has('session_id') || !messageColumns.has('role') || !messageColumns.has('content')) {
      return { sessions, canEstimate: false }
    }

    try {
      const orderBy = messageColumns.has('timestamp') ? 'ORDER BY timestamp ASC' : ''
      const rows = db.query<MessageRow>(
        `SELECT session_id,
                role,
                CAST(content AS BLOB) AS content,
                ${messageColumns.has('tool_names') ? 'CAST(tool_names AS BLOB) AS tool_names' : 'NULL AS tool_names'}
         FROM session_messages
         ${orderBy}`,
      )
      for (const row of rows) {
        const sessionId = stringValue(row.session_id)
        const session = sessions.get(sessionId)
        if (!session) continue
        const role = stringValue(row.role).toLowerCase()
        const content = row.content instanceof Uint8Array ? blobToText(row.content) : stringValue(row.content)
        if (role === 'assistant') session.outputChars += content.length
        else session.inputChars += content.length
        if (role === 'user' && !session.firstUserMessage && content.trim()) {
          session.firstUserMessage = content.trim()
        }
        session.tools.push(...toolNames(row.tool_names))
      }
    } catch {
      return { sessions, canEstimate: false }
    }
    for (const session of sessions.values()) session.tools = uniqueMappedTools(session.tools)

    return { sessions, canEstimate: true }
  } catch {
    return empty
  } finally {
    db.close()
  }
}

async function readMetricsRecords(path: string): Promise<Array<{ record: Record<string, unknown> }>> {
  let contents: string
  try {
    contents = await readFile(path, 'utf8')
  } catch {
    return []
  }

  const records: Array<{ record: Record<string, unknown> }> = []
  const lines = contents.split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trim()
    if (!line) continue
    try {
      const record = asRecord(JSON.parse(line))
      if (record) records.push({ record })
    } catch {
      // A partially-written or malformed JSONL line must not hide later records.
    }
  }
  return records
}

async function metricSessionIds(basePath: string): Promise<Set<string>> {
  const ids = new Set<string>()
  for (const path of await metricsFiles(basePath)) {
    for (const { record } of await readMetricsRecords(path)) {
      const model = stringValue(record['Model'])
      const inputTokens = nonNegativeNumber(record['InputTokens'])
      const outputTokens = nonNegativeNumber(record['OutputTokens'])
      if (!model || inputTokens === undefined || outputTokens === undefined) continue
      const id = stringValue(record['session_id'])
      if (id) ids.add(id)
    }
  }
  return ids
}

async function allMetricSessionIds(): Promise<Set<string>> {
  const ids = new Set<string>()
  for (const base of await resolveProfileBases()) {
    for (const id of await metricSessionIds(base.path)) ids.add(id)
  }
  return ids
}

function basePathFor(source: SessionSource): string {
  if (source.sourcePath) return source.sourcePath
  return resolve(source.path, '..', '..')
}

function nonNegativeNumber(value: unknown): number | undefined {
  const number = finiteNumber(value)
  return number !== undefined && number >= 0 ? number : undefined
}

// Map one rich, cost-free decoder call into the host's ParsedProviderCall. Cost
// re-enters here: a provider-reported dollar figure becomes `costBasis: 'measured'`
// and `costUSD`; otherwise the parser.ts pricing pass estimates from token buckets
// (`costBasis: 'estimated'`).
function toProviderCall(rich: QuickdeskDecodedCall): ParsedProviderCall {
  const measured = rich.recordedCost !== undefined
  return {
    provider: 'quickdesk',
    model: rich.model,
    inputTokens: rich.inputTokens,
    outputTokens: rich.outputTokens,
    cacheCreationInputTokens: rich.cacheCreationInputTokens,
    cacheReadInputTokens: rich.cacheReadInputTokens,
    cachedInputTokens: rich.cachedInputTokens,
    reasoningTokens: rich.reasoningTokens,
    webSearchRequests: rich.webSearchRequests,
    ...(measured
      ? { costUSD: rich.recordedCost, costBasis: 'measured' as const, costIsEstimated: false }
      : { costBasis: 'estimated' as const, costIsEstimated: true }),
    tools: rich.tools,
    bashCommands: rich.rawBashCommands,
    timestamp: rich.timestamp,
    speed: rich.speed,
    deduplicationKey: rich.deduplicationKey,
    userMessage: rich.userMessage,
    sessionId: rich.sessionId,
    project: rich.project,
    projectPath: rich.projectPath,
  }
}

function isDatabaseSource(source: SessionSource): boolean {
  return source.sourceId === 'sessions-db' || basename(source.path) === 'sessions.db'
}

export function createQuickdeskProvider(): Provider {
  return createBridgedProvider<QuickdeskDecodedCall>({
    name: 'quickdesk',
    displayName: 'Quick Desktop',
    durableSources: true,

    modelDisplayName(model: string): string {
      if (model === 'quickdesk-auto') return 'Quick Desktop (auto)'
      return modelDisplayNames[model] ?? model
    },

    toolDisplayName(rawTool: string): string {
      return quickdeskToolNameMap[rawTool] ?? rawTool
    },

    async probeRoots(): Promise<ProbeRoot[]> {
      return (await resolveProfileBases()).map(base => ({ path: base.path, label: base.profile }))
    },

    async discoverSessions(): Promise<SessionSource[]> {
      return discoverSources()
    },

    // I/O adapter: read the discovered source host-side. Metrics files are parsed
    // into JSONL records plus the linked sqlite snapshot; the sessions.db itself is
    // read into plain session metadata rows. The core decoder is pure over these
    // composites.
    async readRecords(source: SessionSource): Promise<unknown[] | null> {
      const basePath = basePathFor(source)
      const project = source.project

      if (isDatabaseSource(source)) {
        const snapshot = loadDatabaseSnapshot(basePath)
        if (!snapshot.canEstimate) return null
        const meteredSessionIds = await allMetricSessionIds()
        const input: QuickdeskDatabaseInput = {
          variant: 'database',
          sessions: [...snapshot.sessions.values()],
          meteredSessionIds,
          project,
          projectPath: basePath,
        }
        return [input]
      }

      const records = await readMetricsRecords(source.path)
      const snapshot = loadDatabaseSnapshot(basePath)
      const input: QuickdeskMetricsInput = {
        variant: 'metrics',
        records,
        sessions: snapshot.sessions,
        project,
        projectPath: basePath,
        fileId: basename(source.path),
      }
      return [input]
    },

    decode: decodeQuickdesk,
    toProviderCall,
  })
}

export const quickdesk = createQuickdeskProvider()
