#!/usr/bin/env node
// Deterministic 30MB-class synthetic session corpus for the performance harness.
// Sanitized fake paths and lorem content only. Never copies real user sessions.
//
//   node scripts/perf/gen-fixture.mjs --home <isolated-home> [--target-mb 30]
//
// Layout matches provider default paths under HOME so the harness only has to
// set HOME + CODEBURN_CACHE_DIR (same isolation as scripts/upgrade-path).

import { mkdirSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs as parseArgvOptions } from 'node:util'
import { assertIsolatedHome, fixtureBytes } from './lib.mjs'

function parseArgs(argv) {
  const { values } = parseArgvOptions({
    args: argv,
    options: {
      home: { type: 'string', default: '' },
      'target-mb': { type: 'string', default: '30' },
      seed: { type: 'string', default: String(0x9e3779b9) },
      force: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  const result = { home: values.home, targetMb: Number(values['target-mb']), seed: Number(values.seed), force: values.force, help: values.help }
  if (result.help) return result
  if (!result.home) throw new Error('--home is required')
  if (!Number.isFinite(result.targetMb) || result.targetMb < 1) throw new Error('--target-mb must be >= 1')
  return result
}

function mulberry(seed) {
  let state = seed | 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function writeLines(path, lines) {
  mkdirSync(join(path, '..'), { recursive: true })
  const body = lines.join('\n') + '\n'
  writeFileSync(path, body)
  return Buffer.byteLength(body)
}

function main() {
  let options
  try { options = parseArgs(process.argv.slice(2)) }
  catch (error) {
    console.error(String(error))
    console.error('Usage: node scripts/perf/gen-fixture.mjs --home <isolated-home> [--target-mb 30] [--seed N] [--force]')
    process.exitCode = 2
    return
  }
  if (options.help) {
    console.log('Usage: node scripts/perf/gen-fixture.mjs --home <isolated-home> [--target-mb 30] [--seed N] [--force]')
    return
  }

  const HOME = resolve(options.home)
  assertIsolatedHome(HOME)
  const marker = join(HOME, '.codeburn-perf-fixture.json')
  if (existsSync(HOME) && readdirSync(HOME).length > 0 && !existsSync(marker) && !options.force) {
    throw new Error(HOME + ' is not empty and is not a prior perf fixture. Pass --force only after inspecting it.')
  }
  if (existsSync(marker) && options.force) {
    rmSync(HOME, { recursive: true, force: true })
  }
  mkdirSync(HOME, { recursive: true })

  const rnd = mulberry(options.seed)
  const pick = arr => arr[Math.floor(rnd() * arr.length)]
  const between = (lo, hi) => {
    const n = lo + Math.floor(rnd() * (hi - lo))
    return n > 0 ? n : lo
  }
  const DAY_MS = 86_400_000
  const SPAN_DAYS = 92
  // Relative to UTC midnight so today/7D/30D queries have data, matching
  // scripts/upgrade-path/gen-corpus.mjs. The exact day0 is recorded in the
  // fixture marker so a baseline row can cite it.
  const day0 = Math.floor(Date.now() / DAY_MS) * DAY_MS - (SPAN_DAYS - 1) * DAY_MS
  const at = (day, hour, min = 0, sec = 0) => new Date(day0 + day * DAY_MS + hour * 3_600_000 + min * 60_000 + sec * 1000)
  const iso = d => d.toISOString()
  const PROJECTS = ['/work/api-gateway', '/work/billing', '/work/web-app', '/work/infra']
  const MODELS = ['claude-sonnet-4-5', 'claude-opus-4-8', 'claude-haiku-4-5']
  const TOOLS = ['Read', 'Edit', 'Bash', 'Glob', 'Grep']

  const claudeUser = (sessionId, ts, cwd, text) => JSON.stringify({
    type: 'user', sessionId, timestamp: iso(ts), cwd, gitBranch: 'main',
    message: { role: 'user', content: text },
  })
  const claudeAssistant = (sessionId, ts, cwd, msgId, model, usage, content) => JSON.stringify({
    type: 'assistant', sessionId, timestamp: iso(ts), cwd, gitBranch: 'main',
    message: { id: msgId, type: 'message', role: 'assistant', model, content, usage },
  })

  const targetBytes = options.targetMb * 1024 * 1024
  let files = 0
  let sessions = 0
  let claudeBytes = 0
  const projectsDir = join(HOME, '.claude', 'projects')
  let i = 0
  while (claudeBytes < targetBytes * 0.88) {
    const cwd = PROJECTS[i % PROJECTS.length]
    const day = (i * 3) % SPAN_DAYS
    const sid = 'perf-' + String(i).padStart(5, '0')
    const dirName = cwd.replace(/[/ ]/g, '-')
    const turns = 8 + (i % 12)
    const lines = []
    for (let t = 0; t < turns; t++) {
      const ts = at(day, 9 + (t % 8), (t * 7) % 60)
      lines.push(claudeUser(sid, ts, cwd, 'synthetic task ' + t + ' for ' + sid + ' on billing totals'))
      const content = [
        { type: 'text', text: 'step ' + t + ' ' + 'x'.repeat(40 + (i % 80)) },
        { type: 'tool_use', id: 'tu-' + sid + '-' + t, name: pick(TOOLS), input: { file_path: cwd + '/src/f' + t + '.ts' } },
      ]
      if (t === 2 && i % 17 === 0) content.push({ type: 'text', text: 'pad-' + 'y'.repeat(8 * 1024) })
      lines.push(claudeAssistant(sid, at(day, 9 + (t % 8), (t * 7) % 60, 30), cwd, 'msg-' + sid + '-' + t, pick(MODELS), {
        input_tokens: between(400, 4000),
        output_tokens: between(40, 900),
        cache_read_input_tokens: between(0, 20000),
        cache_creation_input_tokens: between(0, 3000),
      }, content))
    }
    claudeBytes += writeLines(join(projectsDir, dirName, sid + '.jsonl'), lines)
    files++
    sessions++
    i++
    if (i > 4000) break
  }

  // Codex sessions: mixed event types, cumulative token_count.
  const codexRoot = join(HOME, '.codex', 'sessions')
  for (let c = 0; c < 40; c++) {
    const day = (c * 2) % SPAN_DAYS
    const d = new Date(day0 + day * DAY_MS)
    const cwd = PROJECTS[c % PROJECTS.length]
    const sid = 'codex-perf-' + String(c).padStart(3, '0')
    const lines = [JSON.stringify({ type: 'session_meta', timestamp: iso(at(day, 10)), payload: { cwd, originator: 'codex-cli', session_id: sid, model: 'gpt-5.3-codex' } })]
    const total = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 }
    for (let t = 0; t < 6; t++) {
      const ts = iso(at(day, 10, t * 5))
      const last = { input_tokens: between(500, 6000), cached_input_tokens: between(0, 2000), output_tokens: between(50, 800), reasoning_output_tokens: between(0, 300), total_tokens: 0 }
      last.total_tokens = last.input_tokens + last.output_tokens
      for (const k of Object.keys(total)) total[k] += last[k]
      lines.push(JSON.stringify({ type: 'event_msg', timestamp: ts, payload: { type: 'task_started' } }))
      lines.push(JSON.stringify({ type: 'response_item', timestamp: ts, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'task ' + t }] } }))
      lines.push(JSON.stringify({ type: 'response_item', timestamp: ts, payload: { type: 'function_call', name: 'shell', call_id: 'c' + t, arguments: JSON.stringify({ command: 'ls' }) } }))
      lines.push(JSON.stringify({ type: 'response_item', timestamp: ts, payload: { type: 'function_call_output', call_id: 'c' + t } }))
      lines.push(JSON.stringify({ type: 'response_item', timestamp: ts, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] } }))
      lines.push(JSON.stringify({ type: 'event_msg', timestamp: ts, payload: { type: 'token_count', info: { last_token_usage: last, total_token_usage: { ...total } } } }))
      lines.push(JSON.stringify({ type: 'event_msg', timestamp: ts, payload: { type: 'task_complete', duration_ms: 4000 } }))
    }
    const dir = join(codexRoot, String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0'))
    writeLines(join(dir, 'rollout-' + sid + '.jsonl'), lines)
    files++
    sessions++
  }

  const bytes = fixtureBytes(HOME)
  const manifest = {
    kind: 'codeburn-perf-fixture',
    version: 1,
    generated_at: new Date().toISOString(),
    seed: options.seed,
    target_mb: options.targetMb,
    bytes,
    files,
    sessions,
    span_days: SPAN_DAYS,
    day0: new Date(day0).toISOString(),
    note: 'Synthetic sanitized sessions only. Do not copy founder transcripts here.',
    append_target: join('.claude', 'projects', '-work-api-gateway', 'perf-00000.jsonl'),
  }
  writeFileSync(marker, JSON.stringify(manifest, null, 2) + '\n')
  console.log(JSON.stringify(manifest, null, 2))
}

try { main() }
catch (error) {
  console.error(String(error?.stack ?? error))
  process.exitCode = 1
}
