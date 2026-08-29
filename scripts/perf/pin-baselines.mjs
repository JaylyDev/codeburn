#!/usr/bin/env node
// Pins perf/BASELINES.md from a harness summary.json. One SHA, one table.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PERF_DIR } from './lib.mjs'

function parseArgs(argv) {
  const result = { summary: '', log: true }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--summary') result.summary = argv[++i] ?? ''
    else if (arg === '--help' || arg === '-h') result.help = true
    else throw new Error('Unknown argument: ' + arg)
  }
  if (result.help) return result
  if (!result.summary) throw new Error('--summary is required')
  return result
}

function fmt(value, digits = 1) {
  if (value == null || Number.isNaN(value)) return 'n/a'
  return Number(value).toFixed(digits)
}

function metricRow(id, fixture, command, machine, number, notes) {
  return '| ' + [id, fixture, command, machine, number, notes].join(' | ') + ' |'
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log('Usage: node scripts/perf/pin-baselines.mjs --summary <summary.json>')
    return
  }
  const summaryPath = resolve(options.summary)
  const data = JSON.parse(readFileSync(summaryPath, 'utf8'))
  const machine = data.machine ?? {}
  const s = data.summaries ?? {}
  const machineLabel = [machine.hardware, machine.arch, machine.node, 'sha ' + String(machine.sha ?? '').slice(0, 8)].filter(Boolean).join(', ')
  const date = (machine.captured_at ?? new Date().toISOString()).slice(0, 10)
  const fixture = 'scripts/perf/gen-fixture.mjs --target-mb 30 (isolated HOME)'
  const lines = [
    '# CodeBurn performance baselines',
    '',
    'Pinned from current main before the first product change. An iteration without a before/after number from this harness does not exist.',
    '',
    '- SHA: `' + (machine.sha ?? 'unknown') + '`',
    '- Branch: `' + (machine.branch ?? '') + '`',
    '- Date: ' + date,
    '- Machine: ' + machineLabel,
    '- Node: ' + (machine.node ?? ''),
    '- CLI: ' + (machine.cli ?? ''),
    '- Summary: `' + summaryPath + '`',
    '- Historical Desktop 7D (installed 0.9.21, live corpus, 2026-08-27): 18286.98 ms useful summary. Target: 250 ms p95 ready summary. That receipt is *not* this fixture.',
    '',
    'These rows are wait-path measurements through isolated HOME + CLI/serve. They are not installed Desktop/Menu Bar UI proof.',
    '',
    '| metric | fixture | command | machine | number | notes |',
    '|---|---|---|---|---|---|',
  ]
  if (s['session-parse']) {
    const d = s['session-parse']
    lines.push(metricRow('session-parse cold (ms p50/p95)', fixture, 'node scripts/perf/run-metric.mjs --metric session-parse --home <HOME>', machineLabel, fmt(d.duration_ms?.p50) + ' / ' + fmt(d.duration_ms?.p95), 'MB/s p50=' + fmt(d.mb_per_s?.p50, 3) + ' fixture_bytes=' + d.fixture_bytes))
  }
  if (s['incremental-reparse']) {
    const d = s['incremental-reparse']
    lines.push(metricRow('incremental-reparse (ms)', fixture + ' then append 2 JSONL lines', 'node scripts/perf/run-metric.mjs --metric incremental-reparse --home <HOME>', machineLabel, fmt(d.duration_ms), 'same inode append; everyday path'))
  }
  if (s['period-switch']) {
    const d = s['period-switch']
    lines.push(metricRow('period-switch first 7D after load (ms)', fixture + ' via serve --stdio', 'node scripts/perf/run-metric.mjs --metric period-switch --home <HOME>', machineLabel, fmt(d.first_week_ms), 'index-ready first 7D; analogue of 18s receipt; wait-path'))
    lines.push(metricRow('period-switch first 30D after load (ms)', fixture + ' via serve --stdio', 'same', machineLabel, fmt(d.first_30d_ms), 'index-ready first 30D; wait-path'))
    lines.push(metricRow('period-switch 7D warm (ms p50/p95)', fixture + ' via serve --stdio', 'node scripts/perf/run-metric.mjs --metric period-switch --home <HOME>', machineLabel, fmt(d.week_ms?.p50) + ' / ' + fmt(d.week_ms?.p95), 'wait-path; installed UI target remains 250ms p95'))
    lines.push(metricRow('period-switch 30D warm (ms p50/p95)', fixture + ' via serve --stdio', 'node scripts/perf/run-metric.mjs --metric period-switch --home <HOME>', machineLabel, fmt(d.days30_ms?.p50) + ' / ' + fmt(d.days30_ms?.p95), 'wait-path'))
    lines.push(metricRow('serve ready (ms)', fixture, 'same', machineLabel, fmt(d.serve_ready_ms), '{ready:true} frame'))
  }
  if (s['cold-start-cli']) {
    const d = s['cold-start-cli']
    lines.push(metricRow('cold-start desktop wait-path (ms p50/p95)', fixture, 'node scripts/perf/run-metric.mjs --metric cold-start-cli --home <HOME>', machineLabel, fmt(d.desktop_wait_ms?.p50) + ' / ' + fmt(d.desktop_wait_ms?.p95), 'status menubar-json --period today --no-timeline; UI NOT VERIFIED'))
    lines.push(metricRow('cold-start menubar wait-path (ms p50/p95)', fixture, 'same', machineLabel, fmt(d.menubar_wait_ms?.p50) + ' / ' + fmt(d.menubar_wait_ms?.p95), 'status menubar-json --provider all --period today --no-optimize; UI NOT VERIFIED'))
  }
  if (s['dock-tui-proxy']) {
    const d = s['dock-tui-proxy']
    lines.push(metricRow('refresh proxy (ms p95)', fixture, 'node scripts/perf/run-metric.mjs --metric dock-tui-proxy --home <HOME>', machineLabel, fmt(d.refresh_ms?.p95), 'hover is native dock; this is payload reuse'))
    lines.push(metricRow('view-switch proxy (ms p95)', fixture, 'same', machineLabel, fmt(d.view_switch_ms?.p95), 'period week request; sidebar paint NOT VERIFIED'))
  }
  if (s.memory) {
    const d = s.memory
    lines.push(metricRow('memory RSS after cold load (bytes)', fixture, 'node scripts/perf/run-metric.mjs --metric memory --home <HOME>', machineLabel, String(d.rss_after_cold_load_bytes ?? 'n/a'), d.note ?? ''))
    lines.push(metricRow('memory RSS after idle (bytes)', fixture, 'same --idle-ms 3600000', machineLabel, String(d.rss_after_idle_bytes ?? 'n/a'), '1h leak check only if idle_ms=3600000'))
  }
  lines.push('')
  lines.push('## Reproduction')
  lines.push('')
  lines.push('```bash')
  lines.push('HOME_DIR=$(mktemp -d /tmp/codeburn-perf-XXXX)')
  lines.push('node scripts/perf/gen-fixture.mjs --home "$HOME_DIR" --target-mb 30')
  lines.push('node scripts/perf/run-metric.mjs --metric all --home "$HOME_DIR"')
  lines.push('node scripts/perf/pin-baselines.mjs --summary perf/results/<run>/summary.json')
  lines.push('```')
  lines.push('')
  const out = join(PERF_DIR, 'BASELINES.md')
  writeFileSync(out, lines.join('\n') + '\n')
  const logPath = join(PERF_DIR, 'ITERATION-LOG.md')
  if (!existsSync(logPath)) {
    writeFileSync(logPath, '# CodeBurn performance iteration log\n\nDate | branch/PR | metric | before → after | verdict | mechanism\n---|---|---|---|---|---\n')
  }
  const logLine = '| ' + date + ' | perf/harness-phase0 | harness (all) | n/a → pinned | kept | Phase 0 harness + synthetic fixture; no product change |\n'
  const current = readFileSync(logPath, 'utf8')
  if (!current.includes('perf/harness-phase0 | harness (all)')) {
    writeFileSync(logPath, current.trimEnd() + '\n' + logLine)
  }
  console.log('wrote ' + out)
}

try { main() }
catch (error) {
  console.error(String(error?.stack ?? error))
  process.exitCode = 1
}
