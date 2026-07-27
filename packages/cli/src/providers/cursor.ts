import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

import { extractBashCommands } from '../bash-utils.js'
import { readCachedResults, writeCachedResults } from '../cursor-cache.js'
import { isSqliteAvailable, isSqliteBusyError, getSqliteLoadError, openDatabase, blobToText, type SqliteDatabase } from '../sqlite.js'
import type { DateRange } from '../types.js'
import type { Provider, SessionSource, SessionParser, ParsedProviderCall } from './types.js'
import type { DecodeContext } from '@codeburn/core'
import { decodeCursor } from '@codeburn/core/providers/cursor'
import type {
  CursorBubbleRow,
  CursorAgentKvRow,
  CursorUserMessageRow,
  CursorComposerMetaRow,
  CursorDecodedCall,
} from '@codeburn/core/providers/cursor'

/** Matches cli-date.ts "all" period cap (6 months). */
const CURSOR_MAX_LOOKBACK_MONTHS = 6

export function getCursorTimeFloor(dateRange?: DateRange): string {
  const now = new Date()
  const maxStart = new Date(
    now.getFullYear(),
    now.getMonth() - CURSOR_MAX_LOOKBACK_MONTHS,
    now.getDate(),
  )
  const start = dateRange?.start ?? maxStart
  const effective = start < maxStart ? maxStart : start
  return effective.toISOString()
}

const CURSOR_COST_MODEL = 'claude-sonnet-4-5'

const modelDisplayNames: Record<string, string> = {
  'claude-4.5-opus-high-thinking': 'Opus 4.5 (Thinking)',
  'claude-4-opus': 'Opus 4',
  'claude-4-sonnet-thinking': 'Sonnet 4 (Thinking)',
  'claude-4.5-sonnet-thinking': 'Sonnet 4.5 (Thinking)',
  'claude-4.6-sonnet': 'Sonnet 4.6',
  'composer-1': 'Composer 1',
  'grok-code-fast-1': 'Grok Code Fast',
  'gemini-3-pro': 'Gemini 3 Pro',
  'gpt-5.2-low': 'GPT-5.2 Low',
  'gpt-5.2': 'GPT-5.2',
  'gpt-5.1-codex-high': 'GPT-5.1 Codex',
  'gpt-5': 'GPT-5',
  'gpt-4.1': 'GPT-4.1',
  'cursor-auto': 'Cursor (auto)',
}

// SQLITE_BUSY must reach parser.ts, whose busy path skips the source without
// caching; swallowing it here would stamp a silently degraded parse into the
// results cache under an unchanged DB fingerprint (Cursor writes via WAL, so
// contention does not change the main file's stat).
function rethrowBusy(err: unknown): void {
  if (isSqliteBusyError(err)) throw err
}

function getCursorDbPath(): string {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb')
  }
  if (process.platform === 'win32') {
    return join(homedir(), 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage', 'state.vscdb')
  }
  return join(homedir(), '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb')
}

function getCursorWorkspaceStorageDir(globalDbPath: string): string {
  // Sibling of globalStorage. Cursor lays out User/{globalStorage,workspaceStorage}/.
  // We derive the workspaceStorage path from the global DB path so a test or
  // override can supply both consistently from one root.
  // globalDbPath = .../User/globalStorage/state.vscdb
  // workspaceStorage = .../User/workspaceStorage
  const userDir = join(globalDbPath, '..', '..')
  return join(userDir, 'workspaceStorage')
}

/// Per-conversation workspace lookup table. Cursor stores each chat as
/// `bubbleId:<composerId>:<bubbleUuid>` rows in the GLOBAL state.vscdb but
/// does NOT carry a workspace path on the bubble itself. The mapping lives
/// in per-workspace dirs at `workspaceStorage/<hash>/`:
///   - `workspace.json` carries the folder URI (`file:///Users/me/proj`)
///   - `state.vscdb`'s `ItemTable['composer.composerData']` lists every
///     composerId opened in that workspace
/// We walk every workspace dir, pull both, and build composerId -> folder.
type WorkspaceMapping = {
  composerToWorkspace: Map<string, string>     // composerId -> folder URI
  workspaceProjectName: Map<string, string>    // folder URI -> sanitized project name
}

const ORPHAN_TAG = '__orphan__'
// Catch-all project label for composers that did not register against any
// workspace. When the user has no workspaces at all this is the only label
// shown, matching the pre-PR `cursor` project so legacy installs are not
// renamed by the breakdown change.
const ORPHAN_PROJECT = 'cursor'

function sanitizeWorkspaceUri(uri: string): string {
  // Mirrors Claude's slug convention so two providers reporting the same
  // project path produce identical project keys for cross-provider rollup.
  // file:///Users/me/myproject → -Users-me-myproject
  // vscode-remote://wsl+Ubuntu/home/me/proj → -wsl-Ubuntu-home-me-proj
  let path: string
  if (uri.startsWith('file://')) {
    path = uri.slice('file://'.length)
  } else {
    // Other URI schemes (vscode-remote://, ssh+remote://, etc.): swap "://"
    // for a leading "/" so the slugifier produces a predictable shape.
    path = uri.replace(/^[^:]+:\/\//, '/').replace(/\+/g, '-')
  }
  try {
    path = decodeURIComponent(path)
  } catch {
    // Malformed percent encoding — keep as-is rather than throw.
  }
  return path.replace(/\/+/g, '-')
}

let workspaceMapCache: WorkspaceMapping | null = null
let workspaceMapCacheRoot: string | null = null

/// Visible for tests so a fixture can rebuild the map after writing fresh
/// workspace directories.
export function clearCursorWorkspaceMapCache(): void {
  workspaceMapCache = null
  workspaceMapCacheRoot = null
}

function loadWorkspaceMap(workspaceStorageDir: string): WorkspaceMapping {
  if (workspaceMapCache && workspaceMapCacheRoot === workspaceStorageDir) {
    return workspaceMapCache
  }
  const result: WorkspaceMapping = {
    composerToWorkspace: new Map(),
    workspaceProjectName: new Map(),
  }

  let entries: string[]
  try {
    entries = readdirSync(workspaceStorageDir)
  } catch {
    workspaceMapCache = result
    workspaceMapCacheRoot = workspaceStorageDir
    return result
  }

  for (const hashDir of entries) {
    const wsJsonPath = join(workspaceStorageDir, hashDir, 'workspace.json')
    const wsDbPath = join(workspaceStorageDir, hashDir, 'state.vscdb')

    let wsJsonRaw: string
    try {
      wsJsonRaw = readFileSync(wsJsonPath, 'utf-8')
    } catch {
      continue
    }

    let folder: string | undefined
    try {
      const parsed = JSON.parse(wsJsonRaw) as { folder?: string }
      folder = parsed.folder
    } catch {
      continue
    }
    if (!folder) continue
    if (!existsSync(wsDbPath)) continue

    let db: SqliteDatabase
    try {
      db = openDatabase(wsDbPath)
    } catch {
      continue
    }
    try {
      // Cursor renamed the per-workspace composer list from
      // 'composer.composerData' to 'composer.composerHeaders' in newer builds
      // (identical { allComposers: [{ composerId }] } shape). Read both keys
      // and merge so the composer -> workspace mapping keeps working across
      // Cursor versions. Without this, on builds that only write
      // 'composer.composerHeaders' every composer falls through to the
      // 'cursor' orphan bucket and per-project attribution is lost.
      const rows = db.query<{ value: string }>(
        "SELECT value FROM ItemTable WHERE key IN ('composer.composerData', 'composer.composerHeaders')",
      )
      if (rows.length === 0) continue
      const project = sanitizeWorkspaceUri(folder)
      let added = 0
      for (const row of rows) {
        let parsed: { allComposers?: Array<{ composerId?: string }> }
        try {
          parsed = JSON.parse(row.value)
        } catch {
          continue
        }
        for (const c of parsed.allComposers ?? []) {
          if (typeof c.composerId === 'string') {
            result.composerToWorkspace.set(c.composerId, folder)
            added += 1
          }
        }
      }
      if (added > 0) {
        result.workspaceProjectName.set(folder, project)
      }
    } catch {
      // best-effort
    } finally {
      db.close()
    }
  }

  workspaceMapCache = result
  workspaceMapCacheRoot = workspaceStorageDir
  return result
}

// Encodes the active workspace into source.path so the parser knows which
// composers to filter for. `#cursor-ws=` is a private separator: `state.vscdb`
// does not contain `#` (we construct the path ourselves), and the literal
// token only appears in source paths emitted from this provider, so there
// is no realistic collision.
const WORKSPACE_SEP = '#cursor-ws='

function encodeSourcePath(dbPath: string, workspaceTag: string): string {
  return `${dbPath}${WORKSPACE_SEP}${workspaceTag}`
}

function decodeSourcePath(sourcePath: string): { dbPath: string; workspaceTag: string } {
  const idx = sourcePath.indexOf(WORKSPACE_SEP)
  // Backwards-compat: a bare DB path with no workspace tag means "give me
  // every call from this DB". Older cached SessionSource entries and any
  // hand-constructed source from a test land here.
  if (idx < 0) return { dbPath: sourcePath, workspaceTag: '__all__' }
  return {
    dbPath: sourcePath.slice(0, idx),
    workspaceTag: sourcePath.slice(idx + WORKSPACE_SEP.length),
  }
}

function resolveModel(raw: string | null): string {
  if (!raw || raw === 'default') return CURSOR_COST_MODEL
  return raw
}

function modelForDisplay(raw: string | null): string {
  if (!raw || raw === 'default') return 'cursor-auto'
  return raw
}

const BUBBLE_QUERY_BASE = `
  SELECT
    key as bubble_key,
    json_extract(value, '$.tokenCount.inputTokens') as input_tokens,
    json_extract(value, '$.tokenCount.outputTokens') as output_tokens,
    json_extract(value, '$.modelInfo.modelName') as model,
    json_extract(value, '$.createdAt') as created_at,
    json_extract(value, '$.requestId') as request_id,
    CAST(substr(json_extract(value, '$.text'), 1, 500) AS BLOB) as user_text,
    length(json_extract(value, '$.text')) as text_length,
    json_extract(value, '$.type') as bubble_type,
    CAST(json_extract(value, '$.codeBlocks') AS BLOB) as code_blocks
  FROM cursorDiskKV
  WHERE key LIKE 'bubbleId:%'
`

const AGENTKV_QUERY = `
  SELECT
    json_extract(value, '$.role') as role,
    CAST(json_extract(value, '$.content') AS BLOB) as content,
    json_extract(value, '$.providerOptions.cursor.requestId') as request_id,
    json_extract(value, '$.providerOptions.cursor.modelName') as model
  FROM cursorDiskKV
  WHERE key LIKE 'agentKv:blob:%'
    AND hex(substr(value, 1, 1)) = '7B'
  ORDER BY ROWID ASC
`

const USER_MESSAGES_QUERY = `
  SELECT
    key as bubble_key,
    json_extract(value, '$.createdAt') as created_at,
    CAST(substr(json_extract(value, '$.text'), 1, 500) AS BLOB) as text
  FROM cursorDiskKV
  WHERE key LIKE 'bubbleId:%'
    AND json_extract(value, '$.type') = 1
    AND (json_extract(value, '$.createdAt') > ? OR json_extract(value, '$.createdAt') IS NULL)
  ORDER BY ROWID ASC
`

// Split into HEAD (predicates we always emit) and TAIL (ORDER BY) so the
// caller can splice in an optional `ROWID >= ?` cutoff without rewriting
// the whole template. The original combined string is preserved as
// BUBBLE_QUERY_SINCE for any caller that doesn't want the cap.
const BUBBLE_QUERY_SINCE_HEAD = BUBBLE_QUERY_BASE + `
    AND json_extract(value, '$.createdAt') IS NOT NULL
    AND json_extract(value, '$.createdAt') > ?`
const BUBBLE_QUERY_SINCE_TAIL = `
  ORDER BY ROWID ASC
`
const BUBBLE_QUERY_SINCE = BUBBLE_QUERY_SINCE_HEAD + BUBBLE_QUERY_SINCE_TAIL

// Paged variant for very large DBs: fetches one ROWID-descending page below a
// cursor. Returns ROWID and createdAt so the caller can stop once it has paged
// past the requested window floor. No date predicate here — the caller filters
// by createdAt in JS so it can see the window boundary.
const BUBBLE_QUERY_PAGE = `
  SELECT
    key as bubble_key,
    ROWID as rid,
    json_extract(value, '$.tokenCount.inputTokens') as input_tokens,
    json_extract(value, '$.tokenCount.outputTokens') as output_tokens,
    json_extract(value, '$.modelInfo.modelName') as model,
    json_extract(value, '$.createdAt') as created_at,
    json_extract(value, '$.requestId') as request_id,
    CAST(substr(json_extract(value, '$.text'), 1, 500) AS BLOB) as user_text,
    length(json_extract(value, '$.text')) as text_length,
    json_extract(value, '$.type') as bubble_type,
    CAST(json_extract(value, '$.codeBlocks') AS BLOB) as code_blocks
  FROM cursorDiskKV
  WHERE key LIKE 'bubbleId:%' AND ROWID < ?
  ORDER BY ROWID DESC
  LIMIT ?
`

// Cursor leaves the per-bubble tokenCount at {0,0} on current builds. The only
// real input figure on disk is the latest context-window snapshot, which Cursor
// records in composerData.promptTokenBreakdown.totalUsedTokens or
// contextTokensUsed (the in-app context meter). This is not cumulative per-turn,
// so local SQLite undercounts admin-console usage; parity requires the opt-in
// Cursor Admin API: POST api.cursor.com/teams/filtered-usage-events.
// The key-range predicate seeks the primary key instead of scanning the table.
const COMPOSER_META_QUERY = `
  SELECT
    substr(key, length('composerData:') + 1) as composer_id,
    json_extract(value, '$.promptTokenBreakdown.totalUsedTokens') as used,
    json_extract(value, '$.contextTokensUsed') as ctx,
    json_extract(value, '$.createdAt') as created_at
  FROM cursorDiskKV
  WHERE key >= 'composerData:' AND key < 'composerData;'
`

function validateSchema(db: SqliteDatabase): boolean {
  try {
    const rows = db.query<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' LIMIT 1"
    )
    return rows.length > 0
  } catch (err) {
    rethrowBusy(err)
    return false
  }
}

/// Scans bubbles for very large DBs by paging ROWID-descending (newest first),
/// keeping only rows within the requested window (createdAt > timeFloor), and
/// stopping once a full page lands below the floor. A `budget` caps the number
/// of in-range bubbles collected so a genuinely enormous in-range scan can't
/// stall; `truncated` is set only when that budget is actually hit, so the
/// caller warns only when older in-range sessions were really dropped.
function scanBubblesPaged(
  db: SqliteDatabase,
  timeFloor: string,
  budget: number,
): { rows: CursorBubbleRow[]; truncated: boolean } {
  const BATCH = 25_000
  const collected: CursorBubbleRow[] = []
  let beforeRowId = Number.MAX_SAFE_INTEGER
  let truncated = false

  paging: while (true) {
    let batch: CursorBubbleRow[]
    try {
      batch = db.query<CursorBubbleRow>(BUBBLE_QUERY_PAGE, [beforeRowId, BATCH])
    } catch (err) {
      rethrowBusy(err)
      break
    }
    if (batch.length === 0) break

    for (const row of batch) {
      if (collected.length >= budget) { truncated = true; break paging }
      if (row.created_at != null && row.created_at > timeFloor) collected.push(row)
    }

    const oldest = batch[batch.length - 1]!
    beforeRowId = oldest.rid ?? 0
    if (beforeRowId <= 0) break
    if (batch.length < BATCH) break // exhausted the table
    // Pages are ROWID-descending (~chronological), so once the oldest row in a
    // full page predates the window, every older page does too.
    if (oldest.created_at != null && oldest.created_at <= timeFloor) break
  }

  // Restore ROWID-ascending order to match the un-paged query's row ordering.
  collected.sort((a, b) => (a.rid ?? 0) - (b.rid ?? 0))
  return { rows: collected, truncated }
}

// Exported so the golden can assert the exact emitted shape directly.
export function toProviderCall(rich: CursorDecodedCall): ParsedProviderCall {
  return {
    provider: 'cursor',
    model: rich.model,
    inputTokens: rich.inputTokens,
    outputTokens: rich.outputTokens,
    cacheCreationInputTokens: rich.cacheCreationInputTokens,
    cacheReadInputTokens: rich.cacheReadInputTokens,
    cachedInputTokens: rich.cachedInputTokens,
    reasoningTokens: rich.reasoningTokens,
    webSearchRequests: rich.webSearchRequests,
    speed: rich.speed,
    // Output is a reply-text estimate and the input meter is the latest
    // context snapshot, not a per-turn sum, so no cursor figure is exact.
    costIsEstimated: true,
    costBasis: 'estimated',
    pricingModel: resolveModel(rich.rawModel),
    tools: rich.tools,
    bashCommands: rich.rawBashCommands.flatMap(c => extractBashCommands(c)),
    timestamp: rich.timestamp,
    deduplicationKey: rich.deduplicationKey,
    userMessage: rich.userMessage,
    sessionId: rich.sessionId,
  }
}

function createParser(
  source: SessionSource,
  seenKeys: Set<string>,
  dateRange?: DateRange,
): SessionParser {
  const timeFloor = getCursorTimeFloor(dateRange)

  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      if (!isSqliteAvailable()) {
        process.stderr.write(getSqliteLoadError() + '\n')
        return
      }

      const { dbPath, workspaceTag } = decodeSourcePath(source.path)

      // Decide which composers belong to this source. The workspace map is
      // built once per process from `workspaceStorage/*` and reused across
      // every workspace-scoped source, so we pay the directory walk cost
      // only once per CLI run regardless of how many projects the user has.
      // `composerFilter` holds the set of composers EITHER allowed (workspace
      // source) or denied (orphan source); `filterMode` says which.
      let composerFilter: Set<string> | null = null
      let filterMode: 'include' | 'exclude' = 'include'
      if (workspaceTag !== '__all__') {
        const wsMap = loadWorkspaceMap(getCursorWorkspaceStorageDir(dbPath))
        if (workspaceTag === ORPHAN_TAG) {
          // Orphan source: every composer that is mapped to SOME workspace
          // is excluded here, so unmapped composers (and any non-UUID
          // sub-composer ids that slip through) land in this bucket.
          composerFilter = new Set(wsMap.composerToWorkspace.keys())
          filterMode = 'exclude'
        } else {
          composerFilter = new Set()
          for (const [composerId, folder] of wsMap.composerToWorkspace) {
            if (folder === workspaceTag) composerFilter.add(composerId)
          }
          filterMode = 'include'
        }
      }

      // Cache is keyed on the bare DB path so multiple workspace-scoped
      // sources reuse one parsed bubble set per CLI run. Filtering happens
      // post-cache so each source emits only its own composers.
      let allCalls: ParsedProviderCall[] | null = null
      const cached = await readCachedResults(dbPath, timeFloor)
      if (cached) {
        allCalls = cached
      } else {
        let db: SqliteDatabase
        try {
          db = openDatabase(dbPath)
        } catch (err) {
          rethrowBusy(err)
          process.stderr.write(`codeburn: cannot open Cursor database: ${err instanceof Error ? err.message : err}\n`)
          return
        }
        try {
          if (!validateSchema(db)) {
            process.stderr.write('codeburn: Cursor storage format not recognized. You may need to update CodeBurn.\n')
            return
          }
          // Use a fresh local Set for intra-parse dedup so the global
          // seenKeys is not mutated by calls that the workspace filter is
          // about to drop. Cross-source dedup happens at yield time.
          const localSeen = new Set<string>()
          // agentKv rows carry no timestamps; sessions found only there get
          // the DB's last-write time.
          let agentKvTimestamp: string
          try {
            agentKvTimestamp = new Date(statSync(dbPath).mtimeMs).toISOString()
          } catch {
            agentKvTimestamp = new Date().toISOString()
          }

          // Query order [1]..[5] is load-bearing for failure semantics.
          // [1]/[4]/[5] degrade to empty; [2] degrades to total=0; [3] early-
          // returns zero calls but still writes the cache.

          // [1] Composer metadata (S2).
          let composerMetaRows: CursorComposerMetaRow[] = []
          try {
            composerMetaRows = db.query<CursorComposerMetaRow>(COMPOSER_META_QUERY)
          } catch (err) {
            rethrowBusy(err)
            /* best-effort: callers fall back to the per-bubble text estimate */
          }

          // [2] Total bubble count for the large-DB paging decision.
          let total = 0
          try {
            const countRows = db.query<{ cnt: number }>(
              "SELECT COUNT(*) as cnt FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'"
            )
            total = countRows[0]?.cnt ?? 0
          } catch (err) {
            rethrowBusy(err)
          }

          // Override the budget in tests via CODEBURN_CURSOR_MAX_BUBBLES.
          const MAX_BUBBLES = Number(process.env['CODEBURN_CURSOR_MAX_BUBBLES']) || 250_000

          // [3] Bubble rows (S1).
          let bubbles: CursorBubbleRow[] = []
          try {
            if (total > MAX_BUBBLES) {
              const scan = scanBubblesPaged(db, timeFloor, MAX_BUBBLES)
              bubbles = scan.rows
              if (scan.truncated) {
                process.stderr.write(
                  `codeburn: Cursor database has ${total.toLocaleString()} bubbles and the ` +
                  `requested range exceeds the ${MAX_BUBBLES.toLocaleString()}-bubble scan budget; ` +
                  `the oldest sessions in range may be missing from this report.\n`
                )
              }
            } else {
              bubbles = db.query<CursorBubbleRow>(BUBBLE_QUERY_SINCE, [timeFloor])
            }
          } catch (err) {
            rethrowBusy(err)
            await writeCachedResults(dbPath, [], timeFloor)
            return
          }

          // [4] Agent stream rows (S3).
          let agentKvRows: CursorAgentKvRow[] = []
          try {
            agentKvRows = db.query<CursorAgentKvRow>(AGENTKV_QUERY)
          } catch (err) {
            rethrowBusy(err)
          }

          // [5] User-message queue rows (S4).
          let userMessageRows: CursorUserMessageRow[] = []
          try {
            userMessageRows = db.query<CursorUserMessageRow>(USER_MESSAGES_QUERY, [timeFloor])
          } catch (err) {
            rethrowBusy(err)
          }

          const { calls, skippedRecords } = decodeCursor({
            bubbles,
            agentKvRows,
            userMessageRows,
            composerMetaRows,
            agentKvTimestamp,
            context: { privacyKey: '', providerId: 'cursor', sourceRef: dbPath },
            seenKeys: localSeen,
          })

          if (skippedRecords > 0) {
            process.stderr.write(`codeburn: skipped ${skippedRecords} unreadable Cursor entries\n`)
          }

          allCalls = calls.map(toProviderCall)
          await writeCachedResults(dbPath, allCalls, timeFloor)
        } finally {
          db.close()
        }
      }

      for (const call of allCalls) {
        if (composerFilter !== null) {
          const inSet = composerFilter.has(call.sessionId)
          if (filterMode === 'include' && !inSet) continue
          if (filterMode === 'exclude' && inSet) continue
        }
        if (seenKeys.has(call.deduplicationKey)) continue
        seenKeys.add(call.deduplicationKey)
        yield call
      }
    },
  }
}

export function createCursorProvider(dbPathOverride?: string): Provider {
  return {
    name: 'cursor',
    displayName: 'Cursor',

    modelDisplayName(model: string): string {
      return modelDisplayNames[model] ?? model
    },

    toolDisplayName(rawTool: string): string {
      return rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      if (!isSqliteAvailable()) return []

      const dbPath = dbPathOverride ?? getCursorDbPath()
      if (!existsSync(dbPath)) return []

      const wsMap = loadWorkspaceMap(getCursorWorkspaceStorageDir(dbPath))
      const sources: SessionSource[] = []
      for (const [folder, project] of wsMap.workspaceProjectName) {
        sources.push({
          path: encodeSourcePath(dbPath, folder),
          project,
          provider: 'cursor',
        })
      }
      // Always emit a catch-all source for composers with no workspace
      // mapping. About a third of composers in real-world Cursor installs
      // are unmapped (multi-root workspaces, "no folder open" sessions,
      // deleted workspaces with surviving global rows). When the user has
      // no workspaces at all this source captures everything and the
      // dashboard looks identical to the pre-PR `cursor` project.
      sources.push({
        path: encodeSourcePath(dbPath, ORPHAN_TAG),
        project: ORPHAN_PROJECT,
        provider: 'cursor',
      })
      return sources
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>, dateRange?: DateRange): SessionParser {
      return createParser(source, seenKeys, dateRange)
    },
  }
}

export const cursor = createCursorProvider()
