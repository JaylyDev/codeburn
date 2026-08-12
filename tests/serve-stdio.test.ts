import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'child_process'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'

// End-to-end protocol test for `codeburn serve --stdio` (the desktop app's
// resident query server). Runs the real entry through tsx against the
// test-isolated env (env-isolation.ts points every provider at empty dirs),
// so requests answer fast and deterministically empty.
describe('codeburn serve --stdio', () => {
  let child: ChildProcess
  let buffer = ''
  const waiters = new Map<number, (msg: Record<string, unknown>) => void>()
  const progressFrames = new Map<number, Array<Record<string, unknown>>>()
  let configPath = ''
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
    const home = process.env['HOME']!
    configPath = join(home, '.config', 'codeburn', 'config.json')
    await mkdir(join(home, '.config', 'codeburn'), { recursive: true })
    await writeFile(configPath, JSON.stringify({ currency: { code: 'USD' } }), 'utf8')

    // Keep the EUR half of the config-freshness regression fully offline.
    const cacheDir = join(home, '.cache', 'codeburn')
    await mkdir(cacheDir, { recursive: true })
    await writeFile(join(cacheDir, 'exchange-rate.json'), JSON.stringify({
      timestamp: Date.now(),
      code: 'EUR',
      rate: 0.9,
    }), 'utf8')

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
        if (typeof msg['progress'] === 'string' && !('ok' in msg)) {
          const id = msg['id'] as number
          const frames = progressFrames.get(id) ?? []
          frames.push(msg)
          progressFrames.set(id, frames)
          continue
        }
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

  it('streams captured command stderr as protocol progress frames', async () => {
    const res = await request(7, ['status', '--definitely-not-a-real-option'])
    expect(res['ok']).toBe(false)

    const frames = progressFrames.get(7) ?? []
    expect(frames.length).toBeGreaterThan(0)
    expect(frames.every(frame => Object.keys(frame).sort().join(',') === 'id,progress')).toBe(true)
    expect(frames.map(frame => frame['progress']).join('')).toContain('unknown option')
  }, 60_000)

  it('invalidates identical-argv output memo immediately when config.json changes', async () => {
    const args = ['status', '--format', 'menubar-json', '--period', 'week', '--no-optimize', '--no-timeline']
    const usdConfig = JSON.stringify({ currency: { code: 'USD' } })
    await writeFile(configPath, usdConfig, 'utf8')

    let previous = await request(8, args)
    expect(previous['ok']).toBe(true)
    expect((JSON.parse(previous['output'] as string) as { currency: { code: string } }).currency.code).toBe('USD')

    // Prove this argv is actually hitting the output memo before testing its
    // invalidation. The root watchers arm asynchronously at serve startup, so
    // allow a few requests until two byte-identical generated payloads arrive.
    let memoized: Record<string, unknown> | null = null
    for (let id = 9; id < 110; id++) {
      await new Promise(resolve => setTimeout(resolve, 20))
      const next = await request(id, args)
      if (next['output'] === previous['output']) {
        memoized = next
        break
      }
      previous = next
    }
    expect(memoized).not.toBeNull()

    // A byte-identical rewrite changes filesystem metadata but not effective
    // configuration. The memo must survive it and return the exact generated
    // payload, including the original volatile `generated` timestamp.
    await new Promise(resolve => setTimeout(resolve, 20))
    await writeFile(configPath, usdConfig, 'utf8')
    const sameBytes = await request(110, args)
    expect(sameBytes['ok']).toBe(true)
    expect(sameBytes['output']).toBe(memoized!['output'])

    // Same byte length as USD: a size-only fingerprint would miss this.
    await writeFile(configPath, JSON.stringify({ currency: { code: 'EUR' } }), 'utf8')
    const fresh = await request(111, args)
    expect(fresh['ok']).toBe(true)
    expect((JSON.parse(fresh['output'] as string) as { currency: { code: string } }).currency.code).toBe('EUR')
    expect(fresh['output']).not.toBe(memoized!['output'])

    // Removing the configured currency is the USD reset contract. The serve
    // process must reset its module-level currency state as well as invalidate
    // the output memo, otherwise a long-lived child keeps rendering EUR.
    await writeFile(configPath, '{}', 'utf8')
    const reset = await request(112, args)
    expect(reset['ok']).toBe(true)
    expect((JSON.parse(reset['output'] as string) as {
      currency: { code: string; rate: number }
    }).currency).toMatchObject({ code: 'USD', rate: 1 })
  }, 60_000)
})
