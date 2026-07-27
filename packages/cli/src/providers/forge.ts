import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

import { decodeForge } from '@codeburn/core/providers/forge'
import type { ForgeConversationRow, ForgeDecodedCall } from '@codeburn/core/providers/forge'

import { extractBashCommands } from '../bash-utils.js'
import { getSqliteLoadError, isSqliteAvailable, openDatabase, type SqliteDatabase } from '../sqlite.js'
import { createBridgedProvider } from './bridge.js'
import type { ParsedProviderCall, Provider, SessionSource } from './types.js'

type DiscoveryRow = {
  conversation_id: string
  title: string | null
  workspace_id: string
}

const DEFAULT_DB_PATH = join(homedir(), '.forge', '.forge.db')

function validateSchema(db: SqliteDatabase): boolean {
  try {
    db.query('SELECT conversation_id, title, CAST(workspace_id AS TEXT) AS workspace_id, context, created_at, updated_at FROM conversations LIMIT 1')
    return true
  } catch {
    return false
  }
}

function splitSourcePath(path: string): { dbPath: string; conversationId: string } | null {
  const idx = path.lastIndexOf(':')
  if (idx < 0) return null
  return { dbPath: path.slice(0, idx), conversationId: path.slice(idx + 1) }
}

// Map one rich, cost-free decoder call into the host's ParsedProviderCall. Cost
// re-enters here: `costBasis: 'estimated'` marks the call so the parser.ts
// pricing pass fills `costUSD` from the token buckets. Bash base-name
// extraction (and its `strip-ansi` dependency) stays CLI-side: the core
// decoder carries the raw command strings; the host reduces them here.
function toProviderCall(rich: ForgeDecodedCall): ParsedProviderCall {
  return {
    provider: 'forge',
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
    timestamp: rich.timestamp,
    speed: rich.speed,
    deduplicationKey: rich.deduplicationKey,
    userMessage: rich.userMessage,
    sessionId: rich.sessionId,
  }
}

async function discoverFromDb(dbPath: string): Promise<SessionSource[]> {
  if (!existsSync(dbPath)) return []

  let db: SqliteDatabase
  try {
    db = openDatabase(dbPath)
  } catch {
    return []
  }

  try {
    if (!validateSchema(db)) return []
    const rows = db.query<DiscoveryRow>(
      `SELECT conversation_id, title, CAST(workspace_id AS TEXT) AS workspace_id
       FROM conversations
       WHERE context IS NOT NULL`,
    )
    return rows.map(row => ({
      path: `${dbPath}:${row.conversation_id}`,
      project: row.title ?? String(row.workspace_id),
      provider: 'forge',
    }))
  } catch {
    return []
  } finally {
    db.close()
  }
}

export function createForgeProvider(dbPath = DEFAULT_DB_PATH): Provider {
  return createBridgedProvider<ForgeDecodedCall>({
    name: 'forge',
    displayName: 'Forge',

    modelDisplayName(model: string): string {
      return model
    },

    toolDisplayName(rawTool: string): string {
      return rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      if (!isSqliteAvailable()) return []
      return discoverFromDb(dbPath)
    },

    // I/O adapter: open the db and run the conversation-row query (sqlite-side).
    // The `context` JSON blob is handed to the core decoder still serialized;
    // parsing it is decode logic.
    async readRecords(source: SessionSource): Promise<unknown[] | null> {
      if (!isSqliteAvailable()) {
        process.stderr.write(getSqliteLoadError() + '\n')
        return null
      }

      const split = splitSourcePath(source.path)
      if (!split) return null

      let db: SqliteDatabase
      try {
        db = openDatabase(split.dbPath)
      } catch {
        return null
      }

      try {
        if (!validateSchema(db)) return null
        const rows = db.query<ForgeConversationRow>(
          `SELECT conversation_id, title, CAST(workspace_id AS TEXT) AS workspace_id, context, created_at, updated_at
           FROM conversations
           WHERE conversation_id = ?`,
          [split.conversationId],
        )
        if (rows.length === 0) return null
        return [rows[0]!]
      } finally {
        db.close()
      }
    },

    decode: decodeForge,
    toProviderCall,
  })
}

export const forge = createForgeProvider()
