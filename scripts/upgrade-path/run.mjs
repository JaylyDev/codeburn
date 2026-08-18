// Upgrade-path verification: prove that a cache written by the last PUBLISHED
// CLI survives this build's first run, on this platform, with this Node.
//
//   npm run verify:upgrade
//
// What it does, in order:
//   1. generates a deterministic multi-provider corpus into an isolated HOME
//      (whose path contains a space, because a real Windows HOME usually does)
//   2. installs codeburn@0.9.20 into an isolated global prefix and runs it,
//      producing a genuine session-cache.v7 + daily-cache.v17
//   3. installs THIS build the same way and runs it against the SAME cache dir,
//      through the npm bin shim rather than `node dist/cli.js`, so
//      dist/parse-worker.js has to resolve from a symlinked entry point
//   4. asserts the migration landed and compares payloads per provider
//   5. serve --stdio smoke, worker determinism, warm-run stability
//
// Env: UPGRADE_PATH_WORK (work dir), UPGRADE_PATH_OLD (published version to
// upgrade from), UPGRADE_PATH_KEEP=1 to leave the work dir behind.

import { spawnSync, spawn } from 'node:child_process'
import { mkdirSync, rmSync, existsSync, readdirSync, statSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const OLD_VERSION = process.env['UPGRADE_PATH_OLD'] || '0.9.20'
const WORK = process.env['UPGRADE_PATH_WORK'] || join(tmpdir(), 'codeburn upgrade path')

// The published binary's cache versions. If a future baseline writes something
// else these two are the knobs to move, and the assertions below will say so.
const OLD_SESSION_CACHE = 'session-cache.v7.json'
const OLD_DAILY_CACHE = 'daily-cache.v17.json'
const NEW_SESSION_CACHE_DIR = 'session-cache.v9'
const NEW_DAILY_CACHE = 'daily-cache.v19.json'

const HOME = join(WORK, 'user home')
const PAYLOADS = join(WORK, 'payloads')
const CACHES = join(WORK, 'caches')
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'

let failures = 0
let skipped = 0
const step = msg => console.log(`\n=== ${msg}`)
const ok = msg => console.log(`  ok    ${msg}`)
const fail = msg => { failures++; console.log(`  FAIL  ${msg}`) }
const skip = msg => { skipped++; console.log(`  skip  ${msg}`) }
const check = (cond, msg) => (cond ? ok(msg) : fail(msg))

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 29, shell: false, ...opts })
  if (r.error) throw new Error(`${cmd} ${args.join(' ')}: ${r.error.message}`)
  return r
}

// Node refuses to spawn a .cmd/.bat without a shell, and a shell spawn quotes
// nothing for you — so on Windows anything holding a space (every path here
// does, by design) has to be quoted by hand.
const quoteForShell = s => (process.platform === 'win32' && /[\s&|^]/.test(s) ? `"${s}"` : s)
function runShell(cmd, args, opts = {}) {
  if (process.platform !== 'win32') return run(cmd, args, opts)
  return run(quoteForShell(cmd), args.map(quoteForShell), { ...opts, shell: true })
}

function cliEnv(cacheDir, extra = {}) {
  // Deliberately minimal: no provider override vars, so every provider resolves
  // its own default path under the isolated HOME. APPDATA/LOCALAPPDATA are
  // pinned under it too — several providers read them on Windows, and inheriting
  // the runner's would let real (or leftover) data into the comparison.
  const passthrough = {}
  for (const k of ['PATH', 'PATHEXT', 'SystemRoot', 'ComSpec', 'windir', 'TEMP', 'TMP', 'NUMBER_OF_PROCESSORS']) {
    if (process.env[k] !== undefined) passthrough[k] = process.env[k]
  }
  return {
    ...passthrough,
    HOME, USERPROFILE: HOME, TZ: 'UTC', CODEBURN_CACHE_DIR: cacheDir,
    APPDATA: join(HOME, 'AppData', 'Roaming'), LOCALAPPDATA: join(HOME, 'AppData', 'Local'),
    ...extra,
  }
}

function cli(bin, args, cacheDir, extra = {}) {
  const r = run(bin.cmd, [...bin.args, ...args], { env: cliEnv(cacheDir, extra), cwd: WORK })
  if (r.status !== 0) throw new Error(`${args.join(' ')} exited ${r.status}\n${r.stderr?.slice(0, 4000)}`)
  return r.stdout
}

// Install into an isolated global prefix, so the CLI runs from a location that
// has nothing to do with this checkout — which is what makes dist/parse-worker.js
// resolution worth testing. On POSIX npm's bin is a symlink INTO the package and
// we drive that directly. On Windows it is a .cmd shim, which Node will not
// spawn without a shell; the payload captures go through the installed
// dist/cli.js there and the shim itself is smoke-tested once, separately.
function installGlobal(prefix, spec) {
  const r = runShell(npmCmd, ['install', '-g', '--prefix', prefix, spec, '--no-audit', '--no-fund', '--loglevel', 'error'], { cwd: WORK })
  if (r.status !== 0) throw new Error(`npm install -g ${spec} exited ${r.status}\n${r.stdout}\n${r.stderr}`)
  const symlink = join(prefix, 'bin', 'codeburn')
  if (existsSync(symlink)) return { cmd: process.execPath, args: [symlink], shim: null }
  const winCmd = join(prefix, 'codeburn.cmd')
  const entry = join(prefix, 'node_modules', 'codeburn', 'dist', 'cli.js')
  if (existsSync(entry)) return { cmd: process.execPath, args: [entry], shim: existsSync(winCmd) ? winCmd : null }
  throw new Error(`no codeburn bin under ${prefix}`)
}

// The npm shim, exercised once. Needs a shell on Windows, so nothing with a
// space in it is passed through here.
function checkShim(bin, cacheDir) {
  if (!bin.shim) { ok("CLI invoked through npm's bin symlink"); return }
  const r = runShell(bin.shim, ['--version'], { env: cliEnv(cacheDir), cwd: WORK })
  check(r.status === 0 && r.stdout.trim().length > 0, `npm .cmd shim runs: ${r.stdout.trim() || r.stderr?.slice(0, 200)}`)
}

// Captured payloads. `export` is the token/call source, `menubar-json` the
// unrounded per-provider cost; both are stable given a fixed corpus. --period all
// so the whole three-month corpus is in scope on both sides.
function capture(bin, cacheDir, outDir, extra = {}) {
  mkdirSync(outDir, { recursive: true })
  cli(bin, ['export', '--format', 'json', '--from', '2000-01-01', '--to', '2999-12-31', '-o', join(outDir, 'export.json')], cacheDir, extra)
  const menubar = cli(bin, ['status', '--format', 'menubar-json', '--period', 'all', '--no-optimize', '--no-timeline'], cacheDir, extra)
  writeFileSync(join(outDir, 'menubar.json'), menubar)
  const status = cli(bin, ['status', '--format', 'json', '--period', 'all'], cacheDir, extra)
  writeFileSync(join(outDir, 'status.json'), status)
  return { menubar: JSON.parse(menubar), status: JSON.parse(status) }
}

// The one field that moves between two runs of the same payload.
const stripGenerated = obj => JSON.parse(JSON.stringify(obj, (k, v) => (k.startsWith('generated') ? undefined : v)))

// Shards carry real stat data and are published under a random filename, so
// "identical" means identical after normalizing both away.
function shardSnapshot(cacheDir) {
  const dir = join(cacheDir, NEW_SESSION_CACHE_DIR)
  if (!existsSync(dir)) return null
  const out = {}
  for (const name of readdirSync(dir).sort()) {
    if (name === 'envelope.json') continue
    const body = JSON.parse(readFileSync(join(dir, name), 'utf8'))
    for (const entry of Object.values(body)) {
      if (entry && typeof entry === 'object' && entry.fingerprint) {
        delete entry.fingerprint.dev
        delete entry.fingerprint.ino
        delete entry.fingerprint.mtimeMs
      }
    }
    // Key the bucket off the shard's provider.month prefix, dropping the nonce.
    out[name.replace(/\.[0-9a-f]{16}\.json$/, '')] = sortDeep(body)
  }
  return out
}

function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep)
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, sortDeep(v[k])]))
  return v
}

function shardMtimes(cacheDir) {
  const dir = join(cacheDir, NEW_SESSION_CACHE_DIR)
  return Object.fromEntries(readdirSync(dir).sort().map(n => [n, statSync(join(dir, n)).mtimeMs]))
}

// ── 1. corpus ────────────────────────────────────────────────────────────────

step(`work dir: ${WORK}`)
try { rmSync(WORK, { recursive: true, force: true }) } catch (err) { console.log(`  note  could not clear the work dir (${err.code}); reusing it`) }
mkdirSync(HOME, { recursive: true })
mkdirSync(PAYLOADS, { recursive: true })

const gen = run(process.execPath, [join(HERE, 'gen-corpus.mjs'), HOME])
if (gen.status !== 0) { console.log(gen.stderr); process.exit(1) }
ok(`corpus generated: ${gen.stdout.trim()}`)

const upgradeCache = join(CACHES, 'upgrade')
mkdirSync(upgradeCache, { recursive: true })

// ── 2. baseline: the last published CLI ──────────────────────────────────────

step(`baseline: codeburn@${OLD_VERSION}`)
const oldBin = installGlobal(join(WORK, 'old'), `codeburn@${OLD_VERSION}`)
const oldVersion = cli(oldBin, ['--version'], upgradeCache).trim()
check(oldVersion === OLD_VERSION, `installed baseline reports ${oldVersion}`)

const baseline = capture(oldBin, upgradeCache, join(PAYLOADS, 'baseline'))
check(baseline.menubar.current.calls > 0, `baseline counted ${baseline.menubar.current.calls} calls across ${baseline.menubar.current.sessions} sessions`)
check(existsSync(join(upgradeCache, OLD_SESSION_CACHE)), `${OLD_VERSION} wrote ${OLD_SESSION_CACHE}`)
check(existsSync(join(upgradeCache, OLD_DAILY_CACHE)), `${OLD_VERSION} wrote ${OLD_DAILY_CACHE}`)

// ── 3. upgrade: this build, same cache dir, through the npm bin shim ─────────

step('upgrade: this build against the same cache dir')
const pack = runShell(npmCmd, ['pack', '--ignore-scripts', '--pack-destination', WORK, '--loglevel', 'error'], { cwd: REPO })
if (pack.status !== 0) { console.log(pack.stdout, pack.stderr); process.exit(1) }
const tarball = join(WORK, pack.stdout.trim().split('\n').pop().trim())
const newBin = installGlobal(join(WORK, 'new'), tarball)
ok(`this build installed as ${newBin.args[0] ?? newBin.cmd}`)
checkShim(newBin, upgradeCache)

const upgraded = capture(newBin, upgradeCache, join(PAYLOADS, 'upgraded'))

check(!existsSync(join(upgradeCache, OLD_SESSION_CACHE)), `${OLD_SESSION_CACHE} removed after the re-layout`)
check(existsSync(join(upgradeCache, NEW_SESSION_CACHE_DIR)), `${NEW_SESSION_CACHE_DIR}/ present`)
check(existsSync(join(upgradeCache, NEW_SESSION_CACHE_DIR, 'envelope.json')), `${NEW_SESSION_CACHE_DIR}/envelope.json present`)
const envelope = JSON.parse(readFileSync(join(upgradeCache, NEW_SESSION_CACHE_DIR, 'envelope.json'), 'utf8'))
check(envelope.version === 9 && Object.keys(envelope.providers ?? {}).length > 0,
  `envelope at version ${envelope.version} with ${Object.keys(envelope.providers ?? {}).length} providers`)
check(readdirSync(join(upgradeCache, NEW_SESSION_CACHE_DIR)).some(n => n !== 'envelope.json'), 'shards published alongside the envelope')
check(existsSync(join(upgradeCache, NEW_DAILY_CACHE)), `${NEW_DAILY_CACHE} re-derived`)
check(existsSync(join(upgradeCache, OLD_DAILY_CACHE)), `${OLD_DAILY_CACHE} kept as the carry-forward baseline`)
const oldDays = JSON.parse(readFileSync(join(upgradeCache, OLD_DAILY_CACHE), 'utf8')).days.length
const newDays = JSON.parse(readFileSync(join(upgradeCache, NEW_DAILY_CACHE), 'utf8')).days.length
check(newDays >= oldDays, `daily history did not shrink: ${oldDays} -> ${newDays} days`)

// ── 4. payload parity ────────────────────────────────────────────────────────

step('payload parity vs the baseline')
const cmp = run(process.execPath, [join(HERE, 'compare.mjs'), join(PAYLOADS, 'baseline'), join(PAYLOADS, 'upgraded')], { stdio: 'inherit' })
if (cmp.status !== 0) failures++

// ── 5. serve smoke ───────────────────────────────────────────────────────────

step('serve --stdio')
const serveFrames = await serveSmoke()
if (serveFrames) {
  for (const [name, args] of [['menubar-json', ['status', '--format', 'menubar-json', '--period', 'all', '--no-optimize', '--no-timeline']], ['models', ['models', '--format', 'json']]]) {
    const frame = serveFrames.get(name)
    if (!frame?.ok) { fail(`serve returned no ok frame for ${name}: ${JSON.stringify(frame)}`); continue }
    ok(`serve ok frame for ${name}`)
    const oneShot = cli(newBin, args, upgradeCache)
    const a = JSON.stringify(stripGenerated(JSON.parse(frame.output)))
    const b = JSON.stringify(stripGenerated(JSON.parse(oneShot)))
    check(a === b, `serve ${name} matches the one-shot payload (ignoring generated*)`)
  }
}

async function serveSmoke() {
  const child = spawn(newBin.cmd, [...newBin.args, 'serve', '--stdio'], { env: cliEnv(upgradeCache), cwd: WORK, stdio: ['pipe', 'pipe', 'pipe'] })
  const frames = new Map()
  let buf = ''
  let ready = false
  const done = new Promise(resolve => {
    child.stdout.on('data', d => {
      buf += d
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
        if (!line.trim()) continue
        let msg
        try { msg = JSON.parse(line) } catch { continue }
        if (msg.ready) { ready = true; continue }
        if (msg.progress !== undefined) continue
        if (msg.id === 1) frames.set('menubar-json', msg)
        if (msg.id === 2) frames.set('models', msg)
        if (frames.size === 2) resolve()
      }
    })
  })
  child.stdin.write(JSON.stringify({ id: 1, args: ['status', '--format', 'menubar-json', '--period', 'all', '--no-optimize', '--no-timeline'] }) + '\n')
  child.stdin.write(JSON.stringify({ id: 2, args: ['models', '--format', 'json'] }) + '\n')
  const timeout = new Promise(r => setTimeout(() => r('timeout'), 240_000))
  if ((await Promise.race([done, timeout])) === 'timeout') { child.kill(); fail('serve did not answer both requests within 240s'); return null }
  check(ready, 'serve announced itself with a ready frame')

  // Closing stdin is the documented shutdown: the child must exit on its own.
  const exited = new Promise(r => child.once('exit', code => r(code)))
  child.stdin.end()
  const exitCode = await Promise.race([exited, new Promise(r => setTimeout(() => r('hung'), 30_000))])
  if (exitCode === 'hung') { child.kill(); fail('serve did not exit when stdin closed') }
  else ok(`serve exited on stdin close (code ${exitCode})`)
  return frames
}

// ── 6. worker determinism ────────────────────────────────────────────────────

step('parse-worker determinism (CODEBURN_PARSE_WORKERS 0 vs 3)')
const serialCache = join(CACHES, 'workers-0')
const parallelCache = join(CACHES, 'workers-3')
for (const dir of [serialCache, parallelCache]) {
  mkdirSync(dir, { recursive: true })
  // Seed the shared price table so the two runs cannot be priced differently by
  // a cache expiring between them. Parsing is unaffected either way.
  const priced = join(upgradeCache, 'litellm-pricing.json')
  if (existsSync(priced)) copyFileSync(priced, join(dir, 'litellm-pricing.json'))
}
const serialOut = capture(newBin, serialCache, join(PAYLOADS, 'workers-0'), { CODEBURN_PARSE_WORKERS: '0', CODEBURN_VERBOSE: '1' })
const parallelOut = capture(newBin, parallelCache, join(PAYLOADS, 'workers-3'), { CODEBURN_PARSE_WORKERS: '3', CODEBURN_VERBOSE: '1' })
check(JSON.stringify(stripGenerated(serialOut.menubar)) === JSON.stringify(stripGenerated(parallelOut.menubar)),
  'menubar-json payload identical with and without workers')
const readExport = dir => stripGenerated(JSON.parse(readFileSync(join(PAYLOADS, dir, 'export.json'), 'utf8')))
check(JSON.stringify(readExport('workers-0')) === JSON.stringify(readExport('workers-3')),
  'export payload identical with and without workers')
check(JSON.stringify(shardSnapshot(serialCache)) === JSON.stringify(shardSnapshot(parallelCache)),
  'shard bodies identical with and without workers (fingerprint stat data and shard nonces normalized)')

// A forced pool that never actually spawned would make the check above vacuous.
const verbose = run(newBin.cmd, [...newBin.args, 'status', '--format', 'json', '--period', 'all'], {
  env: cliEnv(join(CACHES, 'workers-probe'), { CODEBURN_PARSE_WORKERS: '3', CODEBURN_VERBOSE: '1' }), cwd: WORK,
})
const decision = (verbose.stderr || '').split('\n').filter(l => l.includes('parse workers='))
if (decision.length === 0) skip('no "parse workers=" line on stderr; cannot confirm the pool was forced')
else check(decision.some(l => /parse workers=[1-9]/.test(l)), `worker pool engaged: ${decision.map(l => l.trim()).join(' | ')}`)

// ── 7. second run is warm ────────────────────────────────────────────────────

step('second run is warm')
const beforeBodies = shardSnapshot(upgradeCache)
const beforeMtimes = shardMtimes(upgradeCache)
const warm = capture(newBin, upgradeCache, join(PAYLOADS, 'warm'))

// The direct no-re-parse signal: the worker gate prints how many whole-file
// re-parses are pending. On an unchanged corpus that must be zero for the two
// providers big enough to be gated.
const warmVerbose = run(newBin.cmd, [...newBin.args, 'status', '--format', 'menubar-json', '--period', 'all', '--no-optimize', '--no-timeline'], {
  env: cliEnv(upgradeCache, { CODEBURN_VERBOSE: '1' }), cwd: WORK,
})
const pending = (warmVerbose.stderr || '').split('\n').filter(l => l.includes('parse workers='))
if (pending.length === 0) skip('no "parse workers=" line on a warm run; cannot confirm nothing re-parsed')
else check(pending.every(l => /0 pending files|no full parses pending/.test(l)),
  `nothing re-parsed on the warm run: ${pending.map(l => l.replace(/^codeburn: /, '').trim()).join(' | ')}`)

check(JSON.stringify(shardSnapshot(upgradeCache)) === JSON.stringify(beforeBodies), 'warm run left every shard body unchanged')
check(JSON.stringify(stripGenerated(warm.menubar)) === JSON.stringify(stripGenerated(upgraded.menubar)),
  'warm run reports the same payload as the run that migrated the cache')

// Republication without a content change is wasted I/O, not a correctness
// problem, so it is reported rather than failed. It is real, and it has a
// follow-up issue: a date-RANGED query (`status --format json`, the
// statusline/menubar fast path) republishes the month shards its range skipped,
// on every run, even when nothing changed — partially defeating #1007's
// "a warm launch rewrites only the month that changed". The identical-bodies
// check above is what proves the content survives it.
const afterMtimes = shardMtimes(upgradeCache)
const republished = Object.keys(afterMtimes).filter(n => n !== 'envelope.json' && beforeMtimes[n] !== afterMtimes[n])
const retired = Object.keys(beforeMtimes).filter(n => n !== 'envelope.json' && !(n in afterMtimes))
const churnNote = 'known defect, follow-up issue pending: a date-ranged run republishes the month shards it skipped'
if (retired.length) console.log(`  note  ${retired.length} shard(s) republished under a new name with identical content (${churnNote}): ${retired.join(', ')}`)
else if (republished.length) console.log(`  note  ${republished.length} shard(s) rewritten in place (${churnNote}): ${republished.join(', ')}`)
else ok('no shard republished on an unchanged corpus')

// ── 8. partial source aging (release blocker, track C) ───────────────────────
// Claude Code deletes its transcripts after ~30 days, so between one run and the
// next a day can go from fully sourced to PARTIALLY sourced. The daily cache's
// never-lose contract says a schema bump re-derives what it can and carries
// forward what it cannot — but on a partially-sourced day the re-derivation
// produces a smaller slice from the surviving files and that slice REPLACES the
// baseline one instead of being unioned with it, so the aged-out portion is lost.
// A day that aged out completely is carried forward correctly, which is what
// makes the partial case a hole rather than a missing feature.
//
// Runs last, and on its own cache dir, so mutating the corpus cannot disturb the
// parity comparison above.

step('never-lose across partial source aging')
const agingCache = join(CACHES, 'aging')
mkdirSync(agingCache, { recursive: true })

// A fresh 0.9.20 cache, taken while every transcript still exists.
capture(oldBin, agingCache, join(PAYLOADS, 'aging-baseline'))
const baseDaily = JSON.parse(readFileSync(join(agingCache, OLD_DAILY_CACHE), 'utf8'))
const sliceOf = (cache, date) => cache.days.find(d => d.date === date)?.providers?.claude

// Group transcripts by the day their turns land on. Sidechain files are left out:
// deleting a parent's subagent transcript entangles this with spawn-link
// carry-forward, which is a different contract.
const projectsDir = join(HOME, '.claude', 'projects')
const byDay = new Map()
for (const rel of readdirSync(projectsDir, { recursive: true })) {
  const relPath = String(rel)
  if (!relPath.endsWith('.jsonl') || relPath.includes('subagents')) continue
  const full = join(projectsDir, relPath)
  const first = readFileSync(full, 'utf8').split('\n', 1)[0]
  const date = JSON.parse(first).timestamp?.slice(0, 10)
  if (!date || !sliceOf(baseDaily, date)) continue
  if (!byDay.has(date)) byDay.set(date, [])
  byDay.get(date).push(full)
}

// Densest days first, oldest among equals — the ones a retention window reaches
// first, and the ones where losing the aged-out portion shows up largest.
const candidates = [...byDay.entries()].filter(([, files]) => files.length >= 2)
  .sort((a, b) => (b[1].length - a[1].length) || a[0].localeCompare(b[0]))

let aged = []
if (candidates.length < 3) fail(`need 3 multi-transcript claude days to age out, found ${candidates.length}`)
else {
  for (const [date, files] of candidates.slice(0, 2)) {
    // Keep exactly one file, so the day is still sourced — just not fully.
    for (const f of files.slice(1)) rmSync(f)
    aged.push({ date, kind: 'partially sourceless', kept: 1, removed: files.length - 1 })
  }
  const [goneDate, goneFiles] = candidates[2]
  for (const f of goneFiles) rmSync(f)
  aged.push({ date: goneDate, kind: 'fully sourceless', kept: 0, removed: goneFiles.length })
  for (const a of aged) ok(`${a.date}: ${a.kind} (removed ${a.removed} of ${a.removed + a.kept} transcripts)`)

  capture(newBin, agingCache, join(PAYLOADS, 'aging-upgraded'))
  const upDaily = JSON.parse(readFileSync(join(agingCache, NEW_DAILY_CACHE), 'utf8'))
  const usd = n => `$${n.toFixed(6)}`

  for (const a of aged) {
    const b = sliceOf(baseDaily, a.date)
    const u = sliceOf(upDaily, a.date)
    if (!u) { fail(`${a.date} (${a.kind}): the claude slice is gone entirely; baseline had ${usd(b.cost)} over ${b.calls} calls`); continue }
    // A fully sourceless day has nothing to re-derive, so it must come back
    // EXACTLY. A partially sourceless one may legitimately grow (a re-parse
    // under new accounting), but must never shrink.
    const exact = a.kind === 'fully sourceless'
    const costOk = exact ? Math.abs(u.cost - b.cost) < 1e-9 : u.cost >= b.cost - 1e-9
    const callsOk = exact ? u.calls === b.calls : u.calls >= b.calls
    const loss = costOk && callsOk ? '' :
      ` — LOST ${usd(b.cost - u.cost)} (${(100 * (b.cost - u.cost) / b.cost).toFixed(1)}%) and ${b.calls - u.calls} calls`
    check(costOk && callsOk,
      `${a.date} (${a.kind}): cost ${usd(b.cost)} -> ${usd(u.cost)}, calls ${b.calls} -> ${u.calls}${loss}`)
  }
}

// ── done ─────────────────────────────────────────────────────────────────────

console.log(`\n${failures ? `FAILED: ${failures} check(s)` : 'PASSED'}${skipped ? ` (${skipped} skipped)` : ''}`)
if (failures && process.env['UPGRADE_PATH_KEEP'] !== '0') console.log(`payloads left in: ${PAYLOADS}`)
else if (process.env['UPGRADE_PATH_KEEP'] !== '1') { try { rmSync(WORK, { recursive: true, force: true }) } catch { /* windows file locks */ } }
process.exit(failures ? 1 : 0)
