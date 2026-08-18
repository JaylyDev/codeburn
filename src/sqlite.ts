import { createRequire } from 'node:module'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'

import { getCodeburnCacheDir } from './cache-dir.js'

/// Thin SQLite read-only wrapper over Node's built-in `node:sqlite` module (stable in
/// Node 24, experimental in Node 22 / 23). Replaces the earlier `better-sqlite3` binding
/// so the dependency graph no longer pulls in the deprecated `prebuild-install` package
/// (issue #75). Works across Cursor and OpenCode session DBs, both of which we only read.

const requireForSqlite = createRequire(import.meta.url)

type Row = Record<string, unknown>

export type SqliteDatabase = {
  query<T extends Row = Row>(sql: string, params?: unknown[]): T[]
  close(): void
}

type DatabaseSyncInstance = {
  prepare(sql: string): { all(...params: unknown[]): Row[] }
  exec?(sql: string): void
  close(): void
}

type DatabaseSyncCtor = new (path: string, options?: { readOnly?: boolean }) => DatabaseSyncInstance

let DatabaseSync: DatabaseSyncCtor | null = null
let loadAttempted = false
let loadError: string | null = null

const textDecoder = new TextDecoder('utf-8', { fatal: false })

/// Safely decode a BLOB column (Uint8Array) to a UTF-8 string. Node's
/// node:sqlite crashes with a V8 CHECK abort when a TEXT column contains
/// invalid UTF-8 (common in Cursor chat blobs with truncated multi-byte
/// chars). By selecting those columns as `CAST(... AS BLOB)` in SQL, we
/// get a Uint8Array here and decode it in JS where bad bytes become the
/// U+FFFD replacement character instead of aborting the process.
export function blobToText(value: Uint8Array | string | null | undefined): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  return textDecoder.decode(value)
}

/// Lazily imports `node:sqlite`. On Node 22/23 it emits an ExperimentalWarning the first
/// time the module is loaded; we silence that specific warning once so dashboards aren't
/// preceded by a scary stderr line every run. Any other warnings (including future
/// non-SQLite ones) are left untouched.
function loadDriver(): boolean {
  if (loadAttempted) return DatabaseSync !== null
  loadAttempted = true

  const origEmit = process.emit.bind(process)
  let restored = false
  const restore = () => {
    if (restored) return
    restored = true
    process.emit = origEmit
  }

  // Node's `process.emit` signature is overloaded; we intercept the 'warning' channel
  // only and proxy everything else through unchanged. The `any` cast avoids chasing the
  // overload union which isn't worth its verbosity for a single-purpose shim.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.emit = function patchedEmit(this: NodeJS.Process, event: string, ...args: any[]): boolean {
    if (event === 'warning') {
      const warning = args[0] as { name?: string; message?: string } | undefined
      if (
        warning?.name === 'ExperimentalWarning' &&
        typeof warning.message === 'string' &&
        /SQLite/i.test(warning.message)
      ) {
        return false
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (origEmit as any).call(this, event, ...args)
  } as typeof process.emit

  try {
    const mod = requireForSqlite('node:sqlite') as { DatabaseSync: DatabaseSyncCtor }
    DatabaseSync = mod.DatabaseSync
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    loadError =
      'SQLite-based providers (Cursor, OpenCode) need Node 22+ with the node:sqlite module.\n' +
      `Current Node: ${process.version}.\n` +
      'Upgrade Node (https://nodejs.org) and run codeburn again.\n' +
      `(underlying error: ${message})`
    return false
  } finally {
    process.nextTick(restore)
  }
}

export function isSqliteAvailable(): boolean {
  return loadDriver()
}

export function getSqliteLoadError(): string {
  return loadError ?? 'SQLite driver not available'
}

export function isSqliteBusyError(err: unknown): boolean {
  const e = err as { code?: unknown; errcode?: unknown; errstr?: unknown; message?: unknown } | null
  const code = typeof e?.code === 'string' ? e.code : ''
  const errcode = typeof e?.errcode === 'number' ? e.errcode : null
  const message = [
    typeof e?.message === 'string' ? e.message : '',
    typeof e?.errstr === 'string' ? e.errstr : '',
  ].join(' ')

  return (
    errcode === 5 ||
    errcode === 6 ||
    code === 'SQLITE_BUSY' ||
    code === 'SQLITE_LOCKED' ||
    /\bSQLITE_(BUSY|LOCKED)\b|database (?:is |table is )?locked/i.test(message)
  )
}

/// SQLite reports SQLITE_READONLY_DIRECTORY as ERR_SQLITE_ERROR with an extended
/// result code on the Node 22 builds CodeBurn supports. Keep the base-code check
/// so this also covers SQLITE_READONLY and its other extended variants, while
/// leaving ENOENT/SQLITE_CANTOPEN distinguishable to callers.
export function isSqliteReadonlyError(err: unknown): boolean {
  const e = err as { code?: unknown; errcode?: unknown; errstr?: unknown; message?: unknown } | null
  const code = typeof e?.code === 'string' ? e.code : ''
  const errcode = typeof e?.errcode === 'number' ? e.errcode : null
  const message = [
    typeof e?.message === 'string' ? e.message : '',
    typeof e?.errstr === 'string' ? e.errstr : '',
  ].join(' ')

  return (
    (errcode !== null && (errcode & 0xff) === 8) ||
    /SQLITE_READONLY|attempt to write a readonly database|readonly database|read-only database/i.test(`${code} ${message}`)
  )
}

/// A read-only parent reports SQLITE_READONLY_DIRECTORY when it must create the
/// sidecars from scratch, but SQLITE_CANTOPEN when a `-wal` is present and the
/// `-shm` it needs to index it is not. openReadonlyCache re-throws the original
/// error when the database itself is missing, which is the other CANTOPEN.
function isSqliteSidecarError(err: unknown): boolean {
  if (isSqliteReadonlyError(err)) return true
  const errcode = (err as { errcode?: unknown } | null)?.errcode
  return typeof errcode === 'number' && (errcode & 0xff) === 14
}

type DatabaseFingerprint = {
  dev: number
  ino: number
  mtimeMs: number
  sizeBytes: number
}

type CachedDatabaseMetadata = {
  version: number
  sourcePath: string
  fingerprint: DatabaseFingerprint
}

const SQLITE_CACHE_VERSION = 1
const warnedReadonlyDatabases = new Set<string>()

/// A read-only SQLite connection can still need sidecar files. This notice is
/// intentionally once per source path: a provider may discover many sessions
/// from the same database, and the fallback is already doing the useful work.
export function warnSqliteReadonlyOnce(path: string): void {
  if (warnedReadonlyDatabases.has(path)) return
  warnedReadonlyDatabases.add(path)
  process.stderr.write(
    `codeburn: SQLite database ${path} is in a read-only directory and needs sidecar files; using a cache copy when necessary. ` +
    'The original database is not modified.\n',
  )
}

function errorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined
  const code = err.code
  return typeof code === 'string' ? code : undefined
}

/// This deliberately mirrors fingerprintSqliteFile/fingerprintFile in
/// session-cache.ts. openDatabase is synchronous, so the fallback uses the
/// synchronous fs APIs only after the direct open has already failed; the
/// ordinary successful open remains probe-free.
function fingerprintDatabase(path: string): DatabaseFingerprint {
  const main = statSync(path)
  let wal: ReturnType<typeof statSync> | null = null
  try {
    wal = statSync(path + '-wal')
  } catch (err) {
    if (errorCode(err) !== 'ENOENT') throw err
  }
  return {
    dev: main.dev,
    ino: main.ino,
    mtimeMs: wal ? Math.max(main.mtimeMs, wal.mtimeMs) : main.mtimeMs,
    sizeBytes: main.size + (wal?.size ?? 0),
  }
}

function sameFingerprint(a: DatabaseFingerprint, b: DatabaseFingerprint): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mtimeMs === b.mtimeMs &&
    a.sizeBytes === b.sizeBytes
  )
}

function isDatabaseFingerprint(value: unknown): value is DatabaseFingerprint {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<DatabaseFingerprint>
  return (
    typeof candidate.dev === 'number' &&
    typeof candidate.ino === 'number' &&
    typeof candidate.mtimeMs === 'number' &&
    typeof candidate.sizeBytes === 'number'
  )
}

function readCachedMetadata(path: string): CachedDatabaseMetadata | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    const candidate = parsed as { version?: unknown; sourcePath?: unknown; fingerprint?: unknown }
    if (
      candidate.version !== SQLITE_CACHE_VERSION ||
      typeof candidate.sourcePath !== 'string' ||
      !isDatabaseFingerprint(candidate.fingerprint)
    ) return null
    return { version: SQLITE_CACHE_VERSION, sourcePath: candidate.sourcePath, fingerprint: candidate.fingerprint }
  } catch {
    return null
  }
}

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path)
  } catch (err) {
    if (errorCode(err) !== 'ENOENT') throw err
  }
}

function copyOptionalFile(sourcePath: string, destinationPath: string): boolean {
  try {
    copyFileSync(sourcePath, destinationPath)
    return true
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return false
    throw err
  }
}

function readOnlyCachePath(sourcePath: string, fingerprint: DatabaseFingerprint): string {
  const cacheDir = join(getCodeburnCacheDir(), 'sqlite-ro')
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 })

  const sourceKey = createHash('sha256').update(sourcePath, 'utf8').digest('hex')
  const cachePath = join(cacheDir, `${sourceKey}.db`)
  const metadataPath = `${cachePath}.json`
  const cached = readCachedMetadata(metadataPath)
  if (
    existsSync(cachePath) &&
    cached?.sourcePath === sourcePath &&
    sameFingerprint(cached.fingerprint, fingerprint)
  ) {
    return cachePath
  }

  const tempBase = `${cachePath}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`
  const tempWal = tempBase + '-wal'
  const tempMetadata = `${metadataPath}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`

  try {
    copyFileSync(sourcePath, tempBase)
    const copiedWal = copyOptionalFile(sourcePath + '-wal', tempWal)

    // Do not publish a cache made from a moving database. A live WAL writer will
    // normally make the direct open succeed once its sidecars exist; this check
    // covers the narrow race where the source changes during the copy fallback.
    if (!sameFingerprint(fingerprintDatabase(sourcePath), fingerprint)) {
      throw new Error('SQLite database changed while preparing its read-only cache copy')
    }

    unlinkIfPresent(cachePath)
    unlinkIfPresent(cachePath + '-wal')
    unlinkIfPresent(cachePath + '-shm')
    renameSync(tempBase, cachePath)
    if (copiedWal) renameSync(tempWal, cachePath + '-wal')

    const metadata: { version: number; sourcePath: string; fingerprint: DatabaseFingerprint } = {
      version: SQLITE_CACHE_VERSION,
      sourcePath,
      fingerprint,
    }
    writeFileSync(tempMetadata, JSON.stringify(metadata), { encoding: 'utf8', mode: 0o600 })
    renameSync(tempMetadata, metadataPath)
    return cachePath
  } finally {
    unlinkIfPresent(tempBase)
    unlinkIfPresent(tempWal)
    unlinkIfPresent(tempMetadata)
  }
}

function openReadonlyCache(path: string, originalError: unknown): DatabaseSyncInstance {
  let fingerprint: DatabaseFingerprint
  try {
    fingerprint = fingerprintDatabase(path)
  } catch {
    // Preserve the original SQLite error when the source disappeared or became
    // inaccessible between the failed query and the fallback probe.
    throw originalError
  }
  const cachedPath = readOnlyCachePath(path, fingerprint)
  const Driver = DatabaseSync
  if (Driver === null) throw new Error(getSqliteLoadError())
  return new Driver(cachedPath, { readOnly: true })
}

export function openDatabase(path: string): SqliteDatabase {
  if (!loadDriver() || DatabaseSync === null) {
    throw new Error(getSqliteLoadError())
  }

  let db: DatabaseSyncInstance
  let fallbackUsed = false
  try {
    db = new DatabaseSync(path, { readOnly: true })
  } catch (err) {
    if (!isSqliteSidecarError(err)) throw err
    fallbackUsed = true
    db = openReadonlyCache(path, err)
    warnSqliteReadonlyOnce(path)
  }
  try {
    db.exec?.('PRAGMA busy_timeout = 1000')
  } catch {
    // Best effort. Some Node sqlite builds may not expose exec on DatabaseSync.
  }

  return {
    query<T extends Row = Row>(sql: string, params: unknown[] = []): T[] {
      try {
        return db.prepare(sql).all(...params) as T[]
      } catch (err) {
        if (!isSqliteSidecarError(err)) throw err
        if (fallbackUsed) throw err
        fallbackUsed = true
        try {
          db.close()
        } catch {
          // The failed connection may already have been closed by node:sqlite.
        }
        db = openReadonlyCache(path, err)
        warnSqliteReadonlyOnce(path)
        try {
          db.exec?.('PRAGMA busy_timeout = 1000')
        } catch {
          // Best effort, matching the direct-open path above.
        }
        return db.prepare(sql).all(...params) as T[]
      }
    },
    close() {
      db.close()
    },
  }
}
