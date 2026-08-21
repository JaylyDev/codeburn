// =============================================================================
// copilot.ts — Modified CodeBurn Copilot provider
// =============================================================================
//
// WHAT CHANGED:
//   The original provider only reads Copilot's JSONL session-state files from
//   ~/.copilot/session-state/, which only log output tokens. Input tokens,
//   cache-read tokens, and cache-creation tokens are never written there, so
//   CodeBurn underreports Copilot costs by 60-80%.
//
//   This modified version adds VS Code sources that can carry fuller token
//   data: the OTel SQLite store (agent-traces.db), VS Code core chatSessions
//   journals, and legacy extension transcripts. OTel and chatSessions contain
//   input/output token breakdowns for Copilot Chat users; legacy JSONL remains
//   a fallback when richer sources are absent.
//
// HOW TO ENABLE THE OTEL SQLITE STORE:
//   TWO settings must both be enabled in VS Code settings.json:
//
//     {
//       "github.copilot.chat.otel.enabled": true,
//       "github.copilot.chat.otel.dbSpanExporter.enabled": true
//     }
//
//   The first enables the OTel pipeline; the second (defaults to false) enables
//   the SQLite span exporter that actually writes agent-traces.db.
//   After changing these settings, restart VS Code — the extension watches for
//   these changes and requires a reload to take effect.
//
//   Or set the environment variable before launching VS Code:
//
//     export COPILOT_OTEL_ENABLED=true
//
//   The DB file is created in VS Code's global storage directory:
//     ~/Library/Application Support/Code/User/globalStorage/github.copilot-chat/agent-traces.db
//
// ENVIRONMENT VARIABLES:
//   CODEBURN_COPILOT_OTEL_DB    — Override the agent-traces.db path
//   CODEBURN_COPILOT_DISABLE_OTEL=1 — Skip OTel entirely, use only JSONL
//   CODEBURN_COPILOT_WS_STORAGE_DIR — Override VS Code workspaceStorage
//   CODEBURN_COPILOT_GLOBAL_STORAGE_DIR — Override VS Code globalStorage
//   CODEBURN_COPILOT_JETBRAINS_DIR — Override the JetBrains github-copilot root
//
// ARCHITECTURE:
//   discoverSessions() returns OTel sessions and legacy JSONL sessions. When
//   OTel is present, VS Code core chatSessions are skipped because they mirror
//   the same Copilot turns under different IDs. OTel sessions carry the full
//   token breakdown; JSONL sessions only carry output tokens (the original
//   behaviour, as a fallback).
//
// LIMITATIONS:
//   - The OTel DB only contains Copilot Chat and Agent mode spans. Inline
//     completions (ghost text) and Agent Host spans are NOT yet written to
//     this DB (see https://github.com/microsoft/vscode/issues/315901).
//   - The DB schema is inferred from the official OTel GenAI semantic
//     conventions and the Copilot Budget extension's approach. If VS Code
//     changes the schema, this parser will need updating.
// =============================================================================

import { readdir, stat } from 'fs/promises'
import { homedir, platform } from 'os'
import { join, basename, dirname, posix, win32 } from 'path'
import { existsSync } from 'fs'
import { readSessionFile } from '../fs-utils.js'
import { calculateCost } from '../models.js'
import { extractBashCommands } from '../bash-utils.js'
import {
  collectJetBrainsRepoDirCandidates, decodeCopilot, normalizeCopilotTool,
} from '@codeburn/core/providers/copilot'
import type { CopilotDecodedCall, CopilotOtelConversationRecord, CopilotOtelSpanRecord,
  SpanAttributes } from '@codeburn/core/providers/copilot'
import { createBridgedProvider } from './bridge.js'
import type {
  Provider,
  SessionSource,
  ParsedProviderCall,
} from './types.js'

// ---------------------------------------------------------------------------
// Model display names (unchanged from original)
// ---------------------------------------------------------------------------
const modelDisplayNames: Record<string, string> = {
  'gpt-4.1-nano': 'GPT-4.1 Nano',
  'gpt-4.1-mini': 'GPT-4.1 Mini',
  'gpt-4.1': 'GPT-4.1',
  'gpt-4o-mini': 'GPT-4o Mini',
  'gpt-4o': 'GPT-4o',
  'gpt-5-mini': 'GPT-5 Mini',
  'gpt-5': 'GPT-5',
  'claude-sonnet-4-5': 'Sonnet 4.5',
  'claude-sonnet-4': 'Sonnet 4',
  'copilot-openai-auto': 'Copilot (OpenAI auto)',
  'copilot-anthropic-auto': 'Copilot (Anthropic auto)',
}

const modelDisplayEntries = Object.entries(modelDisplayNames).sort(
  (a, b) => b[0].length - a[0].length
)

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function getCopilotSessionStateDir(override?: string): string {
  return override ?? process.env['CODEBURN_COPILOT_SESSION_STATE_DIR'] ?? join(homedir(), '.copilot', 'session-state')
}

/**
 * Locate the agent-traces.db file.
 *
 * Priority:
 *   1. CODEBURN_COPILOT_OTEL_DB env var
 *   2. Platform-specific default VS Code global storage path
 *   3. VSCodium variant paths
 */
function getAgentTracesDbPath(): string | null {
  // Allow explicit override
  const envOverride = process.env['CODEBURN_COPILOT_OTEL_DB']
  if (envOverride) {
    return existsSync(envOverride) ? envOverride : null
  }

  const home = homedir()
  const candidates: string[] = []

  const p = platform()
  if (p === 'darwin') {
    // macOS: VS Code, VS Code Insiders, VSCodium
    candidates.push(
      join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'github.copilot-chat', 'agent-traces.db'),
      join(home, 'Library', 'Application Support', 'Code - Insiders', 'User', 'globalStorage', 'github.copilot-chat', 'agent-traces.db'),
      join(home, 'Library', 'Application Support', 'VSCodium', 'User', 'globalStorage', 'github.copilot-chat', 'agent-traces.db'),
    )
  } else if (p === 'linux') {
    // Linux: VS Code, VS Code Insiders, VSCodium
    candidates.push(
      join(home, '.config', 'Code', 'User', 'globalStorage', 'github.copilot-chat', 'agent-traces.db'),
      join(home, '.config', 'Code - Insiders', 'User', 'globalStorage', 'github.copilot-chat', 'agent-traces.db'),
      join(home, '.config', 'VSCodium', 'User', 'globalStorage', 'github.copilot-chat', 'agent-traces.db'),
    )
  } else if (p === 'win32') {
    // Windows
    const appdata = process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming')
    candidates.push(
      join(appdata, 'Code', 'User', 'globalStorage', 'github.copilot-chat', 'agent-traces.db'),
      join(appdata, 'Code - Insiders', 'User', 'globalStorage', 'github.copilot-chat', 'agent-traces.db'),
      join(appdata, 'VSCodium', 'User', 'globalStorage', 'github.copilot-chat', 'agent-traces.db'),
    )
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Locate the GitHub Copilot config root used by the JetBrains IDE plugin
 * (IntelliJ IDEA, PyCharm, RubyMine, …). The JetBrains Copilot agent persists
 * chat/agent sessions here — a location none of the VS Code or CLI sources
 * touch, so this is the only way JetBrains-driven Copilot usage becomes
 * visible to CodeBurn.
 *
 * The path mirrors the plugin's own `getXdgConfigPath` logic (observed in the
 * bundled copilot-agent language server):
 *   - $XDG_CONFIG_HOME/github-copilot (when set to an absolute path)
 *   - macOS / Linux: ~/.config/github-copilot
 *   - Windows:       %USERPROFILE%\AppData\Local\github-copilot
 *
 * Under this root, each IDE has its own subdir (e.g. `iu` for IntelliJ IDEA
 * Ultimate, `intellij` for the community edition) containing
 * chat-agent-sessions/, chat-sessions/, and chat-edit-sessions/.
 */
function getJetBrainsCopilotRoot(override?: string): string {
  const envOverride = override ?? process.env['CODEBURN_COPILOT_JETBRAINS_DIR']
  if (envOverride) return envOverride

  const xdg = process.env['XDG_CONFIG_HOME']
  if (xdg && (posix.isAbsolute(xdg) || win32.isAbsolute(xdg))) {
    return join(xdg, 'github-copilot')
  }

  if (platform() === 'win32') {
    const local = process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local')
    return join(local, 'github-copilot')
  }

  return join(homedir(), '.config', 'github-copilot')
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseCwd(yaml: string): string | null {
  const match = yaml.match(/^cwd:\s*(.+)$/m)
  if (!match?.[1]) return null
  let raw = match[1].trim()
  // Strip inline YAML comments (# preceded by optional whitespace)
  raw = raw.replace(/\s*#.*$/, '')
  // Strip surrounding single/double quotes
  raw = raw.replace(/^['"]|['"]$/g, '').trim()
  return raw || null
}

/**
 * Load span attributes from the span_attributes table (key-value pairs).
 * This handles the modern VS Code Copilot Chat schema where attributes
 * are stored as separate key-value rows rather than a JSON blob.
 */
function loadSpanAttributesFromTable(
  db: ReturnType<typeof import('../sqlite.js')['openDatabase']>,
  spanId: string
): SpanAttributes {
  try {
    const rows = db.query<{ key: string; value: string | null }>(
      `SELECT key, value FROM span_attributes WHERE span_id = ?`,
      [spanId]
    )
    const attrs: SpanAttributes = {}
    for (const row of rows) {
      if (row.key && row.value) {
        try {
          // Try to parse numeric values
          const numValue = Number(row.value)
          attrs[row.key as keyof SpanAttributes] = Number.isNaN(numValue) 
            ? row.value
            : numValue
        } catch {
          attrs[row.key as keyof SpanAttributes] = row.value
        }
      }
    }
    return attrs
  } catch {
    return {}
  }
}

// Shell control-flow keywords. These lead a statement but are not commands, so
// they must never be reported as bash commands.
const OTEL_SHELL_KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi',
  'for', 'while', 'until', 'do', 'done',
  'case', 'esac', 'select', 'function', 'in', 'time', 'coproc',
])

/**
 * Normalise an OTEL shell command before command-name extraction.
 *
 * Unlike the Copilot CLI / VS Code JSONL logs — which record a single command
 * per tool call (e.g. `cd x && python3 y`) — the OTEL store records the FULL
 * multi-line script the agent ran (heredocs, for/if blocks, newline-separated
 * statements). The shared extractBashCommands helper only splits on `;`/`&&`/`|`
 * and has no concept of shell keywords, so those scripts leak control-flow words
 * (`for`, `do`, `if`, `then`, …) and collapse newline-separated statements.
 *
 * Normalising here — rather than in the shared helper — keeps every other
 * provider's behaviour unchanged. We (1) turn newlines into `;` so each
 * statement is its own segment, then (2) drop shell control-flow keywords.
 */
function extractOtelBashCommands(command: string): string[] {
  const normalized = command.replace(/\r?\n/g, '; ')
  return extractBashCommands(normalized).filter(c => !OTEL_SHELL_KEYWORDS.has(c))
}

/** Walk up from `dir` to the nearest ancestor containing `.git`; return its basename. */
function findGitRepoRoot(dir: string): string | undefined {
  let cur = dir
  // Bound the walk to avoid pathological loops; repos are never this deep.
  for (let i = 0; i < 40 && cur && cur !== '/'; i++) {
    if (existsSync(join(cur, '.git'))) {
      const name = basename(cur)
      return name || undefined
    }
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return undefined
}

/**
 * Recover the plugin-recorded project label from a Nitrite .db.
 *
 * JetBrains Copilot 1.12+ serialises a `projectName` field on the session doc
 * (e.g. `my-service`, `codeburn`). It is the plugin's OWN authoritative
 * label — the JetBrains analogue of the OTel source's
 * `github.copilot.git.repository` — so it is preferred over the file-path
 * git-walk heuristic when present.
 *
 * The field is a Java-serialized string: the key bytes `projectName` are
 * followed immediately by TC_STRING framing `0x74 <u16 big-endian length>
 * <UTF-8 bytes>`. We read exactly `length` bytes (so an embedded newline or
 * quote can't truncate it) and accept the first occurrence whose value is a
 * plausible short, printable repo name. Older plugins that don't write the
 * field simply yield undefined (callers fall back to the git-walk).
 *
 * Note: the field lives on the session doc, which the plugin writes into the
 * `chat-sessions` / `chat-edit-sessions` stores — often NOT the
 * `chat-agent-sessions` store where the billable turns live. Discovery joins
 * the two by store id; see resolveJetBrainsProjectNames.
 */
function extractJetBrainsProjectName(raw: string): string | undefined {
  const re = /projectName\x74([\x00-\xff])([\x00-\xff])/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw))) {
    const len = (m[1]!.charCodeAt(0) << 8) | m[2]!.charCodeAt(0)
    // Repo names are short; a huge length means we matched a schema/key
    // occurrence rather than a value-bearing one — skip it.
    if (len < 1 || len > 128) continue
    const start = m.index + m[0].length
    // The .db is read as latin1, so re-interpret the length-delimited bytes as
    // UTF-8 (repo names can contain non-ASCII). Reject only if the decoded value
    // holds control chars — a sign we matched a non-value occurrence, not a name.
    const val = Buffer.from(raw.slice(start, start + len), 'latin1').toString('utf8')
    // eslint-disable-next-line no-control-regex
    if (val.length > 0 && !/[\x00-\x1f]/.test(val)) return val
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Extended SessionSource for OTel sessions
// ---------------------------------------------------------------------------

interface OTelSessionSource extends SessionSource {
  conversationId?: string
  sourceType: 'otel'
}

interface JsonlSessionSource extends SessionSource {
  sourceType: 'jsonl'
}

interface ChatSessionSource extends SessionSource {
  sourceType: 'chatsession'
}

interface JetBrainsSessionSource extends SessionSource {
  sourceType: 'jetbrains'
  // Fallback conversation id for turns whose own GUID can't be recovered (the
  // on-disk store dir name). Normally each turn is grouped by its own tab GUID.
  sessionId: string
  // On-disk store directory name — the join key for the projectName lookup
  // across sibling kind dirs (chat-sessions / chat-edit-sessions).
  storeId: string
  // Nitrite .db (copilot-*-nitrite.db) — the store's session content.
  dbPath: string
  // File mtime (ISO). The store has no reliable per-turn timestamp, so this
  // places every turn on a day — without it, calls fall outside date ranges.
  mtime: string
  // Plugin-recorded project label (JetBrains Copilot 1.12+), resolved across
  // all kind dirs by store id. The billable turns live in chat-agent-sessions,
  // but the projectName field is usually written only into the sibling
  // chat-sessions / chat-edit-sessions store, so discovery joins them by id.
  // Undefined for older plugins that don't record it.
  projectName?: string
}

function isOtelSource(source: SessionSource): source is OTelSessionSource {
  return (source as OTelSessionSource).sourceType === 'otel'
}

function isChatSessionSource(source: SessionSource): source is ChatSessionSource {
  return (source as ChatSessionSource).sourceType === 'chatsession'
}

function isJetBrainsSource(source: SessionSource): source is JetBrainsSessionSource {
  return (source as JetBrainsSessionSource).sourceType === 'jetbrains'
}

// ---------------------------------------------------------------------------
// Session discovery: JSONL (original)
// ---------------------------------------------------------------------------

async function discoverJsonlSessions(
  sessionStateDir: string
): Promise<JsonlSessionSource[]> {
  const sources: JsonlSessionSource[] = []

  let sessionDirs: string[]
  try {
    sessionDirs = await readdir(sessionStateDir)
  } catch {
    return sources
  }

  for (const sessionId of sessionDirs) {
    const eventsPath = join(sessionStateDir, sessionId, 'events.jsonl')
    const s = await stat(eventsPath).catch(() => null)
    if (!s?.isFile()) continue

    let project = sessionId
    try {
      const yaml = await readSessionFile(
        join(sessionStateDir, sessionId, 'workspace.yaml')
      )
      const cwd = parseCwd(yaml ?? '')
      if (cwd) project = basename(cwd)
    } catch {
      // workspace.yaml may not exist
    }

    sources.push({
      path: eventsPath,
      project,
      provider: 'copilot',
      sourceType: 'jsonl',
    })
  }

  return sources
}

// ---------------------------------------------------------------------------
// Session discovery: OTel SQLite
// ---------------------------------------------------------------------------

async function discoverOtelSessions(
  dbPath: string
): Promise<OTelSessionSource[]> {
  // Verify the DB file exists. Return one source per DB file; the parser
  // opens the DB once and iterates all conversations in a single DB open,
  // which is far more efficient than one source (and one DB open) per conversation.
  try {
    await stat(dbPath)
  } catch {
    return []
  }
  return [{ path: dbPath, project: 'copilot-chat', provider: 'copilot', sourceType: 'otel' }]
}

// ---------------------------------------------------------------------------
// Session discovery: JetBrains (IntelliJ IDEA, PyCharm, …)
// ---------------------------------------------------------------------------

// The three JetBrains Copilot session kinds (agent / ask / edit mode). Each
// store directory holds a Nitrite .db with that kind's session content.
const JETBRAINS_SESSION_KINDS = ['chat-agent-sessions', 'chat-sessions', 'chat-edit-sessions']

// Candidate Nitrite .db filenames per kind, plus a generic fallback.
const JETBRAINS_DB_NAMES: Record<string, string> = {
  'chat-agent-sessions': 'copilot-agent-sessions-nitrite.db',
  'chat-sessions': 'copilot-chat-nitrite.db',
  'chat-edit-sessions': 'copilot-edit-sessions-nitrite.db',
}

/** Locate the Nitrite .db in a store dir (known name, else any *-nitrite.db). */
async function findNitriteDbPath(storeDir: string, kind: string): Promise<string | null> {
  const known = JETBRAINS_DB_NAMES[kind]
  if (known) {
    const p = join(storeDir, known)
    if ((await stat(p).catch(() => null))?.isFile()) return p
  }
  let files: string[]
  try {
    files = await readdir(storeDir)
  } catch {
    return null
  }
  const db = files.find((f) => f.endsWith('-nitrite.db'))
  return db ? join(storeDir, db) : null
}

/**
 * Discover JetBrains Copilot sessions under the github-copilot config root.
 *
 * Layout: <root>/<ide>/<kind>/<storeId>/copilot-*-nitrite.db
 *   <ide>  — per-IDE dir (iu, intellij, PyCharm2025.2, …)
 *   <kind> — one of JETBRAINS_SESSION_KINDS
 *
 * Emits one source per store directory that has a Nitrite .db. The store
 * records no token counts, so the parser estimates output tokens from the
 * assistant reply text (see createJetBrainsParser).
 */
async function discoverJetBrainsSessions(
  root: string
): Promise<JetBrainsSessionSource[]> {
  const sources: JetBrainsSessionSource[] = []

  let ideDirs: string[]
  try {
    ideDirs = await readdir(root)
  } catch {
    return sources
  }

  for (const ide of ideDirs) {
    for (const kind of JETBRAINS_SESSION_KINDS) {
      const kindDir = join(root, ide, kind)
      let storeDirs: string[]
      try {
        storeDirs = await readdir(kindDir)
      } catch {
        continue // this IDE doesn't have this session kind
      }

      for (const storeId of storeDirs) {
        const storeDir = join(kindDir, storeId)
        const dbPath = await findNitriteDbPath(storeDir, kind)
        if (!dbPath) continue

        const dbStat = await stat(dbPath).catch(() => null)
        const mtime = (dbStat?.mtime ?? new Date(0)).toISOString()

        sources.push({
          path: dbPath,
          project: 'copilot-jetbrains',
          provider: 'copilot',
          sourceType: 'jetbrains',
          sessionId: storeId,
          storeId,
          dbPath,
          mtime,
        })
      }
    }
  }

  // Join projectName across kinds by store id. The plugin records the label on
  // the session doc, which usually lands in the chat-sessions/chat-edit-sessions
  // store — NOT the chat-agent-sessions store where the billable turns live.
  // Without this join, every current agent session falls to the generic bucket
  // even though its repo name is sitting one store dir over.
  await resolveJetBrainsProjectNames(sources)

  return sources
}

/**
 * Populate each source's `projectName` from whichever store dir (of the same
 * store id) actually recorded it. Reads each source's .db once; a store whose
 * own .db lacks the field inherits it from a sibling-kind store with the same
 * id. Best-effort — read/parse failures leave projectName undefined.
 */
async function resolveJetBrainsProjectNames(
  sources: JetBrainsSessionSource[]
): Promise<void> {
  const byStore = new Map<string, string>()
  for (const src of sources) {
    // Already found this store's name via a sibling-kind source — skip the read.
    if (!src.dbPath || byStore.has(src.storeId)) continue
    let raw: string | null = null
    try {
      raw = await readSessionFile(src.dbPath, 'latin1')
    } catch {
      raw = null
    }
    if (!raw) continue
    const name = extractJetBrainsProjectName(raw)
    if (name) byStore.set(src.storeId, name)
  }
  for (const src of sources) {
    const name = byStore.get(src.storeId)
    if (name) src.projectName = name
  }
}

/**
 * Returns the VS Code workspaceStorage directories for all VS Code variants
 * (Code, Code Insiders, VSCodium) on the given platform. Used to discover
 * transcript sessions written by the Copilot Chat extension.
 *
 * Accepts explicit `home` and `os` arguments so callers (and tests) can pass
 * custom values without relying on process-level globals.
 */
export function getVSCodeWorkspaceStorageDirs(home: string, os: string): string[] {
  const j = os === 'win32' ? win32.join : posix.join
  if (os === 'darwin') {
    return [
      j(home, 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage'),
      j(home, 'Library', 'Application Support', 'Code - Insiders', 'User', 'workspaceStorage'),
      j(home, 'Library', 'Application Support', 'VSCodium', 'User', 'workspaceStorage'),
    ]
  }
  if (os === 'linux') {
    return [
      j(home, '.config', 'Code', 'User', 'workspaceStorage'),
      j(home, '.config', 'Code - Insiders', 'User', 'workspaceStorage'),
      j(home, '.config', 'VSCodium', 'User', 'workspaceStorage'),
    ]
  }
  // win32
  return [
    j(home, 'AppData', 'Roaming', 'Code', 'User', 'workspaceStorage'),
    j(home, 'AppData', 'Roaming', 'Code - Insiders', 'User', 'workspaceStorage'),
    j(home, 'AppData', 'Roaming', 'VSCodium', 'User', 'workspaceStorage'),
  ]
}

export function getVSCodeGlobalStorageDirs(home: string, os: string): string[] {
  const j = os === 'win32' ? win32.join : posix.join
  if (os === 'darwin') {
    return [
      j(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage'),
      j(home, 'Library', 'Application Support', 'Code - Insiders', 'User', 'globalStorage'),
      j(home, 'Library', 'Application Support', 'VSCodium', 'User', 'globalStorage'),
    ]
  }
  if (os === 'linux') {
    return [
      j(home, '.config', 'Code', 'User', 'globalStorage'),
      j(home, '.config', 'Code - Insiders', 'User', 'globalStorage'),
      j(home, '.config', 'VSCodium', 'User', 'globalStorage'),
    ]
  }
  return [
    j(home, 'AppData', 'Roaming', 'Code', 'User', 'globalStorage'),
    j(home, 'AppData', 'Roaming', 'Code - Insiders', 'User', 'globalStorage'),
    j(home, 'AppData', 'Roaming', 'VSCodium', 'User', 'globalStorage'),
  ]
}

async function resolveWorkspaceProject(wsDir: string, hashDir: string): Promise<string> {
  let project = hashDir
  try {
    const wsJson = await readSessionFile(join(wsDir, hashDir, 'workspace.json'))
    if (wsJson) {
      const data = JSON.parse(wsJson) as { folder?: string }
      if (typeof data.folder === 'string') {
        // folder is a URI like 'file:///home/user/myapp' or 'file:///C:/Users/...'
        const folder = data.folder.replace(/^file:\/\//, '').replace(/\/+$/, '')
        const name = basename(folder)
        if (name) project = name
      }
    }
  } catch {
    // workspace.json may be absent or malformed
  }
  return project
}

async function hasChatSessionFiles(chatSessionsDir: string): Promise<boolean> {
  let files: string[]
  try {
    files = await readdir(chatSessionsDir)
  } catch {
    return false
  }

  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue
    const s = await stat(join(chatSessionsDir, file)).catch(() => null)
    if (s?.isFile()) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Session discovery: VS Code core chatSessions
// ---------------------------------------------------------------------------

async function discoverWorkspaceChatSessions(
  workspaceStorageDirs: string[]
): Promise<ChatSessionSource[]> {
  const sources: ChatSessionSource[] = []

  for (const wsDir of workspaceStorageDirs) {
    let hashDirs: string[]
    try {
      hashDirs = await readdir(wsDir)
    } catch {
      continue
    }

    for (const hashDir of hashDirs) {
      const chatSessionsDir = join(wsDir, hashDir, 'chatSessions')
      let files: string[]
      try {
        files = await readdir(chatSessionsDir)
      } catch {
        continue
      }

      const project = await resolveWorkspaceProject(wsDir, hashDir)
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue
        const path = join(chatSessionsDir, file)
        const s = await stat(path).catch(() => null)
        if (!s?.isFile()) continue
        sources.push({
          path,
          project,
          provider: 'copilot',
          sourceType: 'chatsession',
        })
      }
    }
  }

  return sources
}

async function discoverEmptyWindowChatSessions(
  globalStorageDirs: string[]
): Promise<ChatSessionSource[]> {
  const sources: ChatSessionSource[] = []

  for (const globalDir of globalStorageDirs) {
    const chatSessionsDir = join(globalDir, 'emptyWindowChatSessions')
    let files: string[]
    try {
      files = await readdir(chatSessionsDir)
    } catch {
      continue
    }

    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue
      const path = join(chatSessionsDir, file)
      const s = await stat(path).catch(() => null)
      if (!s?.isFile()) continue
      sources.push({
        path,
        project: 'copilot-chat',
        provider: 'copilot',
        sourceType: 'chatsession',
      })
    }
  }

  return sources
}

// ---------------------------------------------------------------------------
// Session discovery: VS Code workspace transcripts
// ---------------------------------------------------------------------------

/**
 * Discover Copilot Chat transcript sessions stored in VS Code workspaceStorage.
 * Structure: {wsDir}/{hash}/GitHub.copilot-chat/transcripts/{session}.jsonl
 * Project is read from {wsDir}/{hash}/workspace.json (folder URI).
 */
async function discoverTranscriptSessions(
  workspaceStorageDirs: string[]
): Promise<JsonlSessionSource[]> {
  const sources: JsonlSessionSource[] = []

  for (const wsDir of workspaceStorageDirs) {
    let hashDirs: string[]
    try {
      hashDirs = await readdir(wsDir)
    } catch {
      continue
    }

    for (const hashDir of hashDirs) {
      const chatSessionsDir = join(wsDir, hashDir, 'chatSessions')
      if (await hasChatSessionFiles(chatSessionsDir)) continue

      const transcriptsDir = join(wsDir, hashDir, 'GitHub.copilot-chat', 'transcripts')
      const project = await resolveWorkspaceProject(wsDir, hashDir)

      let transcriptFiles: string[]
      try {
        transcriptFiles = await readdir(transcriptsDir)
      } catch {
        continue
      }

      for (const file of transcriptFiles) {
        if (!file.endsWith('.jsonl')) continue
        const s = await stat(join(transcriptsDir, file)).catch(() => null)
        if (!s?.isFile()) continue
        sources.push({
          path: join(transcriptsDir, file),
          project,
          provider: 'copilot',
          sourceType: 'jsonl',
        })
      }
    }
  }

  return sources
}

// ---------------------------------------------------------------------------
// Bridged provider I/O adapter
// ---------------------------------------------------------------------------

async function readJsonlRecords(source: SessionSource): Promise<unknown[] | null> {
  const content = await readSessionFile(source.path)
  if (content === null) throw new Error('Copilot JSONL source was unreadable')
  return [{ kind: 'jsonl', sessionId: basename(dirname(source.path)),
            lines: content.split('\n').filter((l) => l.trim()) }]
}

async function readChatSessionRecords(source: SessionSource): Promise<unknown[] | null> {
  const content = await readSessionFile(source.path)
  if (content === null) throw new Error('Copilot chat session source was unreadable')
  return [{ kind: 'chatsession', content, project: source.project,
            fallbackSessionId: basename(source.path, '.jsonl') }]
}

async function readJetBrainsRecords(source: SessionSource): Promise<unknown[] | null> {
  const jbSource = source as JetBrainsSessionSource
  if (!jbSource.dbPath) throw new Error('Copilot JetBrains source has no DB path')
  const raw = await readSessionFile(jbSource.dbPath, 'latin1')
  // readSessionFile deliberately returns null for stat/read/size failures. A
  // durable source must surface that as a failed parse, not a successful empty
  // decode: success would stamp the new fingerprint and clear needsReparse,
  // permanently hiding rows added while the DB was unreadable.
  if (!raw) throw new Error('Copilot JetBrains DB was unreadable or empty')
  // FS probe stays host-side: resolve every candidate dir the decoder could ask for.
  const memo = new Map<string, string | undefined>()
  const repoRootByDir = new Map<string, string>()
  for (const dir of collectJetBrainsRepoDirCandidates(raw)) {
    if (!memo.has(dir)) memo.set(dir, findGitRepoRoot(dir))
    const repo = memo.get(dir)
    if (repo) repoRootByDir.set(dir, repo)
  }
  return [{ kind: 'jetbrains', raw, repoRootByDir, sessionId: jbSource.sessionId,
            mtime: jbSource.mtime, ...(jbSource.projectName !== undefined ? { projectName: jbSource.projectName } : {}) }]
}

async function readOtelRecords(source: SessionSource): Promise<unknown[] | null> {
  // Lazy-load the SQLite module (same pattern as Cursor/OpenCode providers)
  const { openDatabase } = await import('../sqlite.js')

  // One DB open handles ALL conversations — avoids N opens for N conversations.
  const db = openDatabase(source.path)

  try {
    // ---------------------------------------------------------------
    // Get all distinct conversations in the DB with their project names.
    // ---------------------------------------------------------------
    const conversationRows = db.query<{
      conversation_id: string
      project: string | null
      min_start: number
    }>(
      `SELECT DISTINCT
         sa_conv.value AS conversation_id,
         COALESCE(sa_repo.value, 'copilot-chat') AS project,
         MIN(s.start_time_ms) AS min_start
       FROM spans s
       LEFT JOIN span_attributes sa_conv
         ON s.span_id = sa_conv.span_id AND sa_conv.key = 'gen_ai.conversation.id'
       LEFT JOIN span_attributes sa_repo
         ON s.span_id = sa_repo.span_id AND sa_repo.key = 'github.copilot.git.repository'
       WHERE sa_conv.value IS NOT NULL
       GROUP BY sa_conv.value
       ORDER BY min_start DESC`
    )

    const conversations: CopilotOtelConversationRecord[] = []

    for (const convRow of conversationRows) {
      const conversationId = convRow.conversation_id
      if (!conversationId) continue

      let project = convRow.project ?? 'copilot-chat'
      if (project.includes('/')) {
        project = basename(project.replace(/\.git$/, ''))
      }

      const spanIdRows = db.query<{ span_id: string; trace_id: string }>(
        `SELECT DISTINCT s.span_id, s.trace_id
         FROM spans s
         INNER JOIN span_attributes sa 
           ON s.span_id = sa.span_id AND sa.key = 'gen_ai.conversation.id' AND sa.value = ?
         ORDER BY s.start_time_ms ASC`,
        [conversationId]
      )

      const traceIds = new Set<string>()
      for (const row of spanIdRows) {
        traceIds.add(row.trace_id)
      }

      if (traceIds.size === 0) {
        continue
      }

      const traceIdArr = [...traceIds]
      const tracePlaceholders = traceIdArr.map(() => '?').join(',')
      const traceSpans = db.query<{
        span_id: string
        trace_id: string
        operation_name: string | null
        start_time_ms: number
        response_model: string | null
      }>(
        `SELECT span_id, trace_id, operation_name, start_time_ms, response_model FROM spans WHERE trace_id IN (${tracePlaceholders})`,
        traceIdArr
      )

      const spans: CopilotOtelSpanRecord[] = []
      for (const span of traceSpans) {
        const operationName = span.operation_name || ''
        const attrs: SpanAttributes | null =
          operationName === 'chat' || operationName === 'execute_tool' || operationName === 'invoke_agent'
            ? loadSpanAttributesFromTable(db, span.span_id)
            : null
        spans.push({
          spanId: span.span_id,
          traceId: span.trace_id,
          operationName,
          startTimeMs: span.start_time_ms,
          responseModel: span.response_model,
          attrs,
        })
      }

      conversations.push({ conversationId, project, spans })
    }

    return [{ kind: 'otel', conversations }]
  } finally {
    db.close()
  }
}

async function readRecords(source: SessionSource): Promise<unknown[] | null> {
  if (isOtelSource(source))       return readOtelRecords(source)
  if (isChatSessionSource(source)) return readChatSessionRecords(source)
  if (isJetBrainsSource(source))   return readJetBrainsRecords(source)
  return readJsonlRecords(source)
}

function toProviderCall(rich: CopilotDecodedCall): ParsedProviderCall {
  const base = {
    provider: 'copilot' as const,
    sessionId: rich.sessionId,
    ...(rich.project !== undefined ? { project: rich.project } : {}),
    model: rich.model,
    inputTokens: rich.inputTokens,
    outputTokens: rich.outputTokens,
    cacheCreationInputTokens: rich.cacheCreationInputTokens,
    cacheReadInputTokens: rich.cacheReadInputTokens,
    cachedInputTokens: rich.cachedInputTokens,
    reasoningTokens: rich.reasoningTokens,
    webSearchRequests: rich.webSearchRequests,
    tools: rich.tools,
    timestamp: rich.timestamp,
    speed: rich.speed,
    deduplicationKey: rich.deduplicationKey,
    ...(rich.cacheIdentityKey !== undefined ? { cacheIdentityKey: rich.cacheIdentityKey } : {}),
    ...(rich.deduplicationAliases !== undefined ? { deduplicationAliases: rich.deduplicationAliases } : {}),
    userMessage: rich.userMessage,
  }

  if (rich.arm === 'jsonl-shutdown') {
    // Tokens are real counts written by the CLI, so this cost is
    // measured, not char-estimated: costIsEstimated is false.
    //
    // NOT lifted to the pricing pass (Phase 0 residual; revisit Phase 8):
    // this call carries reasoningTokens for reporting but deliberately
    // prices output as 0 (the per-turn assistant.message events own the
    // output cost; billing it here would double-count). The generic
    // 'estimated' path bills outputTokens + reasoningTokens, so it cannot
    // reproduce this reasoning-excluded figure when reasoningTokens > 0.
    // Keep the in-decoder price call; the pass leaves it untouched (no
    // costBasis). copilot is non-whitelisted, so the cache-read recompute
    // already bills reasoning here — a pre-existing cold/warm divergence
    // left exactly as-is.
    const costUSD = calculateCost(
      rich.model, rich.inputTokens, 0, rich.cacheCreationInputTokens, rich.cacheReadInputTokens, 0,
    )
    return { ...base, costUSD, costIsEstimated: false, bashCommands: [] }
  }

  if (rich.arm === 'otel') {
    return { ...base, costBasis: 'estimated',
      bashCommands: rich.rawBashCommands.flatMap((c) => extractOtelBashCommands(c)),
      subagentTypes: rich.subagentTypes }
  }

  if (rich.arm === 'jsonl-turn') {
    return { ...base, costBasis: 'estimated',
      bashCommands: rich.rawBashCommands.flatMap((c) => extractBashCommands(c)),
      skills: rich.skills, subagentTypes: rich.subagentTypes }
  }

  if (rich.arm === 'jetbrains') {
    return { ...base, costBasis: 'estimated', costIsEstimated: true, bashCommands: [] }
  }

  // chatsession
  return { ...base, costBasis: 'estimated', bashCommands: [] }
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

export function createCopilotProvider(
  sessionStateDir?: string,
  workspaceStorageDir?: string,
  globalStorageDir?: string,
  jetbrainsDir?: string
): Provider {
  // jsonlDir is resolved lazily inside discoverSessions so that env-var
  // overrides set after module load (e.g. in tests) are respected.

  /**
   * Returns the workspaceStorage directories to scan for transcript sessions.
   * When workspaceStorageDir is explicitly provided (e.g. in tests), that single
   * directory is used. The CODEBURN_COPILOT_WS_STORAGE_DIR env var provides a
   * single-dir override (useful for tests). Otherwise all platform-default VS
   * Code variant paths are returned.
   */
  function getWsDirs(): string[] {
    if (workspaceStorageDir !== undefined) return [workspaceStorageDir]
    const envDir = process.env['CODEBURN_COPILOT_WS_STORAGE_DIR']
    if (envDir) return [envDir]
    return getVSCodeWorkspaceStorageDirs(homedir(), platform())
  }

  function getGlobalDirs(): string[] {
    if (globalStorageDir !== undefined) return [globalStorageDir]
    const envDir = process.env['CODEBURN_COPILOT_GLOBAL_STORAGE_DIR']
    if (envDir) return [envDir]
    return getVSCodeGlobalStorageDirs(homedir(), platform())
  }

  return createBridgedProvider<CopilotDecodedCall>({
    name: 'copilot',
    displayName: 'Copilot',
    durableSources: true,

    modelDisplayName(model: string): string {
      for (const [key, display] of modelDisplayEntries) {
        if (model.includes(key)) return display
      }
      return model
    },

    toolDisplayName(rawTool: string): string {
      return normalizeCopilotTool(rawTool)
    },

    async discoverSessions(): Promise<SessionSource[]> {
      const sources: SessionSource[] = []
      let discoveredOtel = false

      // 1. Discover OTel sessions (preferred — full token data)
      const disableOtel = process.env['CODEBURN_COPILOT_DISABLE_OTEL'] === '1'
      if (!disableOtel) {
        const dbPath = getAgentTracesDbPath()
        if (dbPath) {
          try {
            const otelSources = await discoverOtelSessions(dbPath)
            discoveredOtel = otelSources.length > 0
            sources.push(...otelSources)
          } catch {
            // OTel discovery failed — fall through to JSONL
          }
        }
      }

      // 2. Discover JSONL sessions (fallback — output tokens only)
      try {
        const jsonlDir = getCopilotSessionStateDir(sessionStateDir)
        const jsonlSources = await discoverJsonlSessions(jsonlDir)
        sources.push(...jsonlSources)
      } catch {
        // JSONL discovery failed
      }

      // Prefer OTel over chatSessions: they can mirror the same turns under
      // incompatible IDs, and OTel carries richer token/cache data.
      if (!discoveredOtel) {
        // 3. Discover VS Code core chatSessions journals
        try {
          const chatSessionSources = await discoverWorkspaceChatSessions(getWsDirs())
          sources.push(...chatSessionSources)
        } catch {
          // Workspace chatSessions discovery failed
        }

        // 4. Discover VS Code empty-window chatSessions journals
        try {
          const emptyWindowSources = await discoverEmptyWindowChatSessions(getGlobalDirs())
          sources.push(...emptyWindowSources)
        } catch {
          // Empty-window chatSessions discovery failed
        }
      }

      // 5. Discover VS Code workspace transcript sessions
      try {
        const transcriptSources = await discoverTranscriptSessions(getWsDirs())
        sources.push(...transcriptSources)
      } catch {
        // Transcript discovery failed
      }

      // 6. Discover JetBrains IDE sessions (IntelliJ, PyCharm, …). These live
      // in a store none of the VS Code / CLI sources touch, so there is no
      // overlap to dedupe against; the shared seenKeys set still guards it.
      try {
        const jetbrainsSources = await discoverJetBrainsSessions(
          getJetBrainsCopilotRoot(jetbrainsDir)
        )
        sources.push(...jetbrainsSources)
      } catch {
        // JetBrains discovery failed
      }

      return sources
    },

    readRecords,
    decode: decodeCopilot,
    toProviderCall,
  })
}

// Default export for the provider registry
export const copilot = createCopilotProvider()
