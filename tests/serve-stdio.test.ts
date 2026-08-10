import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'child_process'
import { join } from 'path'

// End-to-end protocol test for `codeburn serve --stdio` (the desktop app's
// resident query server). Runs the real entry through tsx against the
// test-isolated env (env-isolation.ts points every provider at empty dirs),
// so requests answer fast and deterministically empty.
describe('codeburn serve --stdio', () => {
  let child: ChildProcess
  let buffer = ''
  const waiters = new Map<number, (msg: Record<string, unknown>) => void>()
  let readyResolve: () => void
  const ready = new Promise<void>(resolve => { readyResolve = resolve })

  function request(id: number, args: string[]): Promise<Record<string, unknown>> {
    return new Promise(resolve => {
      waiters.set(id, resolve)
      child.stdin!.write(JSON.stringify({ id, args }) + '\n')
    })
  }

  function sendRaw(line: string): void {
    child.stdin!.write(line + '\n')
  }

  beforeAll(async () => {
    child = spawn(process.execPath, ['--import', 'tsx', join(__dirname, '..', 'src', 'cli.ts'), 'serve', '--stdio'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env },
    })
    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (chunk: string) => {
      buffer += chunk
      let idx: number
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (!line) continue
        let msg: Record<string, unknown>
        try { msg = JSON.parse(line) } catch { continue }
        if (msg['ready']) { readyResolve(); continue }
        const waiter = waiters.get(msg['id'] as number)
        if (waiter) { waiters.delete(msg['id'] as number); waiter(msg) }
      }
    })
    await ready
  }, 60_000)

  afterAll(() => {
    child?.kill('SIGKILL')
  })

  it('answers an allowed query with the command stdout', async () => {
    const res = await request(1, ['status', '--format', 'menubar-json', '--period', 'today'])
    expect(res['ok']).toBe(true)
    const payload = JSON.parse(res['output'] as string) as { current: { label: string } }
    expect(payload.current.label).toContain('Today')
  }, 60_000)

  it('isolates option state between requests (no sticky --period)', async () => {
    // The whole reason serve rebuilds the program per request: commander
    // option state is sticky, and a leaked --period would mislabel every
    // later panel.
    const month = await request(2, ['status', '--format', 'menubar-json', '--period', 'month'])
    const today = await request(3, ['status', '--format', 'menubar-json', '--period', 'today'])
    const monthLabel = (JSON.parse(month['output'] as string) as { current: { label: string } }).current.label
    const todayLabel = (JSON.parse(today['output'] as string) as { current: { label: string } }).current.label
    expect(monthLabel).not.toBe(todayLabel)
    expect(todayLabel).toContain('Today')
  }, 60_000)

  it('refuses commands outside the read allowlist', async () => {
    const res = await request(4, ['currency', 'EUR'])
    expect(res['ok']).toBe(false)
    expect(res['refused']).toBe(true)
  })

  it('refuses a smuggled positional on an allowed command', async () => {
    const res = await request(5, ['sessions', 'positional-arg'])
    expect(res['ok']).toBe(false)
    expect(res['refused']).toBe(true)
  })

  it('survives a malformed request line and keeps serving', async () => {
    sendRaw('this is not json')
    const res = await request(6, ['status', '--format', 'menubar-json', '--period', 'today'])
    expect(res['ok']).toBe(true)
  }, 60_000)
})
