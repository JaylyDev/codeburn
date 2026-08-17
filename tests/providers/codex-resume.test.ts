// Codex rollouts are append-only and the active ones are huge, so a run that
// re-read a grown session from byte 0 paid for the whole file to pick up a few
// KB. The parser now restarts from the last task boundary it recorded. What has
// to hold: the resumed decode is byte-identical to a full re-parse, and it
// really does start at an offset rather than quietly re-reading everything.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { appendFile, mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

const readLineCalls: Array<{ filePath: string; startByteOffset?: number }> = []
vi.mock('../../src/fs-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/fs-utils.js')>()
  return {
    ...actual,
    readSessionLines: (filePath: string, skip?: unknown, options?: { startByteOffset?: number }) => {
      readLineCalls.push({ filePath, startByteOffset: options?.startByteOffset })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (actual.readSessionLines as any)(filePath, skip, options)
    },
  }
})

import { flushCodexCache, withCodexCacheDirectory } from '../../src/codex-cache.js'
import { createCodexProvider } from '../../src/providers/codex.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

let tmpDir: string
let sessionPath: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'codex-resume-'))
  readLineCalls.length = 0
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

function meta(): string {
  return JSON.stringify({
    type: 'session_meta',
    timestamp: '2026-04-14T10:00:00Z',
    payload: { cwd: '/Users/test/proj', originator: 'codex-cli', session_id: 'sess-1', model: 'gpt-5.3-codex' },
  })
}

// One complete task: user turn, tools, an edit, an MCP call, usage, completion.
function task(n: number, cumulative: { input: number; cached: number; output: number; reasoning: number }): string[] {
  const at = (s: number) => `2026-04-14T10:${String(n).padStart(2, '0')}:${String(s).padStart(2, '0')}Z`
  return [
    JSON.stringify({ type: 'event_msg', timestamp: at(0), payload: { type: 'task_started' } }),
    JSON.stringify({
      type: 'response_item', timestamp: at(1),
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `task ${n}` }] },
    }),
    JSON.stringify({
      type: 'response_item', timestamp: at(2),
      payload: { type: 'function_call', name: 'shell', call_id: `c${n}`, arguments: JSON.stringify({ command: `ls ${n}` }) },
    }),
    JSON.stringify({
      type: 'response_item', timestamp: at(3),
      payload: { type: 'function_call_output', call_id: `c${n}` },
    }),
    JSON.stringify({
      type: 'event_msg', timestamp: at(4),
      payload: {
        type: 'patch_apply_end', success: n % 2 === 0,
        changes: { [`/Users/test/proj/f${n}.ts`]: { unified_diff: '@@ -1 +1,2 @@\n-old\n+new\n+extra\n' } },
      },
    }),
    JSON.stringify({
      type: 'event_msg', timestamp: at(5),
      payload: { type: 'mcp_tool_call_end', call_id: `m${n}`, invocation: { server: 'github', tool: 'list' }, duration_ms: 120, result: { Ok: {} } },
    }),
    JSON.stringify({
      type: 'response_item', timestamp: at(6),
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x'.repeat(40) }] },
    }),
    JSON.stringify({
      type: 'event_msg', timestamp: at(7),
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 50, reasoning_output_tokens: 10, total_tokens: 180 },
          total_token_usage: {
            input_tokens: cumulative.input, cached_input_tokens: cumulative.cached,
            output_tokens: cumulative.output, reasoning_output_tokens: cumulative.reasoning,
            total_tokens: cumulative.input + cumulative.output + cumulative.reasoning,
          },
        },
      },
    }),
    JSON.stringify({ type: 'event_msg', timestamp: at(8), payload: { type: 'task_complete', duration_ms: 5000 } }),
  ]
}

function tasks(from: number, to: number): string[] {
  const lines: string[] = []
  for (let n = from; n <= to; n++) {
    lines.push(...task(n, { input: 100 * n, cached: 20 * n, output: 50 * n, reasoning: 10 * n }))
  }
  return lines
}

async function writeRollout(lines: string[]): Promise<string> {
  const dir = join(tmpDir, 'sessions', '2026', '04', '14')
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'rollout-sess-1.jsonl')
  await writeFile(path, lines.join('\n') + '\n')
  return path
}

async function parse(cacheDir: string): Promise<ParsedProviderCall[]> {
  return withCodexCacheDirectory(cacheDir, async () => {
    const provider = createCodexProvider(tmpDir)
    const sources = await provider.discoverSessions()
    const seenKeys = new Set<string>()
    const calls: ParsedProviderCall[] = []
    for (const source of sources) {
      for await (const call of provider.createSessionParser!(source, seenKeys).parse()) calls.push(call)
    }
    await flushCodexCache()
    return calls
  })
}

describe('codex incremental resume', () => {
  it('resumes at a task boundary and matches a full re-parse exactly', async () => {
    const warmCache = join(tmpDir, 'cache-warm')
    const coldCache = join(tmpDir, 'cache-cold')

    sessionPath = await writeRollout([meta(), ...tasks(1, 3)])
    const first = await parse(warmCache)
    expect(first.length).toBe(3)

    await appendFile(sessionPath, tasks(4, 6).join('\n') + '\n')

    readLineCalls.length = 0
    const resumed = await parse(warmCache)
    const resumeReads = readLineCalls.filter(c => c.filePath === sessionPath)
    // The parse re-entered the file at a boundary rather than at byte 0.
    expect(resumeReads.some(c => (c.startByteOffset ?? 0) > 0)).toBe(true)
    expect(resumeReads.every(c => (c.startByteOffset ?? 0) > 0)).toBe(true)

    // Byte-for-byte agreement with a decode that never saw a cache.
    const full = await parse(coldCache)
    expect(resumed.length).toBe(6)
    expect(JSON.stringify(resumed)).toBe(JSON.stringify(full))
  })

  it('stays exact across successive appends, resuming from a resumed state', async () => {
    const warmCache = join(tmpDir, 'cache-warm')

    sessionPath = await writeRollout([meta(), ...tasks(1, 2)])
    await parse(warmCache)
    await appendFile(sessionPath, tasks(3, 4).join('\n') + '\n')
    await parse(warmCache)
    // A tail with no task boundary at all: the next run restarts from the same
    // boundary and re-decodes the open task.
    await appendFile(sessionPath, tasks(5, 5).slice(1).join('\n') + '\n')
    const resumed = await parse(warmCache)

    const full = await parse(join(tmpDir, 'cache-cold'))
    expect(JSON.stringify(resumed)).toBe(JSON.stringify(full))
  })

  it('serves an unchanged file from the cache without reading it', async () => {
    const cacheDir = join(tmpDir, 'cache')
    sessionPath = await writeRollout([meta(), ...tasks(1, 2)])
    const first = await parse(cacheDir)

    readLineCalls.length = 0
    const second = await parse(cacheDir)
    expect(readLineCalls.filter(c => c.filePath === sessionPath)).toHaveLength(0)
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })

  it('falls back to a full re-parse when the stored resume state is unusable', async () => {
    const cacheDir = join(tmpDir, 'cache')
    sessionPath = await writeRollout([meta(), ...tasks(1, 2)])
    await parse(cacheDir)

    const cachePath = join(cacheDir, 'codex-results.json')
    const { readFile } = await import('fs/promises')
    const raw = JSON.parse(await readFile(cachePath, 'utf-8'))
    raw.files[sessionPath].resumeState = { garbage: true }
    await writeFile(cachePath, JSON.stringify(raw))
    const { clearCodexMemCaches } = await import('../../src/codex-cache.js')
    clearCodexMemCaches()

    await appendFile(sessionPath, tasks(3, 3).join('\n') + '\n')
    readLineCalls.length = 0
    const resumed = await parse(cacheDir)
    expect(readLineCalls.filter(c => c.filePath === sessionPath).every(c => (c.startByteOffset ?? 0) === 0)).toBe(true)

    const full = await parse(join(tmpDir, 'cache-cold'))
    expect(JSON.stringify(resumed)).toBe(JSON.stringify(full))
  })
})
