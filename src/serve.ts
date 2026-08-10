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

export async function runStdioServe(buildProgram: () => Command): Promise<void> {
  // Panel bursts (the app fetching every panel for one period) reuse a parse
  // whose through-now range end differs by less than this window, instead of
  // re-running the discovery sweep per panel. Serve-only: one-shot CLI runs
  // never set this, so their results stay byte-exact.
  if (!process.env['CODEBURN_PARSE_BURST_MS']) process.env['CODEBURN_PARSE_BURST_MS'] = '10000'
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
      try {
        const { output, code } = await runCaptured(buildProgram, request.args)
        if (code === 0) write({ id: request.id, ok: true, output })
        else write({ id: request.id, ok: false, error: `exit ${code}`, output })
      } catch (err) {
        write({ id: request.id, ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    })
  })

  // The app owns this process: stdin closing means the app is gone.
  await new Promise<void>((resolve) => {
    rl.on('close', resolve)
    process.stdin.on('end', resolve)
  })
}
