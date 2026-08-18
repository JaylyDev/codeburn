import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  isSqliteReadonlyError,
  openDatabase,
} from '../src/sqlite.js'
import {
  discoverSqliteSessions,
  type SqliteProviderConfig,
} from '../src/providers/sqlite-session-parser.js'

const requireForTest = createRequire(import.meta.url)

type NativeDatabase = {
  exec(sql: string): void
  prepare(sql: string): { run(...params: unknown[]): void; all(...params: unknown[]): unknown[] }
  close(): void
}

type NativeDatabaseCtor = new (path: string) => NativeDatabase

const { DatabaseSync: NativeDatabase } = requireForTest('node:sqlite') as {
  DatabaseSync: NativeDatabaseCtor
}

let sourceRoot: string
let cacheRoot: string
let previousCacheDir: string | undefined
const openWriters: NativeDatabase[] = []

beforeEach(async () => {
  sourceRoot = await mkdtemp(join(tmpdir(), 'codeburn-sqlite-source-'))
  cacheRoot = await mkdtemp(join(tmpdir(), 'codeburn-sqlite-cache-'))
  previousCacheDir = process.env['CODEBURN_CACHE_DIR']
  process.env['CODEBURN_CACHE_DIR'] = cacheRoot
})

afterEach(async () => {
  chmodSync(sourceRoot, 0o755)
  for (const writer of openWriters.splice(0)) writer.close()
  await rm(sourceRoot, { recursive: true, force: true })
  await rm(cacheRoot, { recursive: true, force: true })
  if (previousCacheDir === undefined) delete process.env['CODEBURN_CACHE_DIR']
  else process.env['CODEBURN_CACHE_DIR'] = previousCacheDir
})

function createClosedWalDatabase(dbPath: string): void {
  const db = new NativeDatabase(dbPath)
  db.exec('PRAGMA journal_mode=WAL')
  db.exec('CREATE TABLE values_table (c INTEGER)')
  db.prepare('INSERT INTO values_table (c) VALUES (?)').run(1)
  db.close()
}

function createOpenWalDatabase(dbPath: string): NativeDatabase {
  const db = new NativeDatabase(dbPath)
  db.exec('PRAGMA journal_mode=WAL')
  db.exec('CREATE TABLE values_table (c INTEGER)')
  db.prepare('INSERT INTO values_table (c) VALUES (?)').run(1)
  expect(existsSync(dbPath + '-wal')).toBe(true)
  expect(existsSync(dbPath + '-shm')).toBe(true)
  openWriters.push(db)
  return db
}

function createDiscoveryDatabase(dbPath: string): void {
  const db = new NativeDatabase(dbPath)
  db.exec('PRAGMA journal_mode=WAL')
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      directory TEXT,
      title TEXT,
      time_created INTEGER,
      parent_id TEXT,
      time_archived INTEGER
    )
  `)
  db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data BLOB)')
  db.exec('CREATE TABLE part (id INTEGER PRIMARY KEY, message_id TEXT, session_id TEXT, data BLOB)')
  db.prepare(
    'INSERT INTO session (id, directory, title, time_created, parent_id, time_archived) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('session-1', '/tmp/project', 'Read-only fixture', Date.now(), null, null)
  db.close()
}

function makeSourceParentReadOnly(skip: (reason?: string) => void): boolean {
  chmodSync(sourceRoot, 0o555)
  const mode = statSync(sourceRoot).mode & 0o777
  if ((mode & 0o222) !== 0) {
    skip(`SKIP: chmod 0555 did not make the fixture parent non-writable (mode ${mode.toString(8)})`)
    return false
  }
  return true
}

function cachedDatabaseFiles(): string[] {
  try {
    return readdirSync(join(cacheRoot, 'sqlite-ro')).filter(name => name.endsWith('.db'))
  } catch {
    return []
  }
}

function readValue(dbPath: string): number {
  const db = openDatabase(dbPath)
  try {
    const rows = db.query<{ c: number }>('SELECT c FROM values_table')
    return rows[0]?.c ?? -1
  } finally {
    db.close()
  }
}

describe('SQLite read-only parent fallback', () => {
  it('keeps the existing writable-parent open behaviour', () => {
    const dbPath = join(sourceRoot, 'state.vscdb')
    createClosedWalDatabase(dbPath)
    expect(existsSync(dbPath + '-wal')).toBe(false)
    expect(existsSync(dbPath + '-shm')).toBe(false)

    expect(readValue(dbPath)).toBe(1)

    expect(existsSync(dbPath + '-wal')).toBe(true)
    expect(existsSync(dbPath + '-shm')).toBe(true)
    expect(cachedDatabaseFiles()).toEqual([])
  })

  it('reads a WAL database when the parent is read-only and sidecars are absent', ({ skip }) => {
    const dbPath = join(sourceRoot, 'state.vscdb')
    createClosedWalDatabase(dbPath)
    expect(existsSync(dbPath + '-wal')).toBe(false)
    expect(existsSync(dbPath + '-shm')).toBe(false)
    if (!makeSourceParentReadOnly(skip)) return

    expect(readValue(dbPath)).toBe(1)

    expect(existsSync(dbPath + '-wal')).toBe(false)
    expect(existsSync(dbPath + '-shm')).toBe(false)
    expect(cachedDatabaseFiles()).toHaveLength(1)
  })

  it('opens directly when a read-only parent already has WAL sidecars', ({ skip }) => {
    const dbPath = join(sourceRoot, 'state.vscdb')
    createOpenWalDatabase(dbPath)
    if (!makeSourceParentReadOnly(skip)) return

    expect(readValue(dbPath)).toBe(1)
    expect(cachedDatabaseFiles()).toEqual([])
  })

  it('reuses an unchanged fallback copy instead of copying the database again', ({ skip }) => {
    const dbPath = join(sourceRoot, 'state.vscdb')
    createClosedWalDatabase(dbPath)
    if (!makeSourceParentReadOnly(skip)) return

    expect(readValue(dbPath)).toBe(1)
    const cachedPath = join(cacheRoot, 'sqlite-ro', cachedDatabaseFiles()[0]!)
    const firstMtime = statSync(cachedPath).mtimeMs
    expect(readValue(dbPath)).toBe(1)
    expect(statSync(cachedPath).mtimeMs).toBe(firstMtime)
  })

  it('keeps a genuinely missing database distinguishable from SQLITE_READONLY', () => {
    let thrown: unknown
    try {
      openDatabase(join(sourceRoot, 'missing.vscdb'))
    } catch (err) {
      thrown = err
    }

    expect(thrown).toBeDefined()
    expect(isSqliteReadonlyError(thrown)).toBe(false)
    expect(thrown).toMatchObject({ errcode: 14, message: 'unable to open database file' })
  })

  it('surfaces one read-only notice in SQLite discovery and still finds the session', async ({ skip }) => {
    const dbPath = join(sourceRoot, 'state.db')
    createDiscoveryDatabase(dbPath)
    if (!makeSourceParentReadOnly(skip)) return

    const config: SqliteProviderConfig = {
      providerName: 'opencode',
      displayName: 'OpenCode',
      dbDir: sourceRoot,
      dbFilePrefix: 'state',
    }
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    try {
      const sessions = await discoverSqliteSessions(config)
      expect(sessions).toHaveLength(1)
      expect(sessions[0]?.path).toBe(`${dbPath}:session-1`)
      expect(stderr.mock.calls.filter(([chunk]) => String(chunk).includes('read-only directory'))).toHaveLength(1)

      await discoverSqliteSessions(config)
      expect(stderr.mock.calls.filter(([chunk]) => String(chunk).includes('read-only directory'))).toHaveLength(1)
    } finally {
      stderr.mockRestore()
    }
  })
})
