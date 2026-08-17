import { readFile, mkdir, stat, open, rename, unlink } from 'fs/promises'
import { existsSync } from 'fs'
import { randomBytes } from 'crypto'
import { join, resolve } from 'path'
import { AsyncLocalStorage } from 'node:async_hooks'

import { getCodeburnCacheDir } from './cache-dir.js'
import type { ParsedProviderCall } from './providers/types.js'

// v4: attribute MCP calls emitted as event_msg/mcp_tool_call_end (issue #478).
// Recent Codex sessions cached under v3 dropped these, so force a re-parse.
// v5: also attribute CLI-wrapped MCP calls (`mcp-cli call server tool`) that
// Codex logs as a plain exec_command (issue #478 follow-up). Force a re-parse
// so sessions cached under v4 pick up the CLI-MCP attribution.
// v6/v7: rich-session-capture — per-call locAdded/locRemoved/editFailed from
// patch_apply_end. Sessions cached under v5 lack these fields; re-parse to add.
// v8: persist native MCP timing and compact invocation attribution.
const CODEX_CACHE_VERSION = 8
const CACHE_FILE = 'codex-results.json'

type FileFingerprint = { mtimeMs: number; sizeBytes: number }

type FileEntry = {
  mtimeMs: number
  sizeBytes: number
  project: string
  calls: ParsedProviderCall[]
}

type ResultCache = {
  version: number
  files: Record<string, FileEntry>
}

const cacheDirContext = new AsyncLocalStorage<string>()

function currentCacheDir(): string {
  return cacheDirContext.getStore() ?? resolve(getCodeburnCacheDir())
}

// A parse can cross many async boundaries before the Codex provider publishes
// its incremental cache. Embedded hosts are allowed to change the process env
// between calls, so pin the call-time directory for the whole transaction
// instead of re-reading CODEBURN_CACHE_DIR at each cache operation.
export function withCodexCacheDirectory<T>(cacheDir: string, operation: () => T): T {
  return cacheDirContext.run(resolve(cacheDir), operation)
}

function getCachePath(cacheDir: string): string {
  return join(cacheDir, CACHE_FILE)
}

// Embedded consumers can change CODEBURN_CACHE_DIR without reloading this
// module. Keep each directory's in-memory state separate so a warm cache (or an
// unflushed update) from A can never be read from or written into B.
const memCaches = new Map<string, ResultCache>()

// Dropped by the resident RSS guard. Every write is published by
// flushCodexCache() in the parse's finally, so the next load re-reads disk.
export function clearCodexMemCaches(): void {
  memCaches.clear()
}

async function loadCache(cacheDir: string): Promise<ResultCache> {
  const inMemory = memCaches.get(cacheDir)
  if (inMemory) return inMemory
  try {
    const raw = await readFile(getCachePath(cacheDir), 'utf-8')
    const cache = JSON.parse(raw) as ResultCache
    if (cache.version === CODEX_CACHE_VERSION && cache.files && typeof cache.files === 'object') {
      memCaches.set(cacheDir, cache)
      return cache
    }
  } catch {}
  const empty = { version: CODEX_CACHE_VERSION, files: {} }
  memCaches.set(cacheDir, empty)
  return empty
}

function getEntry(cache: ResultCache, filePath: string, fp: FileFingerprint): FileEntry | null {
  if (!Object.hasOwn(cache.files, filePath)) return null
  const entry = cache.files[filePath]
  if (entry && entry.mtimeMs === fp.mtimeMs && entry.sizeBytes === fp.sizeBytes) {
    return entry
  }
  return null
}

export async function readCachedCodexResults(
  filePath: string,
): Promise<ParsedProviderCall[] | null> {
  try {
    const s = await stat(filePath)
    const cache = await loadCache(currentCacheDir())
    const entry = getEntry(cache, filePath, { mtimeMs: s.mtimeMs, sizeBytes: s.size })
    return entry?.calls ?? null
  } catch {}
  return null
}

export async function getCachedCodexProject(
  filePath: string,
): Promise<string | null> {
  try {
    const s = await stat(filePath)
    const cache = await loadCache(currentCacheDir())
    const entry = getEntry(cache, filePath, { mtimeMs: s.mtimeMs, sizeBytes: s.size })
    return entry?.project ?? null
  } catch {}
  return null
}

export async function fingerprintFile(
  filePath: string,
): Promise<FileFingerprint | null> {
  try {
    const s = await stat(filePath)
    return { mtimeMs: s.mtimeMs, sizeBytes: s.size }
  } catch {
    return null
  }
}

export async function writeCachedCodexResults(
  filePath: string,
  project: string,
  calls: ParsedProviderCall[],
  fingerprint: FileFingerprint,
): Promise<void> {
  try {
    const cache = await loadCache(currentCacheDir())
    cache.files[filePath] = {
      mtimeMs: fingerprint.mtimeMs,
      sizeBytes: fingerprint.sizeBytes,
      project,
      calls,
    }
  } catch {}
}

export async function flushCodexCache(): Promise<void> {
  const cacheDir = currentCacheDir()
  const memCache = memCaches.get(cacheDir)
  if (!memCache) return
  try {
    // Evict entries for files that no longer exist on disk
    const paths = Object.keys(memCache.files)
    for (const p of paths) {
      try {
        await stat(p)
      } catch {
        delete memCache.files[p]
      }
    }

    if (!existsSync(cacheDir)) await mkdir(cacheDir, { recursive: true })
    const finalPath = getCachePath(cacheDir)
    const tempPath = `${finalPath}.${randomBytes(8).toString('hex')}.tmp`
    const payload = JSON.stringify(memCache)
    const handle = await open(tempPath, 'w', 0o600)
    try {
      await handle.writeFile(payload, { encoding: 'utf-8' })
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await rename(tempPath, finalPath)
    } catch (err) {
      try { await unlink(tempPath) } catch {}
      throw err
    }
  } catch {}
}
