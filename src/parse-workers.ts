import { availableParallelism, freemem } from 'os'
import { Worker } from 'worker_threads'
import { snapshotPricingState } from './models.js'
import type { ClaudeFileParse } from './parser.js'

// Each worker holds one file's entry list plus its serialized result. 256 MB is
// the observed high-water mark for the largest real session files; going over the
// budget is what turns a parallel parse into a swapping one.
const PER_WORKER_RSS_BYTES = 256 * 1024 * 1024
const MEMORY_BUDGET_CAP_BYTES = 2 * 1024 * 1024 * 1024
const MIN_FILES_PER_WORKER = 50
// Below these, a parse is warm/incremental and the thread startup + result
// transfer costs more than the parallelism buys.
const MIN_PENDING_FILES = 200
const MIN_PENDING_BYTES = 200 * 1024 * 1024

export type ParseWorkerDecision = { workers: number; reason: string }

export type SystemCapacity = { cores: number; freeBytes: number }

function currentSystemCapacity(): SystemCapacity {
  return { cores: availableParallelism(), freeBytes: freemem() }
}

/// Decide how many parse worker threads a pending workload earns. Returning 0
/// means "parse serially" — the only behaviour before this existed, and still
/// the behaviour for every warm run, every small corpus, and every low-spec box.
export function decideParseWorkers(
  pending: { files: number; bytes: number },
  sys: SystemCapacity = currentSystemCapacity(),
  env: NodeJS.ProcessEnv = process.env,
): ParseWorkerDecision {
  const override = env['CODEBURN_PARSE_WORKERS']
  if (override !== undefined && override !== '') {
    const n = Number(override)
    if (!Number.isFinite(n) || n < 0) return { workers: 0, reason: `invalid CODEBURN_PARSE_WORKERS=${override}` }
    const capped = Math.min(Math.floor(n), sys.cores)
    return { workers: capped, reason: capped === 0 ? 'forced serial (CODEBURN_PARSE_WORKERS=0)' : `forced by CODEBURN_PARSE_WORKERS=${override}` }
  }

  // Workload gates first, so a warm run's log line says "warm", not whatever the
  // machine happened to look like at that moment.
  if (pending.files < MIN_PENDING_FILES) return { workers: 0, reason: `${pending.files} pending files below ${MIN_PENDING_FILES}` }
  if (pending.bytes < MIN_PENDING_BYTES) return { workers: 0, reason: `${Math.round(pending.bytes / 1e6)} MB pending below ${Math.round(MIN_PENDING_BYTES / 1e6)} MB` }
  if (sys.cores <= 2) return { workers: 0, reason: `only ${sys.cores} cores available` }
  if (sys.freeBytes < 2 * 1024 * 1024 * 1024) return { workers: 0, reason: `only ${Math.round(sys.freeBytes / 1e6)} MB free memory` }

  const memoryBudget = Math.min(0.4 * sys.freeBytes, MEMORY_BUDGET_CAP_BYTES)
  const workers = Math.min(
    sys.cores - 1,
    Math.floor(memoryBudget / PER_WORKER_RSS_BYTES),
    Math.floor(pending.files / MIN_FILES_PER_WORKER),
  )
  return { workers, reason: `${sys.cores} cores, ${Math.round(sys.freeBytes / 1e9 * 10) / 10} GB free, ${pending.files} pending files` }
}

// In dist the entry is the bundled sibling of this module and a worker can load
// it directly. Running from source (tsx, vitest) the entry is TypeScript, and a
// worker thread inherits none of the parent's loader hooks — so register tsx's
// inside the thread before importing. tsx is a devDependency, which is exactly
// the only situation where the entry can be a .ts file at all.
function workerBootstrap(entryUrl: string): { source: string | URL; eval: boolean } {
  if (!entryUrl.endsWith('.ts')) return { source: new URL(entryUrl), eval: false }
  return {
    eval: true,
    // Chained, not awaited: the eval scope is CommonJS, and a top-level await of
    // the entry re-enters it as a require(esm) cycle.
    source: `
process.noDeprecation = true
import('tsx/esm/api').then(tsx => { tsx.register(); return import(${JSON.stringify(entryUrl)}) })
`,
  }
}

function workerEntryUrl(): string {
  const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js'
  return new URL(`./parse-worker${ext}`, import.meta.url).href
}

export type ClaudeWorkerResult =
  | { ok: true; parsed: (ClaudeFileParse & { msgIds: string[] }) | null }
  | { ok: false; error: string }

type Task = { filePath: string; resolve: (r: ClaudeWorkerResult) => void }

type WorkerMessage = { json?: string | null; error?: string }

export class ParseWorkerPool {
  private readonly workers: Worker[] = []
  private readonly idle: Worker[] = []
  private readonly inflight = new Map<Worker, Task>()
  private readonly queue: Task[] = []
  private closed = false

  constructor(size: number) {
    const boot = workerBootstrap(workerEntryUrl())
    const workerData = { pricing: snapshotPricingState() }
    try {
      for (let i = 0; i < size; i++) {
        const worker = new Worker(boot.source, { eval: boot.eval, workerData })
        worker.on('message', (msg: WorkerMessage) => this.settle(worker, msg))
        worker.on('error', (err: Error) => this.settle(worker, { error: err.message }, true))
        worker.on('exit', () => this.drop(worker))
        this.workers.push(worker)
        this.idle.push(worker)
      }
    } catch (err) {
      for (const w of this.workers) void w.terminate()
      this.workers.length = 0
      this.idle.length = 0
      throw err
    }
  }

  get size(): number {
    return this.workers.length
  }

  /// Parse one file off-thread. Never rejects: a worker-side failure (or a dead
  /// pool) comes back as `ok: false` so the caller can fall back to an in-process
  /// parse and never lose a file to a crashed thread.
  submit(filePath: string): Promise<ClaudeWorkerResult> {
    return new Promise<ClaudeWorkerResult>((resolve) => {
      if (this.closed || this.workers.length === 0) {
        resolve({ ok: false, error: 'parse worker pool unavailable' })
        return
      }
      this.queue.push({ filePath, resolve })
      this.pump()
    })
  }

  async close(): Promise<void> {
    this.closed = true
    const pending = [...this.queue]
    this.queue.length = 0
    for (const task of pending) task.resolve({ ok: false, error: 'parse worker pool closed' })
    await Promise.all(this.workers.map(w => w.terminate()))
    this.workers.length = 0
    this.idle.length = 0
    this.inflight.clear()
  }

  private pump(): void {
    while (this.queue.length > 0 && this.idle.length > 0) {
      const worker = this.idle.pop()!
      const task = this.queue.shift()!
      this.inflight.set(worker, task)
      worker.postMessage({ filePath: task.filePath })
    }
  }

  private settle(worker: Worker, msg: WorkerMessage, fatal = false): void {
    const task = this.inflight.get(worker)
    this.inflight.delete(worker)
    if (task) {
      if (msg.error !== undefined) task.resolve({ ok: false, error: msg.error })
      else task.resolve({ ok: true, parsed: msg.json == null ? null : JSON.parse(msg.json) })
    }
    if (fatal) return
    if (!this.closed) {
      this.idle.push(worker)
      this.pump()
    }
  }

  // A thread that died takes its queue slot with it; the remaining files are
  // handed back for a serial parse rather than being lost.
  private drop(worker: Worker): void {
    const i = this.workers.indexOf(worker)
    if (i >= 0) this.workers.splice(i, 1)
    const j = this.idle.indexOf(worker)
    if (j >= 0) this.idle.splice(j, 1)
    const task = this.inflight.get(worker)
    if (task) {
      this.inflight.delete(worker)
      task.resolve({ ok: false, error: 'parse worker exited' })
    }
    if (this.workers.length === 0) {
      const pending = [...this.queue]
      this.queue.length = 0
      for (const t of pending) t.resolve({ ok: false, error: 'all parse workers exited' })
    }
  }
}

/// Yield results for `filePaths` in the SAME order they were given, no matter
/// which worker finishes first. Keeps exactly `pool.size` files in flight, so at
/// most that many parsed results are buffered while the caller installs one.
export async function* parseFilesInOrder(
  pool: ParseWorkerPool,
  filePaths: readonly string[],
): AsyncGenerator<ClaudeWorkerResult, void, void> {
  const inflight: Array<Promise<ClaudeWorkerResult>> = []
  let next = 0
  const fill = (): void => {
    while (inflight.length < Math.max(1, pool.size) && next < filePaths.length) {
      inflight.push(pool.submit(filePaths[next++]!))
    }
  }
  fill()
  for (let i = 0; i < filePaths.length; i++) {
    const result = await inflight.shift()!
    fill()
    yield result
  }
}
