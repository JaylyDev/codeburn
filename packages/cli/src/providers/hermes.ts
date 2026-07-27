import { readdir, stat } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { homedir } from 'os'

import { decodeHermes, mapToolName } from '@codeburn/core/providers/hermes'
import type { HermesDecodedCall, HermesMessageRow, HermesSessionRow } from '@codeburn/core/providers/hermes'

import { getShortModelName } from '../models.js'
import { isSqliteAvailable, getSqliteLoadError, openDatabase, isSqliteBusyError, type SqliteDatabase } from '../sqlite.js'
import { createBridgedProvider } from './bridge.js'
import type { Provider, SessionSource, ParsedProviderCall } from './types.js'

type ProfileDb = {
  dbPath: string
  profile: string
}

type TableInfoRow = {
  name: string
}

type TableColumn = keyof HermesSessionRow | keyof HermesMessageRow

function getHermesHome(override?: string): string {
  return override ?? process.env['HERMES_HOME'] ?? join(homedir(), '.hermes')
}

function sanitizeProject(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return 'hermes'
  return trimmed.replace(/^[/\\]+/, '').replace(/[:/\\]/g, '-')
}

function parseProfileName(dbPath: string, hermesHome: string): string {
  const profilesDir = join(hermesHome, 'profiles')
  const dir = dirname(dbPath)
  if (dirname(dir) === profilesDir) return basename(dir)
  return 'default'
}

async function findStateDbs(hermesHome: string): Promise<ProfileDb[]> {
  const dbs: ProfileDb[] = []
  const rootDb = join(hermesHome, 'state.db')
  const rootStat = await stat(rootDb).catch(() => null)
  if (rootStat?.isFile()) dbs.push({ dbPath: rootDb, profile: 'default' })

  const profilesDir = join(hermesHome, 'profiles')
  const profiles = await readdir(profilesDir, { withFileTypes: true }).catch(() => [])
  for (const entry of profiles) {
    if (!entry.isDirectory()) continue
    const dbPath = join(profilesDir, entry.name, 'state.db')
    const s = await stat(dbPath).catch(() => null)
    if (s?.isFile()) dbs.push({ dbPath, profile: entry.name })
  }
  return dbs
}

function encodeSourcePath(dbPath: string, sessionId: string): string {
  return `${dbPath}#hermes-session=${encodeURIComponent(sessionId)}`
}

function decodeSourcePath(path: string): { dbPath: string; sessionId: string } | null {
  const marker = '#hermes-session='
  const idx = path.lastIndexOf(marker)
  if (idx === -1) return null
  return {
    dbPath: path.slice(0, idx),
    sessionId: decodeURIComponent(path.slice(idx + marker.length)),
  }
}

function validateSchema(db: SqliteDatabase): boolean {
  try {
    db.query('SELECT session_id, role, content, tool_calls FROM messages LIMIT 1')
    const columns = getSessionColumns(db)
    return columns.has('id') && columns.has('input_tokens') && columns.has('output_tokens')
  } catch (err) {
    if (isSqliteBusyError(err)) throw err
    return false
  }
}

function getSessionColumns(db: SqliteDatabase): Set<string> {
  return new Set(db.query<TableInfoRow>('PRAGMA table_info(sessions)').map(row => row.name))
}

function getMessageColumns(db: SqliteDatabase): Set<string> {
  return new Set(db.query<TableInfoRow>('PRAGMA table_info(messages)').map(row => row.name))
}

function numberColumn(columns: Set<string>, name: TableColumn): string {
  return columns.has(name) ? `coalesce(${name}, 0) AS ${name}` : `0 AS ${name}`
}

function nullableColumn(columns: Set<string>, name: TableColumn): string {
  return columns.has(name) ? name : `NULL AS ${name}`
}

function usageExpression(columns: Set<string>): string {
  const usageColumns: Array<keyof HermesSessionRow> = [
    'input_tokens',
    'output_tokens',
    'cache_read_tokens',
    'cache_write_tokens',
    'reasoning_tokens',
  ]
  const parts = usageColumns
    .filter(name => columns.has(name))
    .map(name => `coalesce(${name}, 0)`)
  return parts.length > 0 ? parts.join(' + ') : '0'
}

async function discoverFromDb(dbPath: string, profile: string): Promise<SessionSource[]> {
  let db: SqliteDatabase
  try {
    db = openDatabase(dbPath)
  } catch {
    return []
  }

  try {
    if (!validateSchema(db)) return []
    const columns = getSessionColumns(db)
    const usage = usageExpression(columns)
    const orderBy = columns.has('started_at') ? 'started_at DESC' : 'id DESC'
    const rows = db.query<HermesSessionRow>(
      `SELECT id,
              ${nullableColumn(columns, 'title')},
              ${numberColumn(columns, 'input_tokens')},
              ${numberColumn(columns, 'output_tokens')},
              ${numberColumn(columns, 'cache_read_tokens')},
              ${numberColumn(columns, 'cache_write_tokens')},
              ${numberColumn(columns, 'reasoning_tokens')}
       FROM sessions
       WHERE ${usage} > 0
       ORDER BY ${orderBy}
       LIMIT 10000`,
    )

    return rows.map(row => ({
      path: encodeSourcePath(dbPath, row.id),
      project: sanitizeProject(profile),
      provider: 'hermes',
    }))
  } catch (err) {
    if (isSqliteBusyError(err)) throw err
    process.stderr.write(`codeburn: error querying Hermes database: ${err instanceof Error ? err.message : err}\n`)
    return []
  } finally {
    db.close()
  }
}

// Map one rich, cost-free decoder call into the host's ParsedProviderCall. Cost
// re-enters here: a provider-recorded dollar figure becomes `costBasis: 'measured'`
// and `costUSD`; otherwise the parser.ts pricing pass estimates from token
// buckets (`costBasis: 'estimated'`). Bash base-name extraction (and its
// `strip-ansi` dependency) stays CLI-side: the core decoder carries the raw
// command strings; the host reduces them to base names here.
function toProviderCall(rich: HermesDecodedCall): ParsedProviderCall {
  const measured = rich.recordedCost !== undefined
  return {
    provider: 'hermes',
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
    turnId: rich.turnId,
    toolSequence: rich.toolSequence,
    userMessage: rich.userMessage,
    sessionId: rich.sessionId,
    project: rich.project,
    projectPath: rich.projectPath,
  }
}

export function createHermesProvider(hermesHomeOverride?: string): Provider {
  const hermesHome = getHermesHome(hermesHomeOverride)

  return createBridgedProvider<HermesDecodedCall>({
    name: 'hermes',
    displayName: 'Hermes Agent',

    modelDisplayName(model: string): string {
      return getShortModelName(model)
    },

    toolDisplayName(rawTool: string): string {
      return mapToolName(rawTool)
    },

    async discoverSessions(): Promise<SessionSource[]> {
      if (!isSqliteAvailable()) return []
      const dbs = await findStateDbs(hermesHome)
      const sessions: SessionSource[] = []
      for (const { dbPath, profile } of dbs) {
        sessions.push(...await discoverFromDb(dbPath, profile))
      }
      return sessions
    },

    // I/O adapter: open the sqlite database host-side, run the session + message
    // queries, and return the plain row objects for the core decoder.
    async readRecords(source: SessionSource): Promise<unknown[] | null> {
      if (!isSqliteAvailable()) {
        process.stderr.write(getSqliteLoadError() + '\n')
        return null
      }

      const decoded = decodeSourcePath(source.path)
      if (!decoded) return null
      const profile = parseProfileName(decoded.dbPath, hermesHome)

      let db: SqliteDatabase
      try {
        db = openDatabase(decoded.dbPath)
      } catch (err) {
        process.stderr.write(`codeburn: cannot open Hermes database: ${err instanceof Error ? err.message : err}\n`)
        return null
      }

      try {
        if (!validateSchema(db)) return null
        const columns = getSessionColumns(db)
        const rows = db.query<HermesSessionRow>(
          `SELECT id,
                  ${nullableColumn(columns, 'source')},
                  ${nullableColumn(columns, 'model')},
                  ${nullableColumn(columns, 'cwd')},
                  ${nullableColumn(columns, 'billing_provider')},
                  ${numberColumn(columns, 'input_tokens')},
                  ${numberColumn(columns, 'output_tokens')},
                  ${numberColumn(columns, 'cache_read_tokens')},
                  ${numberColumn(columns, 'cache_write_tokens')},
                  ${numberColumn(columns, 'reasoning_tokens')},
                  ${nullableColumn(columns, 'estimated_cost_usd')},
                  ${nullableColumn(columns, 'actual_cost_usd')},
                  ${numberColumn(columns, 'api_call_count')},
                  ${numberColumn(columns, 'tool_call_count')},
                  ${nullableColumn(columns, 'started_at')},
                  ${nullableColumn(columns, 'ended_at')},
                  ${nullableColumn(columns, 'title')}
           FROM sessions
           WHERE id = ?`,
          [decoded.sessionId],
        )
        const row = rows[0]
        if (!row) return null

        const messageColumns = getMessageColumns(db)
        const orderColumns = ['timestamp', 'id'].filter(name => messageColumns.has(name))
        const orderBy = orderColumns.length > 0 ? `ORDER BY ${orderColumns.join(' ASC, ')} ASC` : ''
        const messages = db.query<HermesMessageRow>(
          `SELECT ${numberColumn(messageColumns, 'id')},
                  role,
                  content,
                  tool_calls,
                  ${nullableColumn(messageColumns, 'tool_name')},
                  ${nullableColumn(messageColumns, 'timestamp')}
           FROM messages
           WHERE session_id = ?
           ${orderBy}`,
          [decoded.sessionId],
        )

        return [{ session: row, messages, profile }]
      } catch (err) {
        // A transient lock on the live state.db must propagate so the caller
        // retries, not get swallowed into an empty (negatively cached) result.
        if (isSqliteBusyError(err)) throw err
        process.stderr.write(`codeburn: error querying Hermes database: ${err instanceof Error ? err.message : err}\n`)
        return null
      } finally {
        db.close()
      }
    },

    decode: decodeHermes,
    toProviderCall,
  })
}

export const hermes = createHermesProvider()
