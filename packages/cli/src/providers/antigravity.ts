import { readdir, readFile, mkdir, stat, open, rename, unlink } from 'fs/promises'
import { execFile } from 'child_process'
import { randomBytes } from 'crypto'
import { basename, join } from 'path'
import { homedir } from 'os'
import { fileURLToPath } from 'url'
import https from 'https'

import { isSqliteAvailable, isSqliteBusyError, openDatabase } from '../sqlite.js'
import type { Provider, SessionSource, SessionParser, ParsedProviderCall } from './types.js'
import type { DecodeContext } from '@codeburn/core'
import {
  decodeAntigravityGenMetadata,
  decodeAntigravityGeneratorMetadata,
  decodeAntigravityStatusLine,
  parseAntigravityStatusLinePayload,
  extractAntigravityModelMap,
  extractAntigravityGeneratorMetadata,
} from '@codeburn/core/providers/antigravity'
import type {
  AntigravityDecodedCall,
  AntigravityGeneratorMetadata,
  AntigravityModelMap,
} from '@codeburn/core/providers/antigravity'

// Moved into @codeburn/core (the decoders use them). Re-exported so existing
// importers keep resolving them from this module.
export { extractAntigravityModelMap, extractAntigravityGeneratorMetadata }

type AntigravityConversationRoot = {
  dir: string
  project: string
  extensions: readonly string[]
}

// Computed on each call rather than frozen at module load so discovery honors
// the current home directory (env overrides in tests, and any runtime change).
function conversationRoots(): readonly AntigravityConversationRoot[] {
  const home = homedir()
  return [
    {
      dir: join(home, '.gemini', 'antigravity', 'conversations'),
      project: 'antigravity',
      extensions: ['.pb', '.db'],
    },
    {
      dir: join(home, '.gemini', 'antigravity-cli', 'conversations'),
      project: 'antigravity-cli',
      extensions: ['.pb', '.db'],
    },
    {
      dir: join(home, '.gemini', 'antigravity-cli', 'implicit'),
      project: 'antigravity-cli',
      extensions: ['.pb'],
    },
    {
      dir: join(home, '.gemini', 'antigravity-ide', 'conversations'),
      project: 'antigravity-ide',
      extensions: ['.pb', '.db'],
    },
    {
      dir: join(home, '.gemini', 'antigravity-ide', 'implicit'),
      project: 'antigravity-ide',
      extensions: ['.pb'],
    },
  ]
}
const CACHE_VERSION = 5

const RPC_TIMEOUT_MS = 5000
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024

export type ServerInfo = {
  port: number
  csrfToken: string
}

type ServerCandidate = ServerInfo & {
  appDataDir?: 'antigravity' | 'antigravity-cli' | 'antigravity-ide'
}

type ModelMap = AntigravityModelMap

type CachedCascade = {
  mtimeMs: number
  sizeBytes: number
  calls: ParsedProviderCall[]
}

type AntigravityCache = {
  version: number
  cascades: Record<string, CachedCascade>
}

const cachedServers = new Map<string, ServerInfo | null>()
const cachedModelMaps = new Map<string, ModelMap>()
let memCache: AntigravityCache | null = null
let cacheDirty = false
let httpsAgent: https.Agent | undefined

const SERVER_PORT_FLAGS = ['https_server_port', 'extension_server_port', 'https-server-port', 'extension-server-port']
const CSRF_TOKEN_FLAGS = ['csrf_token', 'extension_server_csrf_token', 'csrf-token', 'extension-server-csrf-token']
const APP_DATA_DIR_FLAGS = ['app_data_dir', 'app-data-dir']

function getAgent(): https.Agent {
  if (!httpsAgent) httpsAgent = new https.Agent({ rejectUnauthorized: false })
  return httpsAgent
}

function getCacheDir(): string {
  return process.env['CODEBURN_CACHE_DIR'] ?? join(homedir(), '.cache', 'codeburn')
}

function getCachePath(): string {
  return join(getCacheDir(), 'antigravity-results.json')
}

export function getAntigravityStatusLineEventsPath(): string {
  return join(getCacheDir(), 'antigravity-statusline.jsonl')
}

function execFileText(command: string, args: string[], timeout = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf-8', timeout, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })
}

function getFlagValue(line: string, names: string[]): string | null {
  for (const name of names) {
    const match = line.match(new RegExp(`--${name}(?:=|\\s+)(?:"([^"]+)"|'([^']+)'|([^\\s]+))`, 'i'))
    const value = match?.[1] ?? match?.[2] ?? match?.[3]
    if (value && !value.startsWith('--')) return value
  }
  return null
}

function isLikelyCsrfToken(value: string): boolean {
  return value.length >= 16 && /^[A-Za-z0-9._~:/+=-]+$/.test(value)
}

function normalizeAppDataDir(value: string | null): 'antigravity' | 'antigravity-cli' | 'antigravity-ide' | undefined {
  if (!value) return undefined
  const normalized = value.replace(/\\/g, '/').toLowerCase()
  if (normalized.includes('antigravity-ide')) return 'antigravity-ide'
  if (normalized.includes('antigravity-cli')) return 'antigravity-cli'
  if (normalized.includes('antigravity')) return 'antigravity'
  return undefined
}

export function extractAntigravityAppDataDirFromLine(line: string): 'antigravity' | 'antigravity-cli' | 'antigravity-ide' | undefined {
  return normalizeAppDataDir(getFlagValue(line, APP_DATA_DIR_FLAGS))
}

function parseAntigravityServerCandidateFromLine(line: string): ServerCandidate | null {
  const lower = line.toLowerCase()
  if (!lower.includes('language_server') || !lower.includes('antigravity')) return null

  const rawPort = getFlagValue(line, SERVER_PORT_FLAGS)
  const csrfToken = getFlagValue(line, CSRF_TOKEN_FLAGS)
  if (!rawPort || !csrfToken) return null
  if (!isLikelyCsrfToken(csrfToken)) return null

  const port = Number(rawPort)
  if (!Number.isInteger(port) || port < 0 || port > 65535) return null

  return {
    port,
    csrfToken,
    appDataDir: extractAntigravityAppDataDirFromLine(line),
  }
}

export function parseAntigravityServerInfoFromLine(line: string): ServerInfo | { port: 0; csrfToken: string } | null {
  const candidate = parseAntigravityServerCandidateFromLine(line)
  return candidate ? { port: candidate.port, csrfToken: candidate.csrfToken } : null
}

export function parseAntigravityServerInfo(lines: string[]): ServerInfo | null {
  for (const line of lines) {
    const server = parseAntigravityServerInfoFromLine(line)
    if (server) return server
  }
  return null
}

function parseAntigravityServerCandidates(lines: string[]): ServerCandidate[] {
  return lines
    .map(parseAntigravityServerCandidateFromLine)
    .filter((server): server is ServerCandidate => server !== null)
}

async function loadCache(): Promise<AntigravityCache> {
  if (memCache) return memCache
  try {
    const raw = await readFile(getCachePath(), 'utf-8')
    const cache = JSON.parse(raw) as AntigravityCache
    if (cache.version === CACHE_VERSION && cache.cascades && typeof cache.cascades === 'object') {
      memCache = cache
      return cache
    }
  } catch { /* no cache or invalid */ }
  memCache = { version: CACHE_VERSION, cascades: {} }
  return memCache
}

async function flushCache(liveCascadeIds?: Set<string>): Promise<void> {
  if (!memCache) return
  // If the caller supplied liveCascadeIds, we must run the eviction step
  // even when no cascade was added or updated this run; otherwise deleted
  // .pb files would persist in the cache forever once it stops getting
  // dirty writes. Mark the cache dirty when an eviction happens so the
  // file write below proceeds.
  if (liveCascadeIds) {
    for (const id of Object.keys(memCache.cascades)) {
      if (!liveCascadeIds.has(id)) {
        delete memCache.cascades[id]
        cacheDirty = true
      }
    }
  }
  if (!cacheDirty) return
  try {

    const dir = getCacheDir()
    await mkdir(dir, { recursive: true })
    const finalPath = getCachePath()
    const tempPath = `${finalPath}.${randomBytes(8).toString('hex')}.tmp`
    const handle = await open(tempPath, 'w', 0o600)
    try {
      await handle.writeFile(JSON.stringify(memCache), { encoding: 'utf-8' })
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await rename(tempPath, finalPath)
    } catch {
      try { await unlink(tempPath) } catch { /* cleanup */ }
    }
    cacheDirty = false
  } catch { /* best-effort */ }
}

async function readProcessCommandLines(): Promise<string[]> {
  if (process.platform === 'win32') {
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -like '*language_server*' -and $_.CommandLine -like '*antigravity*' } | ForEach-Object { $_.CommandLine }",
    ].join('; ')
    const output = await execFileText('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], 5000)
    return output.split(/\r?\n/)
  }

  const output = await execFileText('ps', ['-ww', '-eo', 'args'])
  return output.split('\n')
}

async function resolveEphemeralPort(csrfToken: string, appDataDir?: 'antigravity' | 'antigravity-cli' | 'antigravity-ide'): Promise<ServerInfo | null> {
  if (process.platform === 'win32') {
    try {
      const script = [
        "$ErrorActionPreference = 'SilentlyContinue'",
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -like '*language_server*' -and $_.CommandLine -like '*antigravity*' } | ForEach-Object { @{ PID = $_.ProcessId; Cmd = $_.CommandLine } | ConvertTo-Json -Compress }"
      ].join('; ')
      const output = await execFileText('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], 5000)
      
      let targetPid = 0
      for (const line of output.split(/\r?\n/)) {
        if (!line.trim()) continue
        try {
          const proc = JSON.parse(line) as { PID: number; Cmd: string }
          const candidate = parseAntigravityServerCandidateFromLine(proc.Cmd)
          if (candidate && candidate.csrfToken === csrfToken) {
            if (!appDataDir || !candidate.appDataDir || candidate.appDataDir === appDataDir) {
              targetPid = proc.PID
              break
            }
          }
        } catch { /* skip invalid parse */ }
      }
      
      if (targetPid === 0) return null
      
      const portScript = `Get-NetTCPConnection -State Listen -OwningProcess ${targetPid} | Select-Object -ExpandProperty LocalPort`
      const portOutput = await execFileText('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', portScript], 5000)
      const ports = portOutput.split(/\r?\n/)
        .map(p => Number(p.trim()))
        .filter(p => Number.isInteger(p) && p > 0)
      
      for (const port of ports) {
        try {
          await new Promise((resolve, reject) => {
            const req = https.request({
              hostname: '127.0.0.1',
              port: port,
              path: '/exa.language_server_pb.LanguageServerService/GetAvailableModels',
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Connect-Protocol-Version': '1',
                'X-Codeium-Csrf-Token': csrfToken,
                'Content-Length': 2,
              },
              agent: getAgent(),
              timeout: 1000,
            }, (res) => {
              if (res.statusCode === 200) resolve(true)
              else reject(new Error())
            })
            req.on('error', reject)
            req.write('{}')
            req.end()
          })
          return { port, csrfToken }
        } catch { /* try next port */ }
      }
    } catch { /* best-effort */ }
    return null
  }

  try {
    const processOutput = await execFileText('ps', ['-ww', '-eo', 'pid=,args='])
    let pid = ''
    for (const line of processOutput.split('\n')) {
      const match = line.trim().match(/^(\d+)\s+(.+)$/)
      if (!match) continue
      const candidate = parseAntigravityServerCandidateFromLine(match[2]!)
      if (!candidate) continue
      if (candidate.csrfToken !== csrfToken) continue
      if (appDataDir && candidate.appDataDir && candidate.appDataDir !== appDataDir) continue
      pid = match[1]!
      break
    }
    if (!pid) return null
    const lsofOutput = await execFileText('lsof', ['-a', '-i', '-P', '-n', '-p', pid])
    for (const line of lsofOutput.split('\n')) {
      if (!line.includes('LISTEN')) continue
      const match = line.match(/:(\d+)\s+\(LISTEN\)/)
      if (match) {
        const port = Number(match[1])
        if (port > 0) return { port, csrfToken }
      }
    }
  } catch { /* best-effort */ }
  return null
}

export function antigravityAppDataDirFromSourcePath(path: string): 'antigravity' | 'antigravity-cli' | 'antigravity-ide' {
  const lower = path.replace(/\\/g, '/').toLowerCase()
  if (lower.includes('/.gemini/antigravity-ide/')) return 'antigravity-ide'
  if (lower.includes('/.gemini/antigravity-cli/')) return 'antigravity-cli'
  return 'antigravity'
}

async function detectServer(appDataDir: 'antigravity' | 'antigravity-cli' | 'antigravity-ide' = 'antigravity'): Promise<ServerInfo | null> {
  if (cachedServers.has(appDataDir)) return cachedServers.get(appDataDir)!
  try {
    const candidates = parseAntigravityServerCandidates(await readProcessCommandLines())
    const info = candidates.find(candidate => candidate.appDataDir === appDataDir)
      ?? (appDataDir === 'antigravity' ? candidates.find(candidate => candidate.appDataDir === undefined) : undefined)
      ?? null
    if (info && info.port > 0 && appDataDir !== 'antigravity-ide') {
      cachedServers.set(appDataDir, { port: info.port, csrfToken: info.csrfToken })
    } else if (info) {
      cachedServers.set(appDataDir, await resolveEphemeralPort(info.csrfToken, appDataDir))
    } else {
      cachedServers.set(appDataDir, null)
    }
    return cachedServers.get(appDataDir)!
  } catch { /* process discovery failed or timed out */ }
  cachedServers.set(appDataDir, null)
  return null
}

async function rpc(server: ServerInfo, method: string, body: Record<string, unknown> = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = https.request({
      hostname: '127.0.0.1',
      port: server.port,
      path: `/exa.language_server_pb.LanguageServerService/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'X-Codeium-Csrf-Token': server.csrfToken,
        'Content-Length': Buffer.byteLength(data),
      },
      agent: getAgent(),
      timeout: RPC_TIMEOUT_MS,
    }, (res) => {
      const chunks: Buffer[] = []
      let totalBytes = 0
      res.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length
        if (totalBytes > MAX_RESPONSE_BYTES) {
          res.destroy()
          reject(new Error(`RPC ${method}: response too large`))
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`RPC ${method}: HTTP ${res.statusCode}`))
          return
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')))
        } catch {
          reject(new Error(`RPC ${method}: invalid JSON`))
        }
      })
      res.on('error', reject)
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error(`RPC ${method}: timeout`)) })
    req.write(data)
    req.end()
  })
}

async function getModelMap(server: ServerInfo): Promise<ModelMap> {
  const cacheKey = `${server.port}:${server.csrfToken}`
  const cachedModelMap = cachedModelMaps.get(cacheKey)
  if (cachedModelMap) return cachedModelMap
  try {
    const modelMap = extractAntigravityModelMap(await rpc(server, 'GetAvailableModels'))
    cachedModelMaps.set(cacheKey, modelMap)
    return modelMap
  } catch { /* best-effort */ }
  cachedModelMaps.set(cacheKey, {})
  return {}
}

// Strip Antigravity-specific suffixes so the pricing DB can match
const PRICING_ALIASES: Record<string, string> = {
  'gemini-pro': 'gemini-3.1-pro',
}

function normalizePricingModel(model: string): string {
  const stripped = model.replace(/-(high|medium|low|agent)$/, '')
  return PRICING_ALIASES[stripped] ?? stripped
}

function decodeContext(sourceRef: string): DecodeContext {
  return { privacyKey: '', providerId: 'antigravity', sourceRef }
}

// Exported so the RPC-arm golden can assert the exact emitted shape without a
// live language server; every emit arm goes through this one mapper.
export function toProviderCall(rich: AntigravityDecodedCall, project?: string): ParsedProviderCall {
  return {
    provider: 'antigravity',
    model: rich.model,
    inputTokens: rich.inputTokens,
    outputTokens: rich.outputTokens,
    cacheCreationInputTokens: rich.cacheCreationInputTokens,
    cacheReadInputTokens: rich.cacheReadInputTokens,
    cachedInputTokens: rich.cachedInputTokens,
    reasoningTokens: rich.reasoningTokens,
    webSearchRequests: rich.webSearchRequests,
    // Whitelisted for cost persistence: the pass prices `pricingModel` (which
    // strips suffixes / applies aliases) and the result is stored verbatim, so
    // the display `model` never reaches the price table. reasoning is billed at
    // the output rate (outputTokens + reasoningTokens), matching the lift.
    costBasis: 'estimated',
    pricingModel: normalizePricingModel(rich.model),
    tools: [],
    bashCommands: [],
    timestamp: rich.timestamp,
    speed: rich.speed,
    deduplicationKey: rich.deduplicationKey,
    userMessage: '',
    sessionId: rich.sessionId,
    ...(project !== undefined ? { project } : {}),
  }
}

async function parseSqliteGenMetadataCalls(filePath: string, cascadeId: string): Promise<ParsedProviderCall[]> {
  if (!filePath.toLowerCase().endsWith('.db')) return []
  if (!isSqliteAvailable()) return []

  let db: ReturnType<typeof openDatabase> | null = null
  try {
    db = openDatabase(filePath)
    const rows = db.query<{ idx: number; data: Uint8Array | string }>('SELECT idx, data FROM gen_metadata ORDER BY idx')
    const { calls } = decodeAntigravityGenMetadata({ records: rows, context: decodeContext(filePath), cascadeId })
    return calls.map(c => toProviderCall(c))
  } catch (err) {
    // Let a transient lock propagate so the run retries this file on the next
    // refresh instead of treating it as empty (see parser.ts busy handling).
    if (isSqliteBusyError(err)) throw err
    return []
  } finally {
    db?.close()
  }
}

export function antigravityCascadeIdFromPath(path: string): string {
  return basename(path).replace(/\.(pb|db)$/i, '')
}

function isConversationFile(file: string, extensions: readonly string[]): boolean {
  const lowerFile = file.toLowerCase()
  return extensions.some(ext => lowerFile.endsWith(ext))
}

export function isAntigravityStatusLineEventsPath(path: string): boolean {
  return path === getAntigravityStatusLineEventsPath()
}

export async function discoverAntigravitySessionSources(
  roots?: readonly AntigravityConversationRoot[],
): Promise<SessionSource[]> {
  // The statusline JSONL is a synthetic source only appended for the real
  // default roots, not when a caller passes an explicit (test) root set.
  const includeStatusLineEvents = roots === undefined
  const effectiveRoots = roots ?? conversationRoots()
  const sources: SessionSource[] = []
  for (const root of effectiveRoots) {
    let files: string[]
    try {
      files = await readdir(root.dir)
    } catch {
      continue
    }

    for (const file of files.sort()) {
      if (!isConversationFile(file, root.extensions)) continue
      const path = join(root.dir, file)
      const s = await stat(path).catch(() => null)
      if (!s?.isFile()) continue
      sources.push({
        path,
        project: root.project,
        provider: 'antigravity',
      })
    }
  }

  if (includeStatusLineEvents) {
    const statusLinePath = getAntigravityStatusLineEventsPath()
    const statusLineStat = await stat(statusLinePath).catch(() => null)
    if (statusLineStat?.isFile()) {
      sources.push({
        path: statusLinePath,
        project: 'antigravity-cli',
        provider: 'antigravity',
      })
    }
  }

  return sources
}

export async function recordAntigravityStatusLinePayload(input: unknown): Promise<boolean> {
  const event = parseAntigravityStatusLinePayload(input, new Date().toISOString())
  if (!event) return false

  const path = getAntigravityStatusLineEventsPath()
  await mkdir(getCacheDir(), { recursive: true, mode: 0o700 })
  const fd = await open(path, 'a', 0o600)
  try {
    await fd.appendFile(`${JSON.stringify(event)}\n`, { encoding: 'utf-8' })
  } finally {
    await fd.close()
  }
  return true
}

async function parseStatusLineCalls(source: SessionSource, seenKeys: Set<string>): Promise<ParsedProviderCall[]> {
  const raw = await readFile(source.path, 'utf-8').catch(() => '')
  const { calls } = decodeAntigravityStatusLine({
    records: raw.split(/\r?\n/),
    context: decodeContext(source.path),
    seenKeys,
  })
  return calls.map(c => toProviderCall(c, source.project))
}

export function shouldReparseAntigravitySource(path: string, cachedTurnCount: number): boolean {
  if (cachedTurnCount === 0) return true
  return isAntigravityStatusLineEventsPath(path)
}

async function findCascadeSource(cascadeId: string): Promise<SessionSource | null> {
  const sources = await discoverAntigravitySessionSources()
  return sources.find(source => {
    const lower = source.path.replace(/\\/g, '/').toLowerCase()
    return (lower.includes('/.gemini/antigravity-cli/') || lower.includes('/.gemini/antigravity-ide/')) &&
      antigravityCascadeIdFromPath(source.path) === cascadeId
  }) ?? null
}

export async function snapshotAntigravityStatusLinePayload(input: unknown): Promise<boolean> {
  const event = parseAntigravityStatusLinePayload(input, new Date().toISOString())
  if (!event) return false

  const cascadeId = event.conversationId
  const source = await findCascadeSource(cascadeId)
  if (!source) return false

  const s = await stat(source.path).catch(() => null)
  if (!s) return false

  const cache = await loadCache()
  const cached = cache.cascades[cascadeId]
  if (cached && cached.mtimeMs === s.mtimeMs && cached.sizeBytes === s.size && cached.calls.length > 0) {
    return true
  }

  const server = await detectServer(antigravityAppDataDirFromSourcePath(source.path))
  if (!server) return false

  let metadata: AntigravityGeneratorMetadata[]
  try {
    const modelMap = await getModelMap(server)
    metadata = extractAntigravityGeneratorMetadata(
      await rpc(server, 'GetCascadeTrajectoryGeneratorMetadata', { cascadeId }),
    )
    const snapshotCalls = decodeAntigravityGeneratorMetadata({
      records: metadata,
      context: decodeContext(source.path),
      cascadeId,
      modelMap,
    }).calls.map(c => toProviderCall(c))
    assignStableTimestamps(snapshotCalls, cached?.calls, new Date(s.mtimeMs).toISOString())
    cache.cascades[cascadeId] = {
      mtimeMs: s.mtimeMs,
      sizeBytes: s.size,
      calls: snapshotCalls,
    }
    cacheDirty = true
    await flushCache()
    return cache.cascades[cascadeId]!.calls.length > 0
  } catch {
    return false
  }
}

async function extractWorkspacePath(filePath: string): Promise<string | undefined> {
  let text = ''
  if (filePath.endsWith('.db') && isSqliteAvailable()) {
    try {
      const db = openDatabase(filePath)
      const rows = db.query<{ data: Uint8Array }>('SELECT data FROM trajectory_metadata_blob')
      db.close()
      const textDecoder = new TextDecoder('utf-8', { fatal: false })
      text = rows.map(r => textDecoder.decode(r.data)).join(' ')
    } catch { /* ignore and fallback */ }
  }

  if (!text) {
    try {
      text = await readFile(filePath, 'utf-8')
    } catch {
      return undefined
    }
  }

  const match = text.match(/file:\/\/\/[^\x00-\x1F\x7F"'\s]+/i)
  if (!match) return undefined

  try {
    return fileURLToPath(match[0])
  } catch {
    return undefined
  }
}

function sanitizeProject(path: string): string {
  return basename(path.replace(/\\/g, '/'))
}

function applyAntigravityProject(call: ParsedProviderCall, source: SessionSource, projectPath: string | undefined): void {
  if (source.project === 'antigravity-cli') {
    call.project = source.project
    delete call.projectPath
    return
  }

  if (projectPath) {
    call.projectPath = projectPath
    call.project = sanitizeProject(projectPath)
    return
  }

  call.project = source.project
}

// Sqlite rows and RPC entries without a real created_at timestamp carry no
// per-call timestamp. Left empty, those calls are dropped by the date-range
// filters in parser.ts (`if (!callTs) continue`), so each needs a fallback.
// The fallback must be *stable* across file rewrites: the generic session-cache
// persists whatever timestamp is emitted, and a non-durable source is cleared
// and reparsed whenever its mtime changes, so stamping the current mtime on
// every reparse would retro-date the whole session forward.
//
// assignStableTimestamps carries forward the timestamp already recorded for a
// dedup key (its first-seen time, held in the durable Antigravity cache) and
// only falls back to the current file mtime for genuinely new calls. Real
// timestamps (created_at) are preserved untouched. This runs on the fresh-parse
// paths whose result is written back to the cache.
function assignStableTimestamps(
  calls: ParsedProviderCall[],
  priorCalls: readonly ParsedProviderCall[] | undefined,
  firstSeenTimestamp: string,
): void {
  const priorByKey = new Map<string, string>()
  for (const prior of priorCalls ?? []) {
    if (prior.timestamp) priorByKey.set(prior.deduplicationKey, prior.timestamp)
  }
  for (const call of calls) {
    if (call.timestamp) continue
    call.timestamp = priorByKey.get(call.deduplicationKey) ?? firstSeenTimestamp
  }
}

// Emit-time safety net for cache-hit / cached-fallback paths, where the calls
// already carry stable timestamps from a prior parse. Applied to a copy so the
// cache is never mutated; only fills a still-empty timestamp defensively.
function withFallbackTimestamp(call: ParsedProviderCall, fallbackTimestamp: string): ParsedProviderCall {
  return call.timestamp ? call : { ...call, timestamp: fallbackTimestamp }
}

function createParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      if (isAntigravityStatusLineEventsPath(source.path)) {
        for (const call of await parseStatusLineCalls(source, seenKeys)) {
          seenKeys.add(call.deduplicationKey)
          yield call
        }
        return
      }

      const cascadeId = antigravityCascadeIdFromPath(source.path)
      const cache = await loadCache()

      const s = await stat(source.path).catch(() => null)
      if (!s) return

      const projectPath = await extractWorkspacePath(source.path)
      const fallbackTimestamp = new Date(s.mtimeMs).toISOString()

      const cached = cache.cascades[cascadeId]
      if (cached && cached.mtimeMs === s.mtimeMs && cached.sizeBytes === s.size && cached.calls.length > 0) {
        for (const call of cached.calls) {
          applyAntigravityProject(call, source, projectPath)
          if (seenKeys.has(call.deduplicationKey)) continue
          seenKeys.add(call.deduplicationKey)
          yield withFallbackTimestamp(call, fallbackTimestamp)
        }
        return
      }

      const sqliteResults = await parseSqliteGenMetadataCalls(source.path, cascadeId)
      if (sqliteResults.length > 0) {
        assignStableTimestamps(sqliteResults, cached?.calls, fallbackTimestamp)
        for (const call of sqliteResults) {
          applyAntigravityProject(call, source, projectPath)
        }

        cache.cascades[cascadeId] = {
          mtimeMs: s.mtimeMs,
          sizeBytes: s.size,
          calls: sqliteResults,
        }
        cacheDirty = true

        for (const call of sqliteResults) {
          if (seenKeys.has(call.deduplicationKey)) continue
          seenKeys.add(call.deduplicationKey)
          yield call
        }
        return
      }

      const server = await detectServer(antigravityAppDataDirFromSourcePath(source.path))
      if (!server) {
        if (cached) {
          for (const call of cached.calls) {
            applyAntigravityProject(call, source, projectPath)
            if (seenKeys.has(call.deduplicationKey)) continue
            seenKeys.add(call.deduplicationKey)
            yield withFallbackTimestamp(call, fallbackTimestamp)
          }
        }
        return
      }

      const modelMap = await getModelMap(server)

      let metadata: AntigravityGeneratorMetadata[]
      try {
        metadata = extractAntigravityGeneratorMetadata(
          await rpc(server, 'GetCascadeTrajectoryGeneratorMetadata', { cascadeId }),
        )
      } catch {
        if (cached) {
          for (const call of cached.calls) {
            applyAntigravityProject(call, source, projectPath)
            if (seenKeys.has(call.deduplicationKey)) continue
            seenKeys.add(call.deduplicationKey)
            yield withFallbackTimestamp(call, fallbackTimestamp)
          }
        }
        return
      }

      const results = decodeAntigravityGeneratorMetadata({
        records: metadata,
        context: decodeContext(source.path),
        cascadeId,
        modelMap,
      }).calls.map(c => toProviderCall(c))
      assignStableTimestamps(results, cached?.calls, fallbackTimestamp)
      for (const call of results) {
        applyAntigravityProject(call, source, projectPath)
      }

      cache.cascades[cascadeId] = {
        mtimeMs: s.mtimeMs,
        sizeBytes: s.size,
        calls: results,
      }
      cacheDirty = true

      for (const call of results) {
        if (seenKeys.has(call.deduplicationKey)) continue
        seenKeys.add(call.deduplicationKey)
        yield call
      }
    },
  }
}

const modelDisplayNames: Record<string, string> = {
  'gemini-pro-agent': 'Gemini Pro',
  'gemini-3-pro': 'Gemini 3 Pro',
  'gemini-3.1-pro-high': 'Gemini 3.1 Pro',
  'gemini-3.1-pro-low': 'Gemini 3.1 Pro (Low)',
  'gemini-3-flash': 'Gemini 3 Flash',
  'gemini-3-flash-agent': 'Gemini 3 Flash',
  'gemini-3.5-flash': 'Gemini 3.5 Flash',
  'gemini-3.5-flash-high': 'Gemini 3.5 Flash',
  'gemini-3.5-flash-medium': 'Gemini 3.5 Flash',
  'gemini-3.5-flash-low': 'Gemini 3.5 Flash',
  'Gemini 3.5 Flash (High)': 'Gemini 3.5 Flash',
  'Gemini 3.5 Flash (Medium)': 'Gemini 3.5 Flash',
  'Gemini 3.5 Flash (Low)': 'Gemini 3.5 Flash',
  'gemini-3.1-flash-image': 'Gemini 3.1 Flash',
  'gemini-3.1-flash-lite': 'Gemini 3.1 Flash Lite',
  'claude-opus-4-6-thinking': 'Opus 4.6',
  'claude-sonnet-4-6': 'Sonnet 4.6',
}

export function createAntigravityProvider(): Provider {
  return {
    name: 'antigravity',
    displayName: 'Antigravity',

    modelDisplayName(model: string): string {
      return modelDisplayNames[model] ?? model
    },

    toolDisplayName(rawTool: string): string {
      return rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      return discoverAntigravitySessionSources()
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createParser(source, seenKeys)
    },
  }
}

export async function flushAntigravityCache(liveCascadeIds?: Set<string>): Promise<void> {
  await flushCache(liveCascadeIds)
}

export const antigravity = createAntigravityProvider()
