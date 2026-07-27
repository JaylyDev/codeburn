import { join } from 'path'
import { homedir, platform } from 'os'

import { decodeGoose, gooseToolNameMap } from '@codeburn/core/providers/goose'
import type { GooseDecodedCall, GooseMessageRow, GooseSessionRecords, GooseSessionRow } from '@codeburn/core/providers/goose'

import { getShortModelName } from '../models.js'
import { extractBashCommands } from '../bash-utils.js'
import { isSqliteAvailable, getSqliteLoadError, openDatabase, blobToText, type SqliteDatabase } from '../sqlite.js'
import { createBridgedProvider } from './bridge.js'
import type { Provider, SessionSource, ParsedProviderCall } from './types.js'

type RawSessionRow = {
  id: string
  name: string
  working_dir: string | null
  created_at: string | null
  updated_at: string | null
  accumulated_input_tokens: number | null
  accumulated_output_tokens: number | null
  provider_name: string | null
  model_config_json: Uint8Array | string | null
}

function sanitize(dir: string): string {
  return dir.replace(/^\//, '').replace(/\//g, '-')
}

function getDbPath(): string {
  const root = process.env['GOOSE_PATH_ROOT']
  if (root) return join(root, 'data', 'sessions', 'sessions.db')

  const p = platform()
  if (p === 'darwin' || p === 'linux') {
    const base = process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share')
    return join(base, 'goose', 'sessions', 'sessions.db')
  }
  return join(homedir(), 'AppData', 'Roaming', 'Block', 'goose', 'sessions', 'sessions.db')
}

function validateSchema(db: SqliteDatabase): boolean {
  try {
    db.query<{ cnt: number }>("SELECT COUNT(*) as cnt FROM sessions LIMIT 1")
    db.query<{ cnt: number }>("SELECT COUNT(*) as cnt FROM messages LIMIT 1")
    return true
  } catch {
    return false
  }
}

const SESSION_COLUMNS = 'id, name, working_dir, created_at, updated_at, accumulated_input_tokens, accumulated_output_tokens, provider_name, CAST(model_config_json AS BLOB) AS model_config_json'

// Map one rich, cost-free decoder call into the host's ParsedProviderCall. Cost
// re-enters here: `costBasis: 'estimated'` marks the call so the parser.ts
// pricing pass fills `costUSD` from the token buckets. Bash base-name
// extraction (and its `strip-ansi` dependency) stays CLI-side: the core
// decoder carries the raw command strings; the host reduces them here.
function toProviderCall(rich: GooseDecodedCall): ParsedProviderCall {
  return {
    provider: 'goose',
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
    toolSequence: rich.toolSequence,
    // The pre-migration decode fell back to `new Date()` (the current time)
    // when both updated_at/created_at were unparseable. That clock read can't
    // live in the pure core decoder, so decodeGoose emits '' in that case and
    // the fallback is applied here instead.
    timestamp: rich.timestamp || new Date().toISOString(),
    speed: rich.speed,
    deduplicationKey: rich.deduplicationKey,
    userMessage: rich.userMessage,
    sessionId: rich.sessionId,
  }
}

async function discoverFromDb(dbPath: string): Promise<SessionSource[]> {
  let db: SqliteDatabase
  try {
    db = openDatabase(dbPath)
  } catch {
    return []
  }

  try {
    const rows = db.query<RawSessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM sessions ORDER BY updated_at DESC`,
    )

    return rows
      .filter(r => (r.accumulated_input_tokens ?? 0) > 0 || (r.accumulated_output_tokens ?? 0) > 0)
      .map(row => ({
        path: `${dbPath}:${row.id}`,
        project: row.working_dir ? sanitize(row.working_dir) : 'goose',
        provider: 'goose',
      }))
  } catch {
    return []
  } finally {
    db.close()
  }
}

const modelDisplayNames: Record<string, string> = {
  'gpt-5.5': 'GPT-5.5',
  'gpt-5.4': 'GPT-5.4',
  'gpt-5.4-mini': 'GPT-5.4 Mini',
  'gpt-4o': 'GPT-4o',
  'gpt-4o-mini': 'GPT-4o Mini',
}

export function createGooseProvider(): Provider {
  return createBridgedProvider<GooseDecodedCall>({
    name: 'goose',
    displayName: 'Goose',

    modelDisplayName(model: string): string {
      return modelDisplayNames[model] ?? getShortModelName(model)
    },

    toolDisplayName(rawTool: string): string {
      return gooseToolNameMap[rawTool] ?? rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      if (!isSqliteAvailable()) return []
      const dbPath = getDbPath()
      return discoverFromDb(dbPath)
    },

    // I/O adapter: open the db and run the session query, the assistant
    // tool-message query, and the first-user-message query (all sqlite-side),
    // converting each BLOB column to text (the same charset-safe conversion
    // fs-utils performs for file reads). The core decoder gets one composite
    // record bundling all three; JSON parsing and per-message decode are pure
    // and happen there.
    async readRecords(source: SessionSource): Promise<unknown[] | null> {
      if (!isSqliteAvailable()) {
        process.stderr.write(getSqliteLoadError() + '\n')
        return null
      }

      const segments = source.path.split(':')
      const sessionId = segments[segments.length - 1]!
      const dbPath = segments.slice(0, -1).join(':')

      let db: SqliteDatabase
      try {
        db = openDatabase(dbPath)
      } catch (err) {
        process.stderr.write(`codeburn: cannot open Goose database: ${err instanceof Error ? err.message : err}\n`)
        return null
      }

      try {
        if (!validateSchema(db)) return null

        const rows = db.query<RawSessionRow>(
          `SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`,
          [sessionId],
        )
        if (rows.length === 0) return null
        const raw = rows[0]!

        const session: GooseSessionRow = {
          id: raw.id,
          workingDir: raw.working_dir,
          createdAt: raw.created_at,
          updatedAt: raw.updated_at,
          accumulatedInputTokens: raw.accumulated_input_tokens,
          accumulatedOutputTokens: raw.accumulated_output_tokens,
          modelConfigJson: blobToText(raw.model_config_json) || null,
        }

        let assistantToolMessages: GooseMessageRow[] = []
        let firstUserMessage: GooseMessageRow | null = null
        try {
          const toolRows = db.query<{ content_json: Uint8Array | string }>(
            "SELECT CAST(content_json AS BLOB) AS content_json FROM messages WHERE session_id = ? AND role = 'assistant' AND content_json LIKE '%toolRequest%' ORDER BY created_timestamp ASC",
            [sessionId],
          )
          assistantToolMessages = toolRows.map(r => ({ contentJson: blobToText(r.content_json) }))
        } catch {
          // best-effort, matches the pre-migration decode
        }
        try {
          const userRows = db.query<{ content_json: Uint8Array | string }>(
            "SELECT CAST(content_json AS BLOB) AS content_json FROM messages WHERE session_id = ? AND role = 'user' ORDER BY created_timestamp ASC LIMIT 1",
            [sessionId],
          )
          if (userRows.length > 0) firstUserMessage = { contentJson: blobToText(userRows[0]!.content_json) }
        } catch {
          // best-effort, matches the pre-migration decode
        }

        const record: GooseSessionRecords = { sessionId, session, assistantToolMessages, firstUserMessage }
        return [record]
      } finally {
        db.close()
      }
    },

    decode: decodeGoose,
    toProviderCall,
  })
}

export const goose = createGooseProvider()
