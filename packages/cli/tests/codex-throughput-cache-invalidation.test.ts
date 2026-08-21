// Regression for the stale-cache path of the codex active-timing port (same
// class as #478/#618). Two caches serve a codex session without ever invoking
// the decoder: session-cache.json (per provider, gated by envFingerprint) and
// codex-results.json (per file, gated by CODEX_CACHE_VERSION). A user upgrading
// into this change has both warm and both timing-less, so unless BOTH gates
// move, the dashboard's Tok/s column stays empty on every unchanged session
// forever. This drives the full parseAllSessions pipeline against caches seeded
// exactly as the pre-change release left them.
//
// Revert-proof: drop the `-active-timing-v1` suffix from the codex entry in
// PROVIDER_PARSE_VERSIONS and the seeded fingerprint matches again, the stale
// section is served, and the assertion below fails.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdir, rm, readFile, writeFile } from 'fs/promises'
import { createHash } from 'crypto'
import { join } from 'path'

import { clearSessionCache, parseAllSessions } from '../src/parser.js'
import { sessionCachePath } from '../src/session-cache.js'

const testRoot = vi.hoisted(() => {
  const root = `${process.env['TMPDIR'] || '/tmp'}/codex-timing-stale-${process.pid}-${Date.now()}`
  process.env['HOME'] = `${root}/home`
  process.env['USERPROFILE'] = `${root}/home`
  process.env['CODEX_HOME'] = `${root}/codex`
  return root
})

const CODEX_HOME = join(testRoot, 'codex')
const CACHE_DIR = join(testRoot, 'cache')

// computeEnvFingerprint('codex') as the pre-change release computed it: the
// same CODEX_HOME, the same parse version minus this change's suffix.
const PRE_CHANGE_PARSE_VERSION = 'mcp-attribution-v2-est-cost-rich-capture-v1-cross-provider-pr-v1'

function preChangeFingerprint(): string {
  const parts = [`CODEX_HOME=${CODEX_HOME}`, `parser=${PRE_CHANGE_PARSE_VERSION}`]
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16)
}

beforeEach(() => {
  process.env['HOME'] = join(testRoot, 'home')
  process.env['USERPROFILE'] = join(testRoot, 'home')
  process.env['CODEX_HOME'] = CODEX_HOME
  process.env['CODEBURN_CACHE_DIR'] = CACHE_DIR
})

afterAll(async () => {
  await rm(testRoot, { recursive: true, force: true })
})

function timingTotals(projects: Awaited<ReturnType<typeof parseAllSessions>>): number[] {
  return projects.flatMap(p => p.sessions.flatMap(s => Object.values(s.modelBreakdown).map(m => m.activeDurationMs ?? 0)))
}

describe('codex active-timing invalidates both stale caches', () => {
  it('re-parses an unchanged codex file cached by the pre-change release', async () => {
    const sessionDir = join(CODEX_HOME, 'sessions', '2026', '04', '14')
    await mkdir(sessionDir, { recursive: true })
    await mkdir(CACHE_DIR, { recursive: true })
    const lines = [
      JSON.stringify({ type: 'session_meta', timestamp: '2026-04-14T10:00:00Z', payload: { session_id: 'sess-timing-stale', model: 'gpt-5.5', cwd: '/Users/test/proj', originator: 'codex_cli_rs' } }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-04-14T10:00:00Z', payload: { type: 'task_started' } }),
      JSON.stringify({ type: 'response_item', timestamp: '2026-04-14T10:00:01Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run it' }] } }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-04-14T10:00:08Z', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 300, output_tokens: 100 }, total_token_usage: { total_tokens: 400 } } } }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-04-14T10:00:10Z', payload: { type: 'task_complete', duration_ms: 10_000 } }),
    ]
    await writeFile(join(sessionDir, 'rollout-timing-stale.jsonl'), lines.join('\n') + '\n')

    // Run 1: cold cache, current code. Timing present (sanity).
    clearSessionCache()
    const fresh = await parseAllSessions(undefined, 'codex')
    expect(timingTotals(fresh)).toEqual([10_000])

    // Rewrite both caches as the pre-change release left them: the old provider
    // envFingerprint, the old codex-results version, and cached calls/turns
    // with no timing at all. The rollout file itself is untouched, so nothing
    // but the two version gates can trigger a re-parse.
    const cachePath = sessionCachePath()
    const cache = JSON.parse(await readFile(cachePath, 'utf8'))
    cache.providers.codex.envFingerprint = preChangeFingerprint()
    for (const f of Object.values(cache.providers.codex.files) as any[]) {
      for (const turn of f.turns) {
        for (const call of turn.calls) {
          delete call.activeDurationMs
          delete call.activeGeneratedTokens
          delete call.toolWaitMs
        }
      }
    }
    await writeFile(cachePath, JSON.stringify(cache))

    const codexCachePath = join(CACHE_DIR, 'codex-results.json')
    const codexCache = JSON.parse(await readFile(codexCachePath, 'utf8'))
    codexCache.version = 8
    for (const f of Object.values(codexCache.files) as any[]) {
      for (const call of f.calls ?? []) {
        delete call.activeDurationMs
        delete call.activeGeneratedTokens
        delete call.toolWaitMs
      }
    }
    await writeFile(codexCachePath, JSON.stringify(codexCache))

    clearSessionCache()
    const second = await parseAllSessions(undefined, 'codex')
    expect(timingTotals(second)).toEqual([10_000])
  })
})
