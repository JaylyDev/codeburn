#!/usr/bin/env node
// One-command-per-metric runner. Measures wait-path latency through the same
// CLI/serve argv Desktop and Menu Bar already use. Does not claim installed UI.
//
//   node scripts/perf/run-metric.mjs --metric <name> --home <isolated-home> [--output <dir>]

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs as parseArgvOptions } from 'node:util'
import { performance } from 'node:perf_hooks'
import {
  DESKTOP_OVERVIEW_ARGS,
  FULL_CORPUS_ARGS,
  MENUBAR_STATUS_ARGS,
  RESULTS_DIR,
  ServeClient,
  assertIsolatedHome,
  capture,
  cliEntry,
  fixtureBytes,
  isolatedEnv,
  machineSnapshot,
  nowId,
  processRssBytes,
  runProcess,
  stats,
  summarizePayload,
  writeTimings,
} from './lib.mjs'

const METRICS = new Set([
  'session-parse',
  'incremental-reparse',
  'period-switch',
  'cold-start-cli',
  'dock-tui-proxy',
  'memory',
  'all',
])

function parseArgs(argv) {
  const { values } = parseArgvOptions({
    args: argv,
    options: {
      metric: { type: 'string', default: '' },
      home: { type: 'string', default: '' },
      output: { type: 'string', default: '' },
      'trials-cold': { type: 'string', default: '3' },
      'trials-warm': { type: 'string', default: '5' },
      'idle-ms': { type: 'string', default: '0' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  const result = {
    metric: values.metric,
    home: values.home,
    output: values.output,
    trialsCold: Number(values['trials-cold']),
    trialsWarm: Number(values['trials-warm']),
    idleMs: Number(values['idle-ms']),
    help: values.help,
  }
  if (result.help) return result
  if (!METRICS.has(result.metric)) throw new Error('Invalid --metric. Expected one of: ' + [...METRICS].join(', '))
  if (!result.home) throw new Error('--home is required')
  return result
}

function usage() {
  return `Usage: node scripts/perf/run-metric.mjs --metric <session-parse|incremental-reparse|period-switch|cold-start-cli|dock-tui-proxy|memory|all> --home <isolated-home> [--output <dir>]

Wait-path harness for CodeBurn. Isolated HOME only. Does not launch packaged Desktop/Menu Bar UI.
UI first_feedback / hover / view-switch remain computer-use (RA-PERF-003/005/006).`
}

function emptyCache(home) {
  const cacheDir = join(home, '.cache', 'codeburn')
  rmSync(cacheDir, { recursive: true, force: true })
  mkdirSync(cacheDir, { recursive: true })
  return cacheDir
}

function appendClaudeDelta(home) {
  const target = join(home, '.claude', 'projects', '-work-api-gateway', 'perf-00000.jsonl')
  if (!existsSync(target)) throw new Error('append target missing: ' + target + ' (regenerate fixture)')
  const before = readFileSync(target)
  const ts = '2026-08-28T18:00:00.000Z'
  const sid = 'perf-00000'
  const cwd = '/work/api-gateway'
  const delta = JSON.stringify({
    type: 'user', sessionId: sid, timestamp: ts, cwd, gitBranch: 'main',
    message: { role: 'user', content: 'append-only delta task' },
  }) + '\n' + JSON.stringify({
    type: 'assistant', sessionId: sid, timestamp: '2026-08-28T18:00:01.000Z', cwd, gitBranch: 'main',
    message: {
      id: 'msg-perf-00000-append',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text: 'appended' }, { type: 'tool_use', id: 'tu-append', name: 'Read', input: { file_path: cwd + '/src/delta.ts' } }],
      usage: { input_tokens: 1200, output_tokens: 80 },
    },
  }) + '\n'
  appendFileSync(target, delta)
  return { target, beforeBytes: before.length, deltaBytes: Buffer.byteLength(delta) }
}

function rowBase(runId, caseId, surface, operation, trial, cacheState, start, completeMs, summary, notes, extra = {}) {
  return {
    run_id: runId,
    case_id: caseId,
    surface,
    persona: 'B',
    operation,
    trial,
    cache_state: cacheState,
    start_monotonic_ms: Number(start.toFixed(3)),
    first_feedback_ms: extra.first_feedback_ms ?? '',
    first_useful_ms: extra.first_useful_ms ?? Number(completeMs.toFixed(3)),
    complete_ms: Number(completeMs.toFixed(3)),
    cpu_peak_pct: '',
    rss_peak_bytes: extra.rss_peak_bytes ?? '',
    calls: summary.calls ?? '',
    tokens: summary.tokens ?? '',
    cost_usd: summary.cost_usd ?? '',
    identical_totals: extra.identical_totals ?? '',
    notes,
  }
}

async function oneShotStatus(home, args, extraEnv = {}) {
  const entry = cliEntry()
  const env = isolatedEnv(home, extraEnv)
  const started = performance.now()
  const result = await runProcess(entry.cmd, [...entry.args, ...args], { env, timeoutMs: 180_000 })
  return { ...result, started, env }
}

async function runSessionParse(ctx) {
  const { home, runId, output, trialsCold } = ctx
  const bytes = fixtureBytes(home)
  const rows = []
  const durations = []
  for (let trial = 1; trial <= trialsCold; trial++) {
    emptyCache(home)
    const result = await oneShotStatus(home, FULL_CORPUS_ARGS, { CODEBURN_PROGRESS: '1' })
    if (result.exitCode !== 0) throw new Error('session-parse trial ' + trial + ' failed: ' + result.stderr.slice(0, 1500))
    const summary = summarizePayload(result.stdout)
    const mbPerSec = result.durationMs > 0 ? (bytes / (1024 * 1024)) / (result.durationMs / 1000) : 0
    durations.push(result.durationMs)
    rows.push(rowBase(runId, 'PERF-PARSE-001', 'CLI', 'cli-cold-full', trial, 'cold', result.started, result.durationMs, summary,
      'wait-path-only; fixture_bytes=' + bytes + '; MBps=' + mbPerSec.toFixed(3) + '; UI not verified'))
  }
  const summary = { metric: 'session-parse', fixture_bytes: bytes, duration_ms: stats(durations), mb_per_s: stats(durations.map(ms => (bytes / (1024 * 1024)) / (ms / 1000))) }
  writeJson(output, 'session-parse.json', { ...ctx.machine, ...summary, rows })
  return { rows, summary }
}

async function runIncremental(ctx) {
  const { home, runId, output } = ctx
  emptyCache(home)
  const warm = await oneShotStatus(home, FULL_CORPUS_ARGS, { CODEBURN_PROGRESS: '1' })
  if (warm.exitCode !== 0) throw new Error('incremental warmup failed: ' + warm.stderr.slice(0, 1500))
  const append = appendClaudeDelta(home)
  const result = await oneShotStatus(home, FULL_CORPUS_ARGS, { CODEBURN_PROGRESS: '1' })
  if (result.exitCode !== 0) throw new Error('incremental reparse failed: ' + result.stderr.slice(0, 1500))
  const summary = summarizePayload(result.stdout)
  const rows = [
    rowBase(runId, 'PERF-PARSE-002', 'CLI', 'cli-cold-full', 1, 'warm-then-append', result.started, result.durationMs, summary,
      'append-only delta on same inode; before_bytes=' + append.beforeBytes + '; delta_bytes=' + append.deltaBytes + '; wait-path-only'),
  ]
  const payload = { metric: 'incremental-reparse', append, duration_ms: result.durationMs, summary }
  writeJson(output, 'incremental-reparse.json', { ...ctx.machine, ...payload, rows })
  return { rows, summary: payload }
}

async function runPeriodSwitch(ctx) {
  const { home, runId, output, trialsWarm } = ctx
  emptyCache(home)
  // Do not set CODEBURN_SERVE_PROGRESSIVE: the 18s 7D receipt was a warm app
  // with a complete cache, not a floored first paint.
  const env = isolatedEnv(home, { CODEBURN_PROGRESS: '1' })
  const client = new ServeClient(env)
  const readyStarted = performance.now()
  await client.start()
  const readyMs = performance.now() - readyStarted
  const load = await client.request(1, FULL_CORPUS_ARGS)
  if (!load.ok) throw new Error('period-switch load failed: ' + load.error)
  const firstWeek = await client.request(2, ['status', '--format', 'menubar-json', '--period', 'week', '--no-timeline', '--no-optimize'])
  if (!firstWeek.ok) throw new Error('first 7D failed: ' + firstWeek.error)
  const firstMonth = await client.request(3, ['status', '--format', 'menubar-json', '--period', '30days', '--no-timeline', '--no-optimize'])
  if (!firstMonth.ok) throw new Error('first 30D failed: ' + firstMonth.error)
  const week = []
  const month = []
  const rows = []
  rows.push(rowBase(runId, 'PERF-PERIOD-7D-FIRST', 'serve', 'resident-warm-full', 0, 'index-ready-first', performance.now(), firstWeek.completeMs, summarizePayload(firstWeek.output),
    'first 7D after complete corpus load; analogue of the 18s idle-then-7D receipt; wait-path only'))
  rows.push(rowBase(runId, 'PERF-PERIOD-30D-FIRST', 'serve', 'resident-warm-full', 0, 'index-ready-first', performance.now(), firstMonth.completeMs, summarizePayload(firstMonth.output),
    'first 30D after complete corpus load; wait-path only'))
  let id = 4
  for (let trial = 1; trial <= trialsWarm; trial++) {
    const a = await client.request(id++, ['status', '--format', 'menubar-json', '--period', 'week', '--no-timeline', '--no-optimize'])
    if (!a.ok) throw new Error('week switch failed: ' + a.error)
    week.push(a.completeMs)
    rows.push(rowBase(runId, 'PERF-PERIOD-7D', 'serve', 'resident-warm-full', trial, 'warm', performance.now(), a.completeMs, summarizePayload(a.output),
      'wait-path-only; Desktop getOverview argv minus UI; ready_ms=' + readyMs.toFixed(1),
      { first_feedback_ms: a.firstFeedbackMs ?? '', first_useful_ms: a.completeMs }))
    const b = await client.request(id++, ['status', '--format', 'menubar-json', '--period', '30days', '--no-timeline', '--no-optimize'])
    if (!b.ok) throw new Error('30days switch failed: ' + b.error)
    month.push(b.completeMs)
    rows.push(rowBase(runId, 'PERF-PERIOD-30D', 'serve', 'resident-warm-full', trial, 'warm', performance.now(), b.completeMs, summarizePayload(b.output),
      'wait-path-only; Desktop getOverview argv minus UI',
      { first_feedback_ms: b.firstFeedbackMs ?? '', first_useful_ms: b.completeMs }))
  }
  const rss = await processRssBytes(client.pid)
  await client.close()
  const payload = {
    metric: 'period-switch',
    serve_ready_ms: readyMs,
    load_all_ms: load.completeMs,
    first_week_ms: firstWeek.completeMs,
    first_30d_ms: firstMonth.completeMs,
    week_ms: stats(week),
    days30_ms: stats(month),
    rss_after_warm_bytes: rss,
    note: 'p95 target from snappy spec is 250ms for a ready installed-Desktop summary. This row is the serve wait path, not installed UI.',
  }
  writeJson(output, 'period-switch.json', { ...ctx.machine, ...payload, rows })
  return { rows, summary: payload }
}

async function runColdStartCli(ctx) {
  const { home, runId, output, trialsCold } = ctx
  const rows = []
  const desktop = []
  const menubar = []
  for (let trial = 1; trial <= trialsCold; trial++) {
    emptyCache(home)
    const d = await oneShotStatus(home, DESKTOP_OVERVIEW_ARGS, { CODEBURN_PROGRESS: '1' })
    if (d.exitCode !== 0) throw new Error('desktop wait-path failed: ' + d.stderr.slice(0, 1500))
    desktop.push(d.durationMs)
    rows.push(rowBase(runId, 'PERF-COLD-DESKTOP-WAIT', 'CLI', 'cli-cold-full', trial, 'cold', d.started, d.durationMs, summarizePayload(d.stdout),
      'wait-path-only; argv=status --format menubar-json --period today --no-timeline; UI ready-to-show NOT VERIFIED'))
    emptyCache(home)
    const m = await oneShotStatus(home, MENUBAR_STATUS_ARGS, { CODEBURN_PROGRESS: '1' })
    if (m.exitCode !== 0) throw new Error('menubar wait-path failed: ' + m.stderr.slice(0, 1500))
    menubar.push(m.durationMs)
    rows.push(rowBase(runId, 'PERF-COLD-MENUBAR-WAIT', 'CLI', 'cli-cold-full', trial, 'cold', m.started, m.durationMs, summarizePayload(m.stdout),
      'wait-path-only; argv=status --format menubar-json --provider all --period today --no-optimize; flame/item appearance NOT VERIFIED'))
  }
  const payload = {
    metric: 'cold-start-cli',
    desktop_wait_ms: stats(desktop),
    menubar_wait_ms: stats(menubar),
    note: 'Packaged Desktop/Menu Bar first_feedback remains computer-use.',
  }
  writeJson(output, 'cold-start-cli.json', { ...ctx.machine, ...payload, rows })
  return { rows, summary: payload }
}

async function runDockTuiProxy(ctx) {
  const { home, runId, output, trialsWarm } = ctx
  emptyCache(home)
  const env = isolatedEnv(home, { CODEBURN_PROGRESS: '1' })
  const client = new ServeClient(env)
  await client.start()
  await client.request(1, MENUBAR_STATUS_ARGS)
  const refresh = []
  const view = []
  const rows = []
  let id = 2
  // No hover proxy: Capacity Dock hover is native quota UI and never spawns
  // this argv, so a number for it here would be theater.
  for (let trial = 1; trial <= trialsWarm; trial++) {
    const r = await client.request(id++, DESKTOP_OVERVIEW_ARGS)
    refresh.push(r.completeMs)
    rows.push(rowBase(runId, 'PERF-REFRESH-PROXY', 'serve', 'resident-warm-full', trial, 'warm', performance.now(), r.completeMs, summarizePayload(r.output),
      'PROXY: Desktop overview.refresh / Menu Bar forceRefresh wait path'))
    const v = await client.request(id++, ['status', '--format', 'menubar-json', '--period', 'week', '--no-timeline', '--no-optimize'])
    view.push(v.completeMs)
    rows.push(rowBase(runId, 'PERF-VIEW-SWITCH-PROXY', 'serve', 'resident-warm-full', trial, 'warm', performance.now(), v.completeMs, summarizePayload(v.output),
      'PROXY: period view switch wait path; sidebar paint NOT VERIFIED'))
  }
  await client.close()
  const payload = {
    metric: 'dock-tui-proxy',
    refresh_ms: stats(refresh),
    view_switch_ms: stats(view),
    note: 'Hover/view-switch UI remains computer-use. TUI period keys require a TTY Ink harness, not this runner.',
  }
  writeJson(output, 'dock-tui-proxy.json', { ...ctx.machine, ...payload, rows })
  return { rows, summary: payload }
}

async function runMemory(ctx) {
  const { home, runId, output, idleMs } = ctx
  emptyCache(home)
  const env = isolatedEnv(home, { CODEBURN_PROGRESS: '1' })
  const client = new ServeClient(env)
  await client.start()
  const cold = await client.request(1, ['status', '--format', 'menubar-json', '--period', 'all', '--no-timeline', '--no-optimize'])
  if (!cold.ok) throw new Error('memory cold load failed: ' + cold.error)
  const rssAfterLoad = await processRssBytes(client.pid)
  if (idleMs > 0) await new Promise(resolve => setTimeout(resolve, idleMs))
  const rssAfterIdle = await processRssBytes(client.pid)
  await client.close()
  const rows = [rowBase(runId, 'PERF-MEM-001', 'serve', 'resident-warm-full', 1, 'cold-then-idle', performance.now(), cold.completeMs, summarizePayload(cold.output),
    'rss_after_load=' + rssAfterLoad + '; rss_after_idle=' + rssAfterIdle + '; idle_ms=' + idleMs,
    { rss_peak_bytes: rssAfterLoad })]
  const payload = {
    metric: 'memory',
    rss_after_cold_load_bytes: rssAfterLoad,
    rss_after_idle_bytes: rssAfterIdle,
    idle_ms: idleMs,
    note: idleMs === 0 ? '1h idle not run in this invocation. Pass --idle-ms 3600000 for the leak check.' : 'idle completed',
  }
  writeJson(output, 'memory.json', { ...ctx.machine, ...payload, rows })
  return { rows, summary: payload }
}

function writeJson(output, name, value) {
  writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n')
}

async function main() {
  let options
  try { options = parseArgs(process.argv.slice(2)) }
  catch (error) {
    console.error(String(error))
    console.error(usage())
    process.exitCode = 2
    return
  }
  if (options.help) {
    console.log(usage())
    return
  }
  const home = resolve(options.home)
  assertIsolatedHome(home)
  if (!existsSync(join(home, '.codeburn-perf-fixture.json'))) {
    throw new Error('no fixture marker at ' + join(home, '.codeburn-perf-fixture.json') + '. Run scripts/perf/gen-fixture.mjs first.')
  }
  const machine = await machineSnapshot()
  const runId = nowId('harness')
  const output = options.output ? resolve(options.output) : join(RESULTS_DIR, runId)
  mkdirSync(output, { recursive: true, mode: 0o700 })
  writeJson(output, 'provenance.json', { run_id: runId, home, fixture: JSON.parse(readFileSync(join(home, '.codeburn-perf-fixture.json'), 'utf8')), machine })

  const ctx = { ...options, home, output, runId, machine }
  const wanted = options.metric === 'all'
    ? ['session-parse', 'incremental-reparse', 'period-switch', 'cold-start-cli', 'dock-tui-proxy', 'memory']
    : [options.metric]
  const runners = {
    'session-parse': runSessionParse,
    'incremental-reparse': runIncremental,
    'period-switch': runPeriodSwitch,
    'cold-start-cli': runColdStartCli,
    'dock-tui-proxy': runDockTuiProxy,
    memory: runMemory,
  }
  const allRows = []
  const summaries = {}
  for (const metric of wanted) {
    const result = await runners[metric](ctx)
    allRows.push(...result.rows)
    summaries[metric] = result.summary
  }
  writeTimings(join(output, 'timings.csv'), allRows)
  writeJson(output, 'summary.json', { run_id: runId, machine, summaries })
  console.log(JSON.stringify({ run_id: runId, output, metrics: wanted, summaries }, null, 2))
}

try { await main() }
catch (error) {
  console.error(String(error?.stack ?? error))
  process.exitCode = 1
}
