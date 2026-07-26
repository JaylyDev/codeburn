// Phase-4 signature test at the CLI layer: the codex-results cache persists the
// decoder's serializable end-state + byte offset, so a rollout that GREW (Codex
// only appends) resumes from that state and decodes ONLY the appended bytes. The
// resumed output must equal a cold decode of the full grown file.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { createCodexProvider } from '../src/providers/codex.js'
import { readCodexCacheEntry } from '../src/codex-cache.js'
import type { ParsedProviderCall } from '../src/providers/types.js'

let tmpDir: string
let cacheDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'codex-resume-'))
  cacheDir = await mkdtemp(join(tmpdir(), 'codex-resume-cache-'))
  process.env['CODEBURN_CACHE_DIR'] = cacheDir
})

afterEach(async () => {
  delete process.env['CODEBURN_CACHE_DIR']
  await rm(tmpDir, { recursive: true, force: true })
  await rm(cacheDir, { recursive: true, force: true })
})

function sessionMeta() {
  return JSON.stringify({ type: 'session_meta', timestamp: '2026-04-14T10:00:00Z', payload: { cwd: '/Users/t/p', originator: 'codex-cli', session_id: 'sess-resume', model: 'gpt-5.3-codex' } })
}
function userMessage(text: string, ts: string) {
  return JSON.stringify({ type: 'response_item', timestamp: ts, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })
}
function tokenCount(ts: string, lastInput: number, cumulative: number) {
  return JSON.stringify({ type: 'event_msg', timestamp: ts, payload: { type: 'token_count', info: { last_token_usage: { input_tokens: lastInput, output_tokens: 0, total_tokens: lastInput }, total_token_usage: { input_tokens: cumulative, total_tokens: cumulative } } } })
}

const PREFIX = [
  sessionMeta(),
  userMessage('first turn', '2026-04-14T10:00:01Z'),
  tokenCount('2026-04-14T10:00:02Z', 700, 700),
  userMessage('second turn', '2026-04-14T10:00:03Z'),
  tokenCount('2026-04-14T10:00:04Z', 400, 1100),
]
const APPENDED = [
  userMessage('third turn', '2026-04-14T10:00:05Z'),
  tokenCount('2026-04-14T10:00:06Z', 300, 1400),
]

async function writeAt(dir: string, filename: string, lines: string[]): Promise<string> {
  const sessionDir = join(dir, 'sessions', '2026', '04', '14')
  await mkdir(sessionDir, { recursive: true })
  const filePath = join(sessionDir, filename)
  await writeFile(filePath, lines.join('\n') + '\n')
  return filePath
}

async function parseFile(filePath: string): Promise<ParsedProviderCall[]> {
  const provider = createCodexProvider(tmpDir)
  const source = { path: filePath, project: 'Users-t-p', provider: 'codex' }
  const calls: ParsedProviderCall[] = []
  for await (const c of provider.createSessionParser(source, new Set<string>()).parse()) calls.push(c)
  return calls
}

describe('codex append-resume through the CLI cache', () => {
  it('resumes from the persisted state + byte offset and matches a cold decode of the grown file', async () => {
    const filePath = await writeAt(tmpDir, 'rollout-grow.jsonl', PREFIX)

    // Run 1: cold decode of the prefix. Writes the state blob + priced calls +
    // byte offset into the codex-results cache.
    const v1 = await parseFile(filePath)
    expect(v1).toHaveLength(2)

    const entry = await readCodexCacheEntry(filePath)
    expect(entry).not.toBeNull()
    expect(entry!.byteOffset).toBeGreaterThan(0)
    expect(entry!.calls).toHaveLength(2)
    // The persisted state is plain JSON and carries the running cumulative
    // counter (1100 after the prefix) so the appended delta computes correctly.
    expect(entry!.state.prevInput).toBe(1100)
    expect(Array.isArray(entry!.state.seenKeys)).toBe(true)

    // The file grows: Codex appends a third turn.
    await appendFile(filePath, APPENDED.join('\n') + '\n')

    // Run 2: same process, cache entry still in memory with the pre-append
    // fingerprint -> the grown file takes the append-resume branch.
    const v2 = await parseFile(filePath)
    expect(v2).toHaveLength(3)

    // Cold decode of the full grown file via a fresh, never-cached path.
    const coldPath = await writeAt(tmpDir, 'rollout-cold.jsonl', [...PREFIX, ...APPENDED])
    const cold = await parseFile(coldPath)
    expect(cold).toHaveLength(3)

    // The resumed output must equal the cold decode (session_id is path-
    // independent, so dedup keys and every field line up).
    expect(v2).toEqual(cold)
  })

  it('reuses the cached prior calls on resume rather than re-decoding the prefix', async () => {
    const filePath = await writeAt(tmpDir, 'rollout-proof.jsonl', PREFIX)
    await parseFile(filePath)

    // Plant a sentinel on the cached prior calls. If run 2 re-decoded the prefix
    // cold, the sentinel would be gone; if it resumed (reusing cached priorCalls),
    // the sentinel survives onto the emitted prior calls.
    const entry = await readCodexCacheEntry(filePath)
    entry!.calls[0]!.model = 'SENTINEL-MODEL'

    await appendFile(filePath, APPENDED.join('\n') + '\n')
    const v2 = await parseFile(filePath)

    expect(v2.map(c => c.model)).toContain('SENTINEL-MODEL')
  })
})
