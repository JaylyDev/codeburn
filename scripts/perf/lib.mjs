#!/usr/bin/env node
// Shared helpers for the Phase 0 performance harness.
// Extends the #1164 release-acceptance evidence shape without touching product
// hot paths. Isolation matches scripts/upgrade-path/run.mjs cliEnv().

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, statSync, readdirSync } from 'node:fs'
import { cpus, homedir, loadavg, release, totalmem, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const PERF_DIR = join(REPO, 'perf')
export const RESULTS_DIR = join(PERF_DIR, 'results')

export const TIMINGS_HEADER = [
  'run_id', 'case_id', 'surface', 'persona', 'operation', 'trial', 'cache_state',
  'start_monotonic_ms', 'first_feedback_ms', 'first_useful_ms', 'complete_ms',
  'cpu_peak_pct', 'rss_peak_bytes', 'calls', 'tokens', 'cost_usd', 'identical_totals', 'notes',
].join(',')

export const DESKTOP_OVERVIEW_ARGS = ['status', '--format', 'menubar-json', '--period', 'today', '--no-timeline']
export const MENUBAR_STATUS_ARGS = ['status', '--format', 'menubar-json', '--provider', 'all', '--period', 'today', '--no-optimize']
export const FULL_CORPUS_ARGS = ['status', '--format', 'menubar-json', '--period', 'all', '--no-timeline', '--no-optimize']

export function cliEntry() {
  const dist = join(REPO, 'dist', 'cli.js')
  if (existsSync(dist)) return { cmd: process.execPath, args: [dist], label: 'dist/cli.js' }
  return { cmd: process.execPath, args: ['--import', 'tsx', join(REPO, 'src', 'cli.ts')], label: 'tsx src/cli.ts' }
}

export function isolatedEnv(home, extra = {}) {
  const passthrough = {}
  for (const key of ['PATH', 'PATHEXT', 'SystemRoot', 'ComSpec', 'windir', 'TEMP', 'TMP', 'NUMBER_OF_PROCESSORS', 'NODE_PATH']) {
    if (process.env[key] !== undefined) passthrough[key] = process.env[key]
  }
  const cacheDir = extra.CODEBURN_CACHE_DIR ?? join(home, '.cache', 'codeburn')
  return {
    ...passthrough,
    HOME: home,
    USERPROFILE: home,
    TZ: 'UTC',
    CODEBURN_CACHE_DIR: cacheDir,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_CACHE_HOME: join(home, '.cache'),
    CODEBURN_PRICING_SNAPSHOT_ONLY: '1',
    CODEBURN_FX_NO_FETCH: '1',
    ...extra,
  }
}

export function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value)
  return /[",\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text
}

export function percentile(values, p) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[rank]
}

export function stats(values) {
  if (!values.length) return { n: 0, min: null, max: null, mean: null, p50: null, p95: null }
  const sum = values.reduce((a, b) => a + b, 0)
  return {
    n: values.length,
    min: Math.min(...values),
    max: Math.max(...values),
    mean: sum / values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
  }
}

export function runProcess(command, args, options = {}) {
  return new Promise(resolveRun => {
    const started = performance.now()
    const child = spawn(command, args, {
      cwd: options.cwd ?? REPO,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    child.stdout.on('data', chunk => stdout.push(chunk))
    child.stderr.on('data', chunk => stderr.push(chunk))
    const timeout = options.timeoutMs
      ? setTimeout(() => { child.kill('SIGKILL') }, options.timeoutMs)
      : null
    child.on('error', error => {
      if (timeout) clearTimeout(timeout)
      resolveRun({
        command, args, pid: child.pid ?? null, exitCode: null,
        durationMs: performance.now() - started,
        stdout: '', stderr: String(error),
      })
    })
    child.on('close', exitCode => {
      if (timeout) clearTimeout(timeout)
      resolveRun({
        command, args, pid: child.pid ?? null, exitCode,
        durationMs: performance.now() - started,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    })
  })
}

export async function capture(command, args, options = {}) {
  const result = await runProcess(command, args, options)
  if (result.exitCode !== 0) {
    throw new Error(command + ' ' + args.join(' ') + ' failed (' + result.exitCode + '): ' + result.stderr.slice(0, 2000))
  }
  return result.stdout.trim()
}

export async function machineSnapshot() {
  const sha = await capture('git', ['rev-parse', 'HEAD'], { cwd: REPO }).catch(() => 'unknown')
  const branch = await capture('git', ['branch', '--show-current'], { cwd: REPO }).catch(() => '')
  const dirty = await capture('git', ['status', '--porcelain=v1'], { cwd: REPO }).catch(() => '')
  // hw.model has no node:os equivalent; everything else does.
  const hardware = await capture('sysctl', ['-n', 'hw.model'], { cwd: REPO }).catch(() => 'unknown')
  return {
    captured_at: new Date().toISOString(),
    sha,
    branch,
    dirty: Boolean(dirty),
    os: process.platform + ' ' + release(),
    arch: process.arch,
    hardware,
    memory_bytes: totalmem(),
    ncpu: cpus().length,
    loadavg: loadavg().map(n => n.toFixed(2)).join(' '),
    node: process.version,
    cli: cliEntry().label,
    cwd: REPO,
    host_home_not_used: true,
  }
}

export async function processRssBytes(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null
  const result = await runProcess('ps', ['-o', 'rss=', '-p', String(pid)], { timeoutMs: 5_000 })
  if (result.exitCode !== 0) return null
  const kb = Number(result.stdout.trim().split(/\s+/).pop())
  return Number.isFinite(kb) ? kb * 1024 : null
}

export function summarizePayload(output) {
  if (!output) return { calls: '', tokens: '', cost_usd: '' }
  try {
    const payload = JSON.parse(output)
    const current = payload.current ?? payload
    const tokens = Number(current.inputTokens ?? 0) + Number(current.outputTokens ?? 0)
    return {
      calls: current.calls ?? '',
      tokens: Number.isFinite(tokens) ? tokens : '',
      cost_usd: current.cost ?? '',
      sessions: current.sessions ?? '',
      label: current.label ?? '',
      hydrationComplete: payload.hydration ? payload.hydration.complete !== false : true,
    }
  } catch {
    return { calls: '', tokens: '', cost_usd: '', parseError: true }
  }
}

export function writeTimings(path, rows) {
  const body = [TIMINGS_HEADER, ...rows.map(row => TIMINGS_HEADER.split(',').map(key => csvCell(row[key] ?? '')).join(','))].join('\n') + '\n'
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
}

export function fixtureBytes(root) {
  let total = 0
  const walk = dir => {
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, name.name)
      if (name.isDirectory()) walk(path)
      else total += statSync(path).size
    }
  }
  walk(root)
  return total
}

export class ServeClient {
  constructor(env, extraArgs = []) {
    this.env = env
    this.extraArgs = extraArgs
    this.child = null
    this.buffer = ''
    this.ready = null
    this.waiters = new Map()
    this.pid = null
    this.stderr = ''
    this._closed = false
  }

  start() {
    const entry = cliEntry()
    this.child = spawn(entry.cmd, [...entry.args, 'serve', '--stdio', ...this.extraArgs], {
      cwd: REPO,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.pid = this.child.pid ?? null
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('serve did not emit {ready:true} within 30s')), 30_000)
      this._readyResolve = () => {
        clearTimeout(timer)
        resolve()
      }
      this.child.on('error', err => {
        clearTimeout(timer)
        reject(err)
      })
      this.child.on('exit', (code, signal) => {
        if (!this._closed) {
          clearTimeout(timer)
          reject(new Error('serve exited before ready (code=' + code + ' signal=' + signal + ')'))
        }
      })
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', chunk => this._onData(chunk))
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', chunk => { this.stderr += chunk })
    return this.ready
  }

  _onData(chunk) {
    this.buffer += chunk
    let idx
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.ready) {
        this.pid = typeof msg.pid === 'number' ? msg.pid : this.pid
        this._readyResolve?.()
        continue
      }
      if (typeof msg.progress === 'string' && !('ok' in msg)) {
        const waiter = this.waiters.get(msg.id)
        if (waiter) {
          waiter.progress.push(msg.progress)
          if (waiter.firstFeedbackMs == null) waiter.firstFeedbackMs = performance.now() - waiter.started
        }
        continue
      }
      const waiter = this.waiters.get(msg.id)
      if (waiter) {
        this.waiters.delete(msg.id)
        waiter.finish(msg)
      }
    }
  }

  request(id, args, timeoutMs = 180_000) {
    return new Promise((resolve, reject) => {
      const started = performance.now()
      const entry = {
        started,
        progress: [],
        firstFeedbackMs: null,
        finish: msg => {
          clearTimeout(timer)
          resolve({
            id,
            ok: msg.ok === true,
            refused: msg.refused === true,
            output: typeof msg.output === 'string' ? msg.output : '',
            error: typeof msg.error === 'string' ? msg.error : '',
            progress: entry.progress,
            firstFeedbackMs: entry.firstFeedbackMs,
            completeMs: performance.now() - started,
          })
        },
      }
      const timer = setTimeout(() => {
        this.waiters.delete(id)
        reject(new Error('serve request ' + id + ' timed out after ' + timeoutMs + 'ms'))
      }, timeoutMs)
      this.waiters.set(id, entry)
      this.child.stdin.write(JSON.stringify({ id, args }) + '\n', err => {
        if (err) {
          clearTimeout(timer)
          this.waiters.delete(id)
          reject(err)
        }
      })
    })
  }

  async close() {
    this._closed = true
    if (!this.child) return
    this.child.stdin.end()
    await Promise.race([
      new Promise(resolve => this.child.once('exit', resolve)),
      new Promise(resolve => setTimeout(() => { this.child.kill('SIGKILL'); resolve() }, 5_000)),
    ])
  }
}

export function assertIsolatedHome(home) {
  const resolved = resolve(home)
  const homes = new Set()
  try { homes.add(resolve(homedir())) } catch {}
  try { homes.add(resolve(userInfo().homedir)) } catch {}
  if (process.env.HOME) homes.add(resolve(process.env.HOME))
  for (const realHome of homes) {
    if (resolved === realHome || resolved.startsWith(realHome + '/')) {
      throw new Error('refusing to write fixtures under the real home (' + realHome + ')')
    }
  }
}

export function nowId(prefix = 'perf') {
  return prefix + '-' + new Date().toISOString().replace(/[:.]/g, '-')
}
