import { join } from 'path'
import { homedir } from 'os'

import { decodeWarp } from '@codeburn/core/providers/warp'
import type { WarpBlockRow, WarpConversationRow, WarpDecodedCall, WarpQueryRow } from '@codeburn/core/providers/warp'

import { extractBashCommands } from '../bash-utils.js'
import { getShortModelName } from '../models.js'
import { blobToText, getSqliteLoadError, isSqliteAvailable, openDatabase, type SqliteDatabase } from '../sqlite.js'
import { createBridgedProvider } from './bridge.js'
import type { ParsedProviderCall, Provider, SessionSource } from './types.js'

type RawWarpBlockRow = {
  block_id: string
  start_ts: string | null
  stylized_command: Uint8Array | string | null
}

const WARP_GROUP_CONTAINER = '2BBY89MBSN.dev.warp'
const WARP_STABLE_BUNDLE_ID = 'dev.warp.Warp-Stable'
const WARP_PREVIEW_BUNDLE_ID = 'dev.warp.Warp-Preview'

function sanitizeProject(path: string): string {
  return path.replace(/^\/+/, '').replace(/\//g, '-')
}

function warpDbPath(bundleId: string): string {
  return join(
    homedir(),
    'Library',
    'Group Containers',
    WARP_GROUP_CONTAINER,
    'Library',
    'Application Support',
    bundleId,
    'warp.sqlite',
  )
}

function getDbCandidates(dbPathOverride?: string): string[] {
  if (dbPathOverride) return [dbPathOverride]
  if (process.env['WARP_DB_PATH']) return [process.env['WARP_DB_PATH']]
  return [warpDbPath(WARP_STABLE_BUNDLE_ID), warpDbPath(WARP_PREVIEW_BUNDLE_ID)]
}

function modelDisplayName(model: string): string {
  if (model === 'warp-auto-efficient') return 'Warp Auto (efficient)'
  if (model === 'warp-auto-powerful') return 'Warp Auto (powerful)'
  return getShortModelName(model)
}

function decodeSourcePath(path: string): { dbPath: string; conversationId: string } {
  const splitIndex = path.lastIndexOf(':')
  if (splitIndex <= 0) return { dbPath: path, conversationId: '' }
  return {
    dbPath: path.slice(0, splitIndex),
    conversationId: path.slice(splitIndex + 1),
  }
}

function validateSchema(db: SqliteDatabase): boolean {
  try {
    db.query<{ cnt: number }>('SELECT COUNT(*) as cnt FROM agent_conversations LIMIT 1')
    db.query<{ cnt: number }>('SELECT COUNT(*) as cnt FROM ai_queries LIMIT 1')
    db.query<{ cnt: number }>('SELECT COUNT(*) as cnt FROM blocks LIMIT 1')
    return true
  } catch {
    return false
  }
}

// Map one rich, cost-free decoder call into the host's ParsedProviderCall. Cost
// re-enters here: `costBasis: 'estimated'` marks the call so the parser.ts
// pricing pass fills `costUSD` from the token buckets. Bash base-name
// extraction (and its `strip-ansi` dependency) stays CLI-side: the core decoder
// carries the raw command strings; the host reduces them to base names here.
function toProviderCall(rich: WarpDecodedCall): ParsedProviderCall {
  return {
    provider: 'warp',
    model: rich.model,
    inputTokens: rich.inputTokens,
    outputTokens: rich.outputTokens,
    cacheCreationInputTokens: rich.cacheCreationInputTokens,
    cacheReadInputTokens: rich.cacheReadInputTokens,
    cachedInputTokens: rich.cachedInputTokens,
    reasoningTokens: rich.reasoningTokens,
    webSearchRequests: rich.webSearchRequests,
    costBasis: 'estimated',
    costIsEstimated: true,
    tools: rich.tools,
    bashCommands: [...new Set(rich.rawBashCommands.flatMap(c => extractBashCommands(c)))],
    timestamp: rich.timestamp,
    speed: rich.speed,
    deduplicationKey: rich.deduplicationKey,
    userMessage: rich.userMessage,
    sessionId: rich.sessionId,
    project: rich.project,
    projectPath: rich.projectPath,
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
    if (!validateSchema(db)) return []
    const rows = db.query<{ conversation_id: string; working_directory: string | null }>(
      `SELECT c.conversation_id AS conversation_id,
              (
                SELECT q.working_directory
                FROM ai_queries q
                WHERE q.conversation_id = c.conversation_id
                  AND q.working_directory IS NOT NULL
                  AND q.working_directory <> ''
                ORDER BY q.start_ts DESC
                LIMIT 1
              ) AS working_directory
       FROM agent_conversations c
       WHERE EXISTS (
         SELECT 1 FROM ai_queries q
         WHERE q.conversation_id = c.conversation_id
       )
       ORDER BY c.last_modified_at DESC`,
    )

    return rows.map(row => {
      const projectPath = row.working_directory?.trim() ?? ''
      return {
        path: `${dbPath}:${row.conversation_id}`,
        project: projectPath ? sanitizeProject(projectPath) : 'warp',
        provider: 'warp',
      }
    })
  } catch {
    return []
  } finally {
    db.close()
  }
}

export function createWarpProvider(dbPathOverride?: string): Provider {
  return createBridgedProvider<WarpDecodedCall>({
    name: 'warp',
    displayName: 'Warp',

    modelDisplayName(model: string): string {
      return modelDisplayName(model)
    },

    toolDisplayName(rawTool: string): string {
      return rawTool === 'run_command' ? 'Bash' : rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      if (!isSqliteAvailable()) return []

      const sessions: SessionSource[] = []
      for (const candidate of getDbCandidates(dbPathOverride)) {
        const found = await discoverFromDb(candidate)
        sessions.push(...found)
      }
      return sessions
    },

    // I/O adapter: open the sqlite database host-side, run the conversation +
    // exchange + block queries, textualize command BLOBs, and return the plain
    // row objects for the core decoder.
    async readRecords(source: SessionSource): Promise<unknown[] | null> {
      if (!isSqliteAvailable()) {
        process.stderr.write(getSqliteLoadError() + '\n')
        return null
      }

      const { dbPath, conversationId } = decodeSourcePath(source.path)
      if (!conversationId) return null

      let db: SqliteDatabase
      try {
        db = openDatabase(dbPath)
      } catch (err) {
        process.stderr.write(`codeburn: cannot open Warp database: ${err instanceof Error ? err.message : err}\n`)
        return null
      }

      try {
        if (!validateSchema(db)) return null

        const conversations = db.query<WarpConversationRow>(
          `SELECT conversation_id, conversation_data, last_modified_at
           FROM agent_conversations
           WHERE conversation_id = ?
           LIMIT 1`,
          [conversationId],
        )
        if (conversations.length === 0) return null

        const exchanges = db.query<WarpQueryRow>(
          `SELECT exchange_id, conversation_id, start_ts, input, working_directory, output_status, model_id, planning_model_id, coding_model_id
           FROM ai_queries
           WHERE conversation_id = ?
           ORDER BY start_ts ASC`,
          [conversationId],
        )

        const rawBlocks = db.query<RawWarpBlockRow>(
          `SELECT block_id, start_ts, CAST(stylized_command AS BLOB) AS stylized_command
           FROM blocks
           WHERE ai_metadata IS NOT NULL
             AND ai_metadata <> ''
             AND json_extract(ai_metadata, '$.conversation_id') = ?
           ORDER BY start_ts ASC`,
          [conversationId],
        )

        const blocks: WarpBlockRow[] = rawBlocks.map(block => ({
          block_id: block.block_id,
          start_ts: block.start_ts,
          stylized_command: blobToText(block.stylized_command),
        }))

        return [{ conversationId, conversation: conversations[0]!, exchanges, blocks, sourceProject: source.project }]
      } finally {
        db.close()
      }
    },

    decode: decodeWarp,
    toProviderCall,
  })
}

export const warp = createWarpProvider()
