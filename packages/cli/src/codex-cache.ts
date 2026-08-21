import { readFile, mkdir, stat, open, rename, unlink } from 'fs/promises'
import { existsSync } from 'fs'
import { randomBytes } from 'crypto'
import { join } from 'path'
import { homedir } from 'os'

import type { CodexDecodeState } from '@codeburn/core/providers/codex'

import type { ParsedProviderCall } from './providers/types.js'

// v4: attribute MCP calls emitted as event_msg/mcp_tool_call_end (issue #478).
// v5: also attribute CLI-wrapped MCP calls (`mcp-cli call server tool`).
// v6: rich-session-capture — per-call locAdded/locRemoved/editFailed.
// v7: (interim) unchanged decoder output shape.
// v8 (phase 4, issue #809): the decoder moved to @codeburn/core as a pure
// function over EXPLICIT serializable state, and cost now leaves the decoder.
// The persisted format changes accordingly and is bumped once, deliberately:
//   - `calls` are HOST-PRICED ParsedProviderCall (costBasis:'estimated',
//     costUSD filled by the pricing pass) instead of self-priced decoder output.
//   - `state` is the decoder's end-of-file CodexDecodeState (its per-session
//     streaming locals — running token counters, mid-turn accumulators, id/turn
//     bookkeeping). `seenKeys` is stripped: cross-file dedup is reconstructed
//     each run from the session cache, exactly as the pre-phase-4 shared set was.
//   - `byteOffset` is the byte position after the last complete line consumed,
//     so a grown (appended-to) rollout resumes from `state`+`byteOffset` and
//     decodes only the new bytes instead of re-streaming the whole file.
// This is lossless: Codex rollout files are durable (never auto-deleted), so the
// one-time re-derive on first run under v8 rebuilds byte-identical data.
//
// #926's structural-validation guards change decode behavior only for record
// shapes measured at 0 occurrences across 136k real events, so forcing a full
// re-parse of multi-GB rollout corpora over that is a bad trade — deliberately
// NOT bumped. The daily-cache bump alone propagates the discovery widening:
// newly-eligible files aren't in this cache yet and parse fresh regardless.
//
// v12: tool-excluded active timing. Every cached call can now carry
// activeDurationMs / activeGeneratedTokens / toolWaitMs, the stored `state` can
// carry the task-boundary window flag, and `callCount` marks how much of
// `calls` a resumed decode may replay (the rest re-derives from the last
// task_started). Cached entries have none of that, so bump once and let
// unchanged sessions re-decode. This takes 12 rather than 9: main's own ladder
// has since reached 11 (#1078), and a shared version number on two different
// payload shapes would let a cache written by either line be read as current by
// the other.
//
// v13: the #1075/#1078 codex pricing fix, ported here (#1083). Every cached
// call carries `costUSD` verbatim and its token buckets, so v12 entries hold
// costs with reasoning double-counted and cache writes never carved out of
// input; the stored `state` also lacks `prevCacheWrite`. Bump once and let
// unchanged sessions re-decode.
const CODEX_CACHE_VERSION = 13
const CACHE_FILE = 'codex-results.json'

type FileFingerprint = { mtimeMs: number; sizeBytes: number }

type FileEntry = {
  mtimeMs: number
  sizeBytes: number
  project: string
  // Resume point: the byte offset after the last `task_started` line this file
  // decoded past, with `state` snapshotted there and `callCount` counting the
  // calls emitted before it. An appended tail resumes from that boundary and
  // re-derives the calls beyond it, so a task whose task_complete lands in the
  // appended region gets its timing from a whole re-read window instead of a
  // patch applied to calls already served.
  byteOffset: number
  state: CodexDecodeState
  callCount: number
  calls: ParsedProviderCall[]
}

type ResultCache = {
  version: number
  files: Record<string, FileEntry>
}

function getCacheDir(): string {
  return process.env['CODEBURN_CACHE_DIR'] ?? join(homedir(), '.cache', 'codeburn')
}

function getCachePath(): string {
  return join(getCacheDir(), CACHE_FILE)
}

let memCache: ResultCache | null = null

async function loadCache(): Promise<ResultCache> {
  if (memCache) return memCache
  try {
    const raw = await readFile(getCachePath(), 'utf-8')
    const cache = JSON.parse(raw) as ResultCache
    if (cache.version === CODEX_CACHE_VERSION && cache.files && typeof cache.files === 'object') {
      memCache = cache
      return cache
    }
  } catch {}
  memCache = { version: CODEX_CACHE_VERSION, files: {} }
  return memCache
}

export async function getCachedCodexProject(
  filePath: string,
): Promise<string | null> {
  try {
    const s = await stat(filePath)
    const cache = await loadCache()
    if (!Object.hasOwn(cache.files, filePath)) return null
    const entry = cache.files[filePath]
    if (entry && entry.mtimeMs === s.mtimeMs && entry.sizeBytes === s.size) {
      return entry.project
    }
  } catch {}
  return null
}

// The stored decode for a file, WITHOUT fingerprint gating: the caller compares
// the current fingerprint against `mtimeMs`/`sizeBytes` to decide exact-hit
// (serve `calls`), append-resume (file grew — decode from `byteOffset`+`state`),
// or cold re-decode.
export async function readCodexCacheEntry(
  filePath: string,
): Promise<FileEntry | null> {
  try {
    const cache = await loadCache()
    if (!Object.hasOwn(cache.files, filePath)) return null
    return cache.files[filePath] ?? null
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

export async function writeCodexCacheEntry(
  filePath: string,
  entry: FileEntry,
): Promise<void> {
  try {
    const cache = await loadCache()
    cache.files[filePath] = entry
  } catch {}
}

export async function flushCodexCache(): Promise<void> {
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

    const dir = getCacheDir()
    if (!existsSync(dir)) await mkdir(dir, { recursive: true })
    const finalPath = getCachePath()
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

export type { FileEntry as CodexCacheEntry, FileFingerprint as CodexFileFingerprint }
