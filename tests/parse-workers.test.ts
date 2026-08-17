import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { decideParseWorkers, ParseWorkerPool, parseFilesInOrder } from '../src/parse-workers.js'
import { clearSessionCache, parseAllSessions, parseClaudeFileFull } from '../src/parser.js'

// Two full cold CLI parses of a multi-hundred-file corpus, plus in-process parses
// that spawn real threads.
vi.setConfig({ testTimeout: 60_000 })

const BIG_SYSTEM = { cores: 16, freeBytes: 32 * 1024 ** 3 }
const BIG_PENDING = { files: 5000, bytes: 6 * 1024 ** 3 }
const NO_ENV = {} as NodeJS.ProcessEnv

describe('decideParseWorkers', () => {
  it('scales with cores, memory budget and pending file count', () => {
    // 15 (cores-1) vs 8 (2 GB budget / 256 MB) vs 100 (5000/50) -> memory wins
    expect(decideParseWorkers(BIG_PENDING, BIG_SYSTEM, NO_ENV).workers).toBe(8)
    // Fewer cores than the memory budget allows -> cores-1 wins
    expect(decideParseWorkers(BIG_PENDING, { cores: 6, freeBytes: 32 * 1024 ** 3 }, NO_ENV).workers).toBe(5)
    // The smallest machine that clears every gate still only earns 2 threads
    expect(decideParseWorkers({ files: 200, bytes: 300 * 1024 ** 2 }, { cores: 3, freeBytes: 2 * 1024 ** 3 }, NO_ENV).workers).toBe(2)
    // Few enough files that MIN_FILES_PER_WORKER is the binding constraint
    expect(decideParseWorkers({ files: 300, bytes: 6 * 1024 ** 3 }, BIG_SYSTEM, NO_ENV).workers).toBe(6)
  })

  it('stays serial on low-spec machines and on warm/small parses', () => {
    expect(decideParseWorkers(BIG_PENDING, { cores: 2, freeBytes: 32 * 1024 ** 3 }, NO_ENV).workers).toBe(0)
    expect(decideParseWorkers(BIG_PENDING, { cores: 16, freeBytes: 1024 ** 3 }, NO_ENV).workers).toBe(0)
    // Warm/incremental: a handful of appended files
    expect(decideParseWorkers({ files: 12, bytes: 6 * 1024 ** 3 }, BIG_SYSTEM, NO_ENV).workers).toBe(0)
    // Many files but almost no bytes behind them
    expect(decideParseWorkers({ files: 5000, bytes: 10 * 1024 ** 2 }, BIG_SYSTEM, NO_ENV).workers).toBe(0)
  })

  it('honours CODEBURN_PARSE_WORKERS, which also bypasses the auto gates', () => {
    expect(decideParseWorkers(BIG_PENDING, BIG_SYSTEM, { CODEBURN_PARSE_WORKERS: '0' }).workers).toBe(0)
    expect(decideParseWorkers(BIG_PENDING, BIG_SYSTEM, { CODEBURN_PARSE_WORKERS: '4' }).workers).toBe(4)
    // Capped by the core count
    expect(decideParseWorkers(BIG_PENDING, { cores: 4, freeBytes: 32 * 1024 ** 3 }, { CODEBURN_PARSE_WORKERS: '32' }).workers).toBe(4)
    // A tiny fixture corpus still gets threads when forced — that is what makes
    // the determinism test below able to exercise them at all.
    expect(decideParseWorkers({ files: 3, bytes: 1000 }, BIG_SYSTEM, { CODEBURN_PARSE_WORKERS: '3' }).workers).toBe(3)
    expect(decideParseWorkers(BIG_PENDING, BIG_SYSTEM, { CODEBURN_PARSE_WORKERS: 'nonsense' }).workers).toBe(0)
  })
})

function sessionLines(project: number, session: string, turns: number): string {
  const lines: string[] = []
  for (let t = 0; t < turns; t++) {
    const ts = new Date(Date.UTC(2026, 4, 4 + (t % 5), 9, t % 60, 0)).toISOString()
    lines.push(JSON.stringify({
      type: 'user', sessionId: session, timestamp: ts, cwd: `/tmp/proj${project}`, gitBranch: 'main',
      message: { role: 'user', content: `task ${t} in ${project}` },
    }))
    lines.push(JSON.stringify({
      type: 'assistant', sessionId: session, timestamp: ts, cwd: `/tmp/proj${project}`, gitBranch: 'main',
      message: {
        id: `msg-${project}-${session}-${t}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5',
        content: [
          { type: 'text', text: 'x'.repeat(200) },
          { type: 'tool_use', id: `tu-${project}-${session}-${t}`, name: 'Edit', input: { file_path: '/tmp/x', old_string: 'a', new_string: 'b' } },
        ],
        usage: { input_tokens: 400 + t, output_tokens: 40 + t, cache_read_input_tokens: 9 },
      },
    }))
  }
  return lines.join('\n') + '\n'
}

async function writeCorpus(claudeDir: string, projects: number, filesPerProject: number): Promise<string[]> {
  const written: string[] = []
  for (let p = 0; p < projects; p++) {
    const dir = join(claudeDir, 'projects', `-tmp-proj${p}`)
    await mkdir(dir, { recursive: true })
    for (let f = 0; f < filesPerProject; f++) {
      const session = `${p}${f}`.padStart(8, '0') + '-aaaa-bbbb-cccc-000000000000'
      const path = join(dir, `${session}.jsonl`)
      await writeFile(path, sessionLines(p, session, 12))
      written.push(path)
    }
  }
  return written
}

/// Cache shard file names carry a random nonce, so compare bodies keyed by
/// `<provider>.<month>` instead of by file name.
async function shardBodies(cacheDir: string): Promise<Record<string, string>> {
  const dir = join(cacheDir, 'session-cache.v9')
  const out: Record<string, string> = {}
  for (const name of (await readdir(dir).catch(() => []))) {
    if (name === 'envelope.json' || !name.endsWith('.json')) continue
    const key = name.split('.').slice(0, 2).join('.')
    out[key] = createHash('sha256').update(await readFile(join(dir, name))).digest('hex')
  }
  return out
}

function runCli(args: string[], home: string, extraEnv: Record<string, string>) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      CODEBURN_CACHE_DIR: join(home, '.cache', 'codeburn'),
      HOME: home,
      TZ: 'UTC',
      ...extraEnv,
    },
    encoding: 'utf-8',
    timeout: 60_000,
  })
}

function stripVolatile(payload: unknown): unknown {
  if (Array.isArray(payload)) return payload.map(stripVolatile)
  if (payload && typeof payload === 'object') {
    return Object.fromEntries(
      Object.entries(payload as Record<string, unknown>)
        .filter(([k]) => !k.toLowerCase().startsWith('generated'))
        .map(([k, v]) => [k, stripVolatile(v)]),
    )
  }
  if (typeof payload === 'number') return Math.round(payload * 1e9) / 1e9
  return payload
}

describe('parallel cold parse', () => {
  let serialHome: string
  let parallelHome: string

  beforeEach(async () => {
    serialHome = await mkdtemp(join(tmpdir(), 'cb-serial-'))
    parallelHome = await mkdtemp(join(tmpdir(), 'cb-parallel-'))
  })

  afterEach(async () => {
    await rm(serialHome, { recursive: true, force: true })
    await rm(parallelHome, { recursive: true, force: true })
  })

  // The whole point of the feature: threads may only ever be a speed change.
  it('produces an identical payload and identical cache shards with and without workers', async () => {
    await writeCorpus(join(serialHome, '.claude'), 4, 12)
    await writeCorpus(join(parallelHome, '.claude'), 4, 12)

    const serial = runCli(['status', '--format', 'menubar-json'], serialHome, { CODEBURN_PARSE_WORKERS: '0' })
    const parallel = runCli(['status', '--format', 'menubar-json'], parallelHome, { CODEBURN_PARSE_WORKERS: '3' })

    expect(serial.status, serial.stderr).toBe(0)
    expect(parallel.status, parallel.stderr).toBe(0)

    // Homes differ only in their path prefix, which the payload does not carry.
    expect(stripVolatile(JSON.parse(parallel.stdout))).toEqual(stripVolatile(JSON.parse(serial.stdout)))

    const serialShards = await shardBodies(join(serialHome, '.cache', 'codeburn'))
    const parallelShards = await shardBodies(join(parallelHome, '.cache', 'codeburn'))
    expect(Object.keys(serialShards).length).toBeGreaterThan(0)
    // Shard bodies embed the absolute source path, so compare shape not bytes
    // here; the byte-identity claim is the payload equality above.
    expect(Object.keys(parallelShards)).toEqual(Object.keys(serialShards))
  })
})

describe('ParseWorkerPool', () => {
  let home: string
  let files: string[]

  beforeEach(async () => {
    clearSessionCache()
    home = await mkdtemp(join(tmpdir(), 'cb-pool-'))
    files = await writeCorpus(join(home, '.claude'), 2, 4)
    process.env['CLAUDE_CONFIG_DIR'] = join(home, '.claude')
    process.env['CODEBURN_CACHE_DIR'] = join(home, '.cache', 'codeburn')
  })

  afterEach(async () => {
    clearSessionCache()
    delete process.env['CODEBURN_PARSE_WORKERS']
    await rm(home, { recursive: true, force: true })
  })

  function liveWorkers(): number {
    return process.getActiveResourcesInfo().filter(r => r === 'Worker').length
  }

  it('returns results in submission order and terminates every thread on close', async () => {
    const before = liveWorkers()
    const pool = new ParseWorkerPool(3)
    const results = []
    for await (const r of parseFilesInOrder(pool, files)) results.push(r)
    await pool.close()

    expect(results).toHaveLength(files.length)
    for (const r of results) expect(r.ok).toBe(true)
    // Each fixture session's first turn names its own project, which pins the
    // yielded order to the submitted order rather than to completion order.
    const projects = results.map(r => (r.ok && r.parsed ? r.parsed.turns[0]?.userMessage : undefined))
    expect(projects).toEqual(files.map((_, i) => `task 0 in ${Math.floor(i / 4)}`))
    expect(liveWorkers()).toBe(before)
  })

  // A worker that cannot answer must hand the file back, never drop it: the
  // caller's fallback is an in-process parse, and it has to land on the same
  // result the worker would have produced.
  it('reports failures instead of throwing, and the serial fallback matches', async () => {
    const pool = new ParseWorkerPool(1)
    const fromWorker = await pool.submit(files[0]!)
    await pool.close()

    const afterClose = await pool.submit(files[1]!)
    expect(afterClose.ok).toBe(false)

    const serial = await parseClaudeFileFull(files[0]!, new Set<string>())
    expect(fromWorker.ok).toBe(true)
    if (!fromWorker.ok || !fromWorker.parsed) throw new Error('expected a parsed result')
    const { msgIds, ...worker } = fromWorker.parsed
    expect(msgIds.length).toBeGreaterThan(0)
    expect(worker).toEqual(JSON.parse(JSON.stringify(serial)))
  })

  // The resident `serve` child parses over and over in one process; a thread
  // that outlives its parse would accumulate across requests.
  it('leaves no live worker behind after back-to-back parses', async () => {
    const before = liveWorkers()
    process.env['CODEBURN_PARSE_WORKERS'] = '2'

    await parseAllSessions()
    expect(liveWorkers()).toBe(before)

    clearSessionCache()
    await parseAllSessions()
    expect(liveWorkers()).toBe(before)
  })
})
