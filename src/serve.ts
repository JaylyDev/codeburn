import { watch, type FSWatcher } from 'fs'
import { stat } from 'fs/promises'
import { createInterface } from 'readline'

import type { Command } from 'commander'

// ---------------------------------------------------------------------------
// codeburn serve --stdio: a resident query server for the desktop app.
//
// Every CLI spawn on a large corpus pays seconds of fixed cost before any
// work: parsing a 100MB+ session-cache JSON, then re-deriving classification
// at query time. The desktop app fetches one payload per panel, so it pays
// that cost per fetch. This server is the same CLI kept warm: the app sends
// one JSON request per line ({id, args}) and gets the command's stdout back
// ({id, ok, output}); the session-cache memo in session-cache.ts makes every
// request after the first skip the JSON reload (a stat() revalidates, so a
// rewrite by another process still forces a fresh read).
//
// Correctness stance:
// - READ-ONLY allowlist. Only the hot panel queries run in-process; anything
//   else is rejected and the app falls back to a normal spawn. A rejected
//   command is a routing decision, not an error.
// - A FRESH commander program per request (buildProgram()), because commander
//   option state is sticky across parses — reusing one program would leak
//   `--period week` from one request into the defaults of the next.
// - Requests are strictly serialized. The parse/refresh pipeline is not
//   concurrent-safe within one process, and the cross-process refresh lock
//   already guards between processes.
// ---------------------------------------------------------------------------

// First-token allowlist of the app's heavy read queries. Deliberately absent:
// every config mutation (currency, model-alias set, budget, price-override,
// proxy-path, plan), export (writes files), share/devices (network + pairing
// state), menubar/web/mcp/guard/sync/act (process management or writes).
// Past this resident-set size the serve loop drops its in-memory memos and
// re-parses on the next request. 3GB leaves generous room for the largest
// observed corpora while bounding a pathological one.
const SERVE_MAX_RSS_BYTES = 3 * 1024 * 1024 * 1024

const SERVE_COMMANDS = new Set(['status', 'overview', 'models', 'sessions', 'compare', 'yield', 'spend', 'optimize', 'audit'])

type ServeRequest = { id: string | number; args: string[] }

function isServeRequest(value: unknown): value is ServeRequest {
  if (!value || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  const idOk = typeof r['id'] === 'string' || typeof r['id'] === 'number'
  return idOk && Array.isArray(r['args']) && (r['args'] as unknown[]).every(a => typeof a === 'string')
}

function allowed(args: string[]): boolean {
  const first = args[0]
  if (!first || !SERVE_COMMANDS.has(first)) return false
  // No request may smuggle a second positional that turns a read into
  // something else; the allowed commands take flags only.
  return args.slice(1).every((a, i, all) => a.startsWith('-') || (i > 0 && all[i - 1]!.startsWith('--')))
}

class ExitSignal extends Error {
  constructor(public readonly code: number) { super(`exit ${code}`) }
}

/// Run one argv through a fresh program, capturing everything the command
/// writes to stdout. process.exit inside a handler is converted to a thrown
/// ExitSignal so a failing request can never take the server down.
async function runCaptured(buildProgram: () => Command, args: string[]): Promise<{ output: string; code: number }> {
  const chunks: string[] = []
  const originalWrite = process.stdout.write.bind(process.stdout)
  const originalExit = process.exit.bind(process)

  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    chunks.push(typeof chunk === 'string' ? chunk : String(chunk))
    const last = rest[rest.length - 1]
    if (typeof last === 'function') (last as () => void)()
    return true
  }) as typeof process.stdout.write
  process.exit = ((code?: number) => { throw new ExitSignal(code ?? 0) }) as typeof process.exit

  try {
    const program = buildProgram()
    program.exitOverride()
    await program.parseAsync(['node', 'codeburn', ...args])
    return { output: chunks.join(''), code: 0 }
  } catch (err) {
    if (err instanceof ExitSignal) return { output: chunks.join(''), code: err.code }
    throw err
  } finally {
    process.stdout.write = originalWrite
    process.exit = originalExit
  }
}

/// Watch every provider's probe roots (the same paths codeburn doctor reports
/// as "where discovery looks") so the parse-reuse validator can answer "did
/// any session data change since T?" without a stat sweep. macOS fs.watch
/// rides FSEvents and supports recursive directory watches; a root that fails
/// to watch is simply not covered, which only shortens reuse (the burst
/// window and the hard cap still apply), never staleness.
async function startRootWatchers(): Promise<{ startedAt: number; lastEventAt: () => number; close: () => void }> {
  let lastEventAt = 0
  const startedAt = Date.now()
  const watchers: FSWatcher[] = []
  try {
    const { getAllProviders } = await import('./providers/index.js')
    const providers = await getAllProviders()
    const roots = new Set<string>()
    for (const provider of providers) {
      if (!provider.probeRoots) continue
      try {
        for (const root of await provider.probeRoots()) roots.add(root.path)
      } catch { /* a failing probe just goes unwatched */ }
    }
    for (const root of roots) {
      try {
        const info = await stat(root)
        const watcher = watch(root, { recursive: info.isDirectory() }, () => { lastEventAt = Date.now() })
        watcher.on('error', () => { /* dropped watcher = shorter reuse, never staleness */ })
        watchers.push(watcher)
      } catch { /* nonexistent root: nothing to watch */ }
    }
  } catch { /* watcherless serve still works via the burst window */ }
  return {
    startedAt,
    lastEventAt: () => lastEventAt,
    close: () => { for (const w of watchers) w.close() },
  }
}

export async function runStdioServe(buildProgram: () => Command): Promise<void> {
  // Panel bursts (the app fetching every panel for one period) reuse a parse
  // whose through-now range end differs by less than this window, instead of
  // re-running the discovery sweep per panel. Serve-only: one-shot CLI runs
  // never set this, so their results stay byte-exact.
  if (!process.env['CODEBURN_PARSE_BURST_MS']) process.env['CODEBURN_PARSE_BURST_MS'] = '10000'
  // Event-driven reuse: while no watched session root has changed, a previous
  // parse stays valid past the burst window (capped in parser.ts, so a missed
  // filesystem event self-heals within minutes). This is what turns a warm
  // no-change fetch into a no-op instead of a stat sweep.
  let rootsQuietSince: ((sinceTs: number) => boolean) | null = null
  void startRootWatchers().then(async (w) => {
    const { setParseReuseValidator } = await import('./parser.js')
    // Clean means: the watchers were already armed when the parse happened,
    // and no filesystem event has landed since. lastEventAt of 0 is a quiet
    // system (clean for anything parsed after arming), not an unknown.
    const quiet = (sinceTs: number): boolean => sinceTs >= w.startedAt && w.lastEventAt() < sinceTs
    rootsQuietSince = quiet
    setParseReuseValidator(quiet)
  }).catch(() => { /* watcherless serve still works via the burst window */ })

  // Output-level memo: an identical panel query while the roots are quiet
  // returns the previous stdout verbatim - the aggregation work is skipped
  // too, not just the parse. Invalidation is the same event-or-cap rule the
  // parse reuse uses.
  const OUTPUT_MEMO_CAP_MS = 5 * 60 * 1000
  const outputMemo = new Map<string, { at: number; output: string }>()
  if (process.stdin.isTTY) {
    process.stderr.write('codeburn serve speaks JSON over stdio and exists for the desktop app to hold warm.\nNothing interactive happens here; press Ctrl+C to exit.\n')
  }
  const write = (value: unknown): void => { process.stdout.write(JSON.stringify(value) + '\n') }
  write({ ready: true, pid: process.pid })

  // Strict serialization: each request chains on the previous one.
  let queue: Promise<void> = Promise.resolve()

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    queue = queue.then(async () => {
      let request: unknown
      try {
        request = JSON.parse(trimmed)
      } catch {
        write({ id: null, ok: false, error: 'malformed request line' })
        return
      }
      if (!isServeRequest(request)) {
        write({ id: (request as { id?: unknown })?.id ?? null, ok: false, error: 'malformed request' })
        return
      }
      if (!allowed(request.args)) {
        // Routing signal, not a failure: the client falls back to a spawn.
        write({ id: request.id, ok: false, refused: true, error: 'command not served' })
        return
      }
      const memoKey = request.args.join('\u0000')
      const memoHit = outputMemo.get(memoKey)
      if (memoHit && Date.now() - memoHit.at < OUTPUT_MEMO_CAP_MS && rootsQuietSince?.(memoHit.at)) {
        write({ id: request.id, ok: true, output: memoHit.output })
        return
      }
      try {
        const { output, code } = await runCaptured(buildProgram, request.args)
        if (code === 0) {
          outputMemo.set(memoKey, { at: Date.now(), output })
          if (outputMemo.size > 32) {
            const oldest = [...outputMemo.entries()].sort((a, b) => a[1].at - b[1].at)[0]
            if (oldest) outputMemo.delete(oldest[0])
          }
          write({ id: request.id, ok: true, output })
        }
        else write({ id: request.id, ok: false, error: `exit ${code}`, output })
      } catch (err) {
        write({ id: request.id, ok: false, error: err instanceof Error ? err.message : String(err) })
      }
      // Memory guard: a resident process accumulates parse memos that a
      // one-shot CLI never lives long enough to hold (up to 10 entries of
      // full ProjectSummary trees plus the parsed cache object). Past the
      // threshold, drop the in-memory memos — the next request re-parses
      // once (seconds), which beats an ever-growing child. The child itself
      // never exits here, so the client's death counter is untouched.
      if (process.memoryUsage().rss > SERVE_MAX_RSS_BYTES) {
        const { clearSessionCache } = await import('./parser.js')
        const { clearLoadCacheMemo } = await import('./session-cache.js')
        clearSessionCache()
        clearLoadCacheMemo()
        if (typeof globalThis.gc === 'function') globalThis.gc()
      }
    })
  })

  // The app owns this process: stdin closing means the app is gone.
  await new Promise<void>((resolve) => {
    rl.on('close', resolve)
    process.stdin.on('end', resolve)
  })
}
