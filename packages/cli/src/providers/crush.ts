import { readFile } from 'fs/promises'
import { join, resolve } from 'path'
import { homedir, platform } from 'os'

import { decodeCrush } from '@codeburn/core/providers/crush'
import type { CrushDecodedCall, CrushRawRecord } from '@codeburn/core/providers/crush'

import { isSqliteAvailable, getSqliteLoadError, openDatabase, type SqliteDatabase } from '../sqlite.js'
import { createBridgedProvider } from './bridge.js'
import type { Provider, SessionSource, ParsedProviderCall } from './types.js'

/// Crush stores per-project SQLite databases discovered through a JSON registry.
/// We only read both. Schema source: charmbracelet/crush
/// internal/db/migrations/20250424200609_initial.sql, verified against v0.66.1.
/// The schema *comments* in that file claim millisecond timestamps, but every
/// INSERT/UPDATE in internal/db/sql/{sessions,messages}.sql uses
/// strftime('%s', 'now') which returns Unix seconds. We treat values as seconds.

type ProjectEntry = {
  path: string
  data_dir: string
}

type SessionRow = {
  id: string
  prompt_tokens: number | null
  completion_tokens: number | null
  cost: number | null
  created_at: number | null
  updated_at: number | null
  message_count: number | null
}

function getRegistryPath(): string {
  const explicit = process.env['CRUSH_GLOBAL_DATA']
  if (explicit) return join(explicit, 'projects.json')

  if (platform() === 'win32') {
    const localAppData = process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local')
    return join(localAppData, 'crush', 'projects.json')
  }

  const xdg = process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share')
  return join(xdg, 'crush', 'projects.json')
}

async function loadRegistry(path: string): Promise<ProjectEntry[]> {
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  // Crush writes projects.json as an object keyed by project id. Older builds
  // (and tokscale's sample fixtures) emit an array. Accept both shapes.
  let entries: unknown[]
  if (Array.isArray(parsed)) {
    entries = parsed
  } else if (parsed && typeof parsed === 'object') {
    entries = Object.values(parsed)
  } else {
    return []
  }
  const out: ProjectEntry[] = []
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue
    const obj = e as Record<string, unknown>
    if (typeof obj['path'] !== 'string' || typeof obj['data_dir'] !== 'string') continue
    out.push({ path: obj['path'], data_dir: obj['data_dir'] })
  }
  return out
}

function resolveDbPath(entry: ProjectEntry): string {
  // data_dir defaults to ".crush" relative to the project path. Absolute paths
  // are honored if a user has overridden the layout.
  return join(resolve(entry.path, entry.data_dir), 'crush.db')
}

function sanitizeProject(path: string): string {
  return path.replace(/^\//, '').replace(/\//g, '-')
}

function validateSchema(db: SqliteDatabase): boolean {
  try {
    db.query<{ cnt: number }>('SELECT COUNT(*) as cnt FROM sessions LIMIT 1')
    db.query<{ cnt: number }>('SELECT COUNT(*) as cnt FROM messages LIMIT 1')
    return true
  } catch {
    return false
  }
}

function dominantModel(db: SqliteDatabase, sessionId: string): string {
  try {
    const rows = db.query<{ model: string | null }>(
      `SELECT model FROM messages
       WHERE session_id = ? AND model IS NOT NULL AND model <> ''
       GROUP BY model
       ORDER BY COUNT(*) DESC
       LIMIT 1`,
      [sessionId],
    )
    if (rows.length === 0) return 'unknown'
    return rows[0]!.model ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

// Map one rich, cost-free-or-measured decoder call into the host's
// ParsedProviderCall. Crush already stores cost in dollars, so a row with
// `measuredCostUSD` maps to `costBasis: 'measured'` (the pricing pass leaves it
// untouched); otherwise the row falls back to token-based estimation. Crush
// never captures a user message, so it is hardcoded empty here rather than
// carried through the rich decode.
function toProviderCall(rich: CrushDecodedCall): ParsedProviderCall {
  const measured = rich.measuredCostUSD !== undefined
  return {
    provider: 'crush',
    model: rich.model,
    inputTokens: rich.inputTokens,
    outputTokens: rich.outputTokens,
    cacheCreationInputTokens: rich.cacheCreationInputTokens,
    cacheReadInputTokens: rich.cacheReadInputTokens,
    cachedInputTokens: rich.cachedInputTokens,
    reasoningTokens: rich.reasoningTokens,
    webSearchRequests: rich.webSearchRequests,
    ...(measured
      ? { costUSD: rich.measuredCostUSD, costBasis: 'measured' as const }
      : { costBasis: 'estimated' as const }),
    tools: rich.tools,
    bashCommands: [],
    timestamp: rich.timestamp,
    speed: rich.speed,
    deduplicationKey: rich.deduplicationKey,
    userMessage: '',
    sessionId: rich.sessionId,
  }
}

async function discoverFromDb(dbPath: string, project: string): Promise<SessionSource[]> {
  let db: SqliteDatabase
  try {
    db = openDatabase(dbPath)
  } catch {
    return []
  }
  try {
    if (!validateSchema(db)) return []
    const rows = db.query<{ id: string }>(
      `SELECT id FROM sessions
       WHERE parent_session_id IS NULL
         AND (cost > 0 OR prompt_tokens > 0 OR completion_tokens > 0)
       ORDER BY created_at DESC`,
    )
    return rows.map(row => ({
      path: `${dbPath}:${row.id}`,
      project,
      provider: 'crush',
    }))
  } catch {
    return []
  } finally {
    db.close()
  }
}

export function createCrushProvider(): Provider {
  return createBridgedProvider<CrushDecodedCall>({
    name: 'crush',
    displayName: 'Crush',

    modelDisplayName(model: string): string {
      return model
    },

    toolDisplayName(rawTool: string): string {
      return rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      if (!isSqliteAvailable()) return []
      const registry = await loadRegistry(getRegistryPath())
      const sources: SessionSource[] = []
      for (const entry of registry) {
        const dbPath = resolveDbPath(entry)
        const project = sanitizeProject(entry.path)
        const found = await discoverFromDb(dbPath, project)
        sources.push(...found)
      }
      return sources
    },

    // I/O adapter: open the db, run the session-row query and the dominant-model
    // query (both sqlite-side), and hand the core decoder one combined record.
    async readRecords(source: SessionSource): Promise<unknown[] | null> {
      if (!isSqliteAvailable()) {
        process.stderr.write(getSqliteLoadError() + '\n')
        return null
      }

      // Source paths are encoded as `<dbPath>:<sessionId>`. Split from the
      // right because dbPath may contain a colon on Windows (drive letter).
      const segments = source.path.split(':')
      const sessionId = segments[segments.length - 1]!
      const dbPath = segments.slice(0, -1).join(':')

      let db: SqliteDatabase
      try {
        db = openDatabase(dbPath)
      } catch (err) {
        process.stderr.write(
          `codeburn: cannot open Crush database: ${err instanceof Error ? err.message : err}\n`,
        )
        return null
      }

      try {
        if (!validateSchema(db)) return null

        const rows = db.query<SessionRow>(
          `SELECT id, prompt_tokens, completion_tokens, cost, created_at, updated_at, message_count
           FROM sessions
           WHERE id = ? AND parent_session_id IS NULL`,
          [sessionId],
        )
        if (rows.length === 0) return null
        const session = rows[0]!

        const model = dominantModel(db, sessionId)
        const record: CrushRawRecord = { ...session, model }
        return [record]
      } finally {
        db.close()
      }
    },

    decode: decodeCrush,
    toProviderCall,
  })
}

export const crush = createCrushProvider()
