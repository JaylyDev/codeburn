import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import zlib from 'zlib'

import { decodeZed } from '@codeburn/core/providers/zed'
import type { ZedDecodedCall, ZedThreadRow } from '@codeburn/core/providers/zed'

import { getSqliteLoadError, isSqliteAvailable, openDatabase, type SqliteDatabase } from '../sqlite.js'
import { createBridgedProvider } from './bridge.js'
import type { ParsedProviderCall, Provider, SessionSource } from './types.js'

// Zed's built-in agent stores one row per thread in a single SQLite database;
// the `data` blob is zstd-compressed JSON carrying `request_token_usage`
// (per-request Anthropic-shaped token counts) and the thread's model. The
// sqlite driver and SQL query stay CLI-side; decompression, JSON parsing, and
// per-request token accounting moved to @codeburn/core/providers/zed. Format
// documented in issue #480.

// zstd landed in node:zlib in 22.15 / 23.8; the package floor is 22.13, so the
// provider degrades with a notice instead of assuming the export exists. This
// Node-version capability check is host-side by nature and stays here — the
// core decoder is only ever called once this has confirmed support exists.
const zstdDecompress = (zlib as { zstdDecompressSync?: (buf: Buffer) => Buffer }).zstdDecompressSync

function getZedThreadsDbPath(): string {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Zed', 'threads', 'threads.db')
  }
  if (process.platform === 'win32') {
    return join(homedir(), 'AppData', 'Local', 'Zed', 'threads', 'threads.db')
  }
  return join(homedir(), '.local', 'share', 'zed', 'threads', 'threads.db')
}

const THREADS_QUERY = `
  SELECT id, summary, updated_at, data_type, data
  FROM threads
  ORDER BY updated_at ASC
`

// Map one rich, cost-free decoder call into the host's ParsedProviderCall. Cost
// re-enters here: `costBasis: 'estimated'` marks the call so the parser.ts
// pricing pass fills `costUSD` from the token buckets. Zed never captures tool
// calls, so `bashCommands` is always empty (no extractBashCommands needed).
function toProviderCall(rich: ZedDecodedCall): ParsedProviderCall {
  return {
    provider: 'zed',
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
    userMessage: rich.userMessage,
    sessionId: rich.sessionId,
  }
}

export function createZedProvider(dbPathOverride?: string): Provider {
  return createBridgedProvider<ZedDecodedCall>({
    name: 'zed',
    displayName: 'Zed',

    modelDisplayName(model: string): string {
      return model
    },

    toolDisplayName(rawTool: string): string {
      return rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      if (!isSqliteAvailable()) return []
      const dbPath = dbPathOverride ?? getZedThreadsDbPath()
      if (!existsSync(dbPath)) return []
      return [{ path: dbPath, project: 'zed', provider: 'zed' }]
    },

    // I/O adapter: open the db and run the threads query (sqlite-side). Rows
    // (blob and all) are handed straight to the core decoder, which does the
    // zstd decompression and JSON parsing now that Node-version support for it
    // is confirmed.
    async readRecords(source: SessionSource): Promise<unknown[] | null> {
      if (!isSqliteAvailable()) {
        process.stderr.write(getSqliteLoadError() + '\n')
        return null
      }
      if (!zstdDecompress) {
        process.stderr.write('codeburn: Zed threads need Node >= 22.15 (zstd support); skipping Zed usage.\n')
        return null
      }

      let db: SqliteDatabase
      try {
        db = openDatabase(source.path)
      } catch (err) {
        process.stderr.write(`codeburn: cannot open Zed database: ${err instanceof Error ? err.message : err}\n`)
        return null
      }
      try {
        return db.query<ZedThreadRow>(THREADS_QUERY)
      } catch {
        return []
      } finally {
        db.close()
      }
    },

    // The core decoder reports unreadable/unknown-shape threads as record
    // diagnostics, which the bridge discards. The pre-migration decode printed
    // one aggregate stderr line per scan for exactly those rows, so that notice
    // is re-emitted here rather than silently dropped.
    decode(input) {
      const { calls, diagnostics } = decodeZed(input)
      if (diagnostics.length > 0) {
        process.stderr.write(`codeburn: skipped ${diagnostics.length} unreadable Zed threads\n`)
      }
      return { calls }
    },
    toProviderCall,
  })
}

export const zed = createZedProvider()
