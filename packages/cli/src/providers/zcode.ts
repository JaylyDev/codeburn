import { join } from 'path'
import { homedir } from 'os'

import { decodeZcode } from '@codeburn/core/providers/zcode'
import type { ZcodeDecodedCall, ZcodeSessionRecords, ZcodeToolRow, ZcodeUsageRow } from '@codeburn/core/providers/zcode'

import { isSqliteAvailable, getSqliteLoadError, openDatabase, type SqliteDatabase } from '../sqlite.js'
import { createBridgedProvider } from './bridge.js'
import type { Provider, SessionSource, ParsedProviderCall } from './types.js'

/// ZCode (CLI v0.14.x) records usage in a single SQLite database at
/// ~/.zcode/cli/db/db.sqlite. We read it because the other on-disk sources are
/// unusable for billing: the JSONL activity log redacts token counts, and no
/// source stores a dollar cost (GLM-5.2 runs on z.ai's start-plan subscription).
/// Tokens are exact; cost is computed from the pricing table. Schema verified
/// against db v0.14.8 on 2026-06-20.

type SessionRow = {
  id: string
  directory: string
}

function getDbPath(override?: string): string {
  return override ?? join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite')
}

function sanitizeProject(path: string): string {
  return path.replace(/^\//, '').replace(/\//g, '-')
}

function validateSchema(db: SqliteDatabase): boolean {
  try {
    db.query<{ cnt: number }>('SELECT COUNT(*) as cnt FROM model_usage LIMIT 1')
    db.query<{ cnt: number }>('SELECT COUNT(*) as cnt FROM session LIMIT 1')
    return true
  } catch {
    return false
  }
}

function discover(dbPath: string): SessionSource[] {
  let db: SqliteDatabase
  try {
    db = openDatabase(dbPath)
  } catch {
    return []
  }
  try {
    if (!validateSchema(db)) return []
    const rows = db.query<SessionRow>(
      `SELECT DISTINCT s.id as id, s.directory as directory
       FROM session s
       JOIN model_usage m ON m.session_id = s.id
       WHERE m.input_tokens > 0 OR m.output_tokens > 0 OR m.reasoning_tokens > 0
          OR m.cache_read_input_tokens > 0 OR m.cache_creation_input_tokens > 0`,
    )
    return rows.map(row => ({
      path: `${dbPath}:${row.id}`,
      project: sanitizeProject(row.directory),
      provider: 'zcode',
    }))
  } catch {
    return []
  } finally {
    db.close()
  }
}

// Map one rich, cost-free decoder call into the host's ParsedProviderCall. Cost
// re-enters here: `costBasis: 'estimated'` marks the call so the parser.ts
// pricing pass fills `costUSD` from the token buckets. ZCode never captures a
// user message, so it is hardcoded empty here rather than carried through the
// rich decode.
function toProviderCall(rich: ZcodeDecodedCall): ParsedProviderCall {
  return {
    provider: 'zcode',
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
    bashCommands: [],
    timestamp: rich.timestamp,
    speed: rich.speed,
    deduplicationKey: rich.deduplicationKey,
    turnId: rich.turnId,
    userMessage: '',
    sessionId: rich.sessionId,
  }
}

export function createZcodeProvider(dbPathOverride?: string): Provider {
  const dbPath = getDbPath(dbPathOverride)
  return createBridgedProvider<ZcodeDecodedCall>({
    name: 'zcode',
    displayName: 'ZCode',

    modelDisplayName(model: string): string {
      return model
    },

    toolDisplayName(rawTool: string): string {
      return rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      if (!isSqliteAvailable()) return []
      return discover(dbPath)
    },

    // I/O adapter: open the db, run the model_usage and tool_usage queries for
    // this session (both sqlite-side), and hand the core decoder one combined
    // record bundling both row sets.
    async readRecords(source: SessionSource): Promise<unknown[] | null> {
      if (!isSqliteAvailable()) {
        process.stderr.write(getSqliteLoadError() + '\n')
        return null
      }

      // Source paths are `<dbPath>:<sessionId>`. Split from the right so a colon
      // in the path (Windows drive letter) doesn't corrupt the session id.
      const segments = source.path.split(':')
      const sessionId = segments[segments.length - 1]!
      const readDbPath = segments.slice(0, -1).join(':')

      let db: SqliteDatabase
      try {
        db = openDatabase(readDbPath)
      } catch (err) {
        process.stderr.write(
          `codeburn: cannot open ZCode database: ${err instanceof Error ? err.message : err}\n`,
        )
        return null
      }

      try {
        if (!validateSchema(db)) return null

        // model_usage rows don't link to individual tool calls, only to a turn,
        // so collect each turn's tools and attach them to one request per turn
        // (in the decoder) to avoid double-counting across a turn's multiple
        // requests.
        const toolRows = db.query<ZcodeToolRow>(
          `SELECT turn_id, tool_name FROM tool_usage
           WHERE session_id = ? AND turn_id IS NOT NULL
           ORDER BY started_at ASC`,
          [sessionId],
        )

        const usageRows = db.query<ZcodeUsageRow>(
          `SELECT id, turn_id, model_id, input_tokens, output_tokens, reasoning_tokens,
                  cache_creation_input_tokens, cache_read_input_tokens, started_at, completed_at
           FROM model_usage WHERE session_id = ?
           ORDER BY started_at ASC`,
          [sessionId],
        )

        const record: ZcodeSessionRecords = { sessionId, usageRows, toolRows }
        return [record]
      } finally {
        db.close()
      }
    },

    decode: decodeZcode,
    toProviderCall,
  })
}

export const zcode = createZcodeProvider()
