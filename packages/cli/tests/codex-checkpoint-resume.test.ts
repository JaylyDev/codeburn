// Cold-vs-warm equivalence for the codex task_started checkpoint resume, at
// EVERY line split point of a rollout carrying two complete tasks (one with a
// function_call wait, one with an mcp_tool_call_end wait and two token_counts
// to split proportionally) plus a third task left OPEN at end of file.
//
// This is the gate the checkpoint design has to clear: an incremental parse of
// a growing rollout must produce exactly what a cold parse of the finished file
// produces — cost, tokens, turns AND timing. It mutation-kills both ways of
// getting the resume point wrong: replaying past the boundary (`callCount` not
// truncated, so the open task's calls are served stale and never re-derived)
// and resuming at end of file (the open task's window is lost, so its
// task_complete attributes nothing).
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdir, rm, writeFile, appendFile, stat, utimes } from 'fs/promises'
import { join } from 'path'
import { clearSessionCache, parseAllSessions } from '../src/parser.js'

const testRoot = vi.hoisted(() => {
  const root = `${process.env['TMPDIR'] || '/tmp'}/codex-ckpt-${process.pid}-${Date.now()}`
  process.env['HOME'] = `${root}/home`
  process.env['USERPROFILE'] = `${root}/home`
  process.env['CODEX_HOME'] = `${root}/codex`
  return root
})
const CODEX_HOME = join(testRoot, 'codex')
beforeEach(() => {
  process.env['HOME'] = join(testRoot, 'home')
  process.env['USERPROFILE'] = join(testRoot, 'home')
  process.env['CODEX_HOME'] = CODEX_HOME
  process.env['CODEBURN_CACHE_DIR'] = join(testRoot, 'cache')
})

afterAll(async () => { await rm(testRoot, { recursive: true, force: true }) })

const ts = (n: number) => new Date(Date.UTC(2026, 3, 14, 10, 0, 0) + n * 1000).toISOString()

// A rollout with: 2 complete tasks (one with a function_call tool wait, one
// with an mcp_tool_call_end wait) + a 3rd task left OPEN at EOF.
function buildLines(): string[] {
  const L: unknown[] = []
  L.push({ type: 'session_meta', timestamp: ts(0), payload: { session_id: 'sess-adv', model: 'gpt-5.5', cwd: '/Users/test/proj', originator: 'codex-cli' } })
  // --- task 1: 10s total, 3s function_call wait
  L.push({ type: 'event_msg', timestamp: ts(10), payload: { type: 'task_started' } })
  L.push({ type: 'response_item', timestamp: ts(11), payload: { type: 'function_call', call_id: 'c1', name: 'shell' } })
  L.push({ type: 'response_item', timestamp: ts(14), payload: { type: 'function_call_output', call_id: 'c1' } })
  L.push({ type: 'event_msg', timestamp: ts(15), payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 10, output_tokens: 100, reasoning_output_tokens: 20, total_tokens: 130 }, total_token_usage: { input_tokens: 10, output_tokens: 100, reasoning_output_tokens: 20, total_tokens: 130 } } } })
  L.push({ type: 'event_msg', timestamp: ts(20), payload: { type: 'task_complete', duration_ms: 10000 } })
  // --- task 2: 8s total, 2s mcp wait, TWO token_counts (proportional split)
  L.push({ type: 'event_msg', timestamp: ts(30), payload: { type: 'task_started' } })
  L.push({ type: 'event_msg', timestamp: ts(33), payload: { type: 'mcp_tool_call_end', duration_ms: 2000, invocation: { server: 's', tool: 't' } } })
  L.push({ type: 'event_msg', timestamp: ts(34), payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 5, output_tokens: 40, reasoning_output_tokens: 10, total_tokens: 55 }, total_token_usage: { input_tokens: 15, output_tokens: 140, reasoning_output_tokens: 30, total_tokens: 185 } } } })
  L.push({ type: 'event_msg', timestamp: ts(36), payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 5, output_tokens: 60, reasoning_output_tokens: 0, total_tokens: 65 }, total_token_usage: { input_tokens: 20, output_tokens: 200, reasoning_output_tokens: 30, total_tokens: 250 } } } })
  L.push({ type: 'event_msg', timestamp: ts(38), payload: { type: 'task_complete', duration_ms: 8000 } })
  // --- task 3: OPEN at EOF (task_started + tokens, no task_complete)
  L.push({ type: 'event_msg', timestamp: ts(50), payload: { type: 'task_started' } })
  L.push({ type: 'event_msg', timestamp: ts(52), payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 7, output_tokens: 70, reasoning_output_tokens: 5, total_tokens: 82 }, total_token_usage: { input_tokens: 27, output_tokens: 270, reasoning_output_tokens: 35, total_tokens: 332 } } } })
  return L.map(o => JSON.stringify(o))
}

type Shot = Record<string, unknown>

async function snapshot(): Promise<Shot> {
  clearSessionCache()
  const projects = await parseAllSessions()
  const mb: Record<string, unknown> = {}
  let turns = 0, cost = 0, outTok = 0, inTok = 0
  for (const p of projects) for (const s of p.sessions) {
    turns += (s.turns ?? []).length
    for (const [model, d] of Object.entries(s.modelBreakdown)) {
      const prev = (mb[model] as any) ?? { calls: 0, costUSD: 0, out: 0, activeDurationMs: 0, activeGeneratedTokens: 0, toolWaitMs: 0 }
      mb[model] = {
        calls: prev.calls + d.calls,
        costUSD: +(prev.costUSD + d.costUSD).toFixed(10),
        out: prev.out + d.tokens.outputTokens,
        activeDurationMs: +(prev.activeDurationMs + (d.activeDurationMs ?? 0)).toFixed(6),
        activeGeneratedTokens: prev.activeGeneratedTokens + (d.activeGeneratedTokens ?? 0),
        toolWaitMs: +(prev.toolWaitMs + (d.toolWaitMs ?? 0)).toFixed(6),
      }
      cost += d.costUSD; outTok += d.tokens.outputTokens; inTok += d.tokens.inputTokens
    }
  }
  return { modelBreakdown: mb, turns, cost: +cost.toFixed(10), outTok, inTok }
}

const SESSION_DIR = join(CODEX_HOME, 'sessions', '2026', '04', '14')
const CACHE_DIR = join(testRoot, 'cache')
const ROLLOUT = join(SESSION_DIR, 'rollout-2026-04-14T10-00-00-adv.jsonl')

// CODEX_HOME / CODEBURN_CACHE_DIR resolve at import time, so the roots stay
// fixed and each scenario wipes their CONTENTS instead of repointing them.
async function freshEnv(_tag: string) {
  await rm(SESSION_DIR, { recursive: true, force: true })
  await rm(CACHE_DIR, { recursive: true, force: true })
  await mkdir(SESSION_DIR, { recursive: true })
  await mkdir(CACHE_DIR, { recursive: true })
  return ROLLOUT
}

async function bump(file: string, n: number) {
  const t = new Date(Date.now() + n * 60_000)
  await utimes(file, t, t)
}

describe('codex checkpoint resume: warm append equals cold parse', () => {
  const lines = buildLines()

  it('cold full parse equals warm append parse at EVERY line split point', async () => {
    const f0 = await freshEnv('cold')
    await writeFile(f0, lines.join('\n') + '\n')
    const cold = await snapshot()
    expect((cold as any).outTok).toBeGreaterThan(0)
    // sanity: timing actually got attributed somewhere
    expect(Object.values((cold as any).modelBreakdown).some((d: any) => d.activeDurationMs > 0)).toBe(true)

    for (let split = 1; split < lines.length; split++) {
      const f = await freshEnv(`warm-${split}`)
      await writeFile(f, lines.slice(0, split).join('\n') + '\n')
      await snapshot()                                   // pass 1: prefix
      await appendFile(f, lines.slice(split).join('\n') + '\n')
      await bump(f, split + 1)
      const warm = await snapshot()                      // pass 2: appended tail
      expect({ split, warm }).toEqual({ split, warm: cold })
    }
  }, 300_000)

  it('cold full parse equals a THREE-pass incremental parse across both task boundaries', async () => {
    const f0 = await freshEnv('cold3')
    await writeFile(f0, lines.join('\n') + '\n')
    const cold = await snapshot()

    // Cuts that land mid-task on both appends, so every pass has to rebuild a
    // window it did not open. The full cross product adds ~90 more parses for
    // no extra mutation coverage.
    for (const [a, b] of [[4, 9], [3, 12], [9, 13]] as const) {
      const f = await freshEnv(`w3-${a}-${b}`)
      await writeFile(f, lines.slice(0, a).join('\n') + '\n')
      await snapshot()
      await appendFile(f, lines.slice(a, b).join('\n') + '\n'); await bump(f, 1)
      await snapshot()
      await appendFile(f, lines.slice(b).join('\n') + '\n'); await bump(f, 2)
      const warm = await snapshot()
      expect({ a, b, warm }).toEqual({ a, b, warm: cold })
    }
  }, 300_000)

  it('re-running warm twice is stable (idempotent)', async () => {
    const f = await freshEnv('stable')
    await writeFile(f, lines.slice(0, 9).join('\n') + '\n')
    await snapshot()
    await appendFile(f, lines.slice(9).join('\n') + '\n'); await bump(f, 1)
    const first = await snapshot()
    const second = await snapshot()
    expect(second).toEqual(first)
  }, 120_000)
})
