// These goldens were captured from the pre-migration in-CLI decode and serve as
// the byte-parity gate for the vscode-cline shared bridge migration. Do not
// change the expected arrays except to add new coverage mandated by the brief.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { cline } from '../../src/providers/cline.js'
import { ibmBob } from '../../src/providers/ibm-bob.js'
import { rooCode } from '../../src/providers/roo-code.js'
import { kiloCode } from '../../src/providers/kilo-code.js'
import type { ParsedProviderCall, SessionSource } from '../../src/providers/types.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'vscode-cline-shared-bridge-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

async function writeTask(
  baseDir: string,
  taskId: string,
  opts: {
    uiMessages?: unknown[]
    uiRaw?: string
    history?: unknown[]
    historyRaw?: string
    skipUi?: boolean
    skipHistory?: boolean
  },
): Promise<string> {
  const taskDir = join(baseDir, 'tasks', taskId)
  await mkdir(taskDir, { recursive: true })

  if (!opts.skipUi) {
    const uiRaw = opts.uiRaw ?? JSON.stringify(opts.uiMessages ?? [])
    await writeFile(join(taskDir, 'ui_messages.json'), uiRaw)
  }

  if (!opts.skipHistory) {
    const historyRaw = opts.historyRaw ?? JSON.stringify(opts.history ?? [])
    await writeFile(join(taskDir, 'api_conversation_history.json'), historyRaw)
  }

  return taskDir
}

async function makeSources(providerName: string): Promise<SessionSource[]> {
  const baseDir = join(tmpDir, providerName)

  // G1 (model slash-strip), G3 (workspace), G8 (measured cost),
  // G9 (estimated cost), G11 (userMessage on index 0 only),
  // and index-is-apiReqEntries-index (interleaved non-api message).
  await writeTask(baseDir, 'task-main', {
    uiMessages: [
      { type: 'say', say: 'user_feedback', text: 'hello world', ts: 1_700_000_000_000 },
      {
        type: 'say',
        say: 'api_req_started',
        text: JSON.stringify({ tokensIn: 200, tokensOut: 100, cacheReads: 50, cacheWrites: 30, cost: 0.05 }),
        ts: 1_700_000_001_000,
      },
      { type: 'say', say: 'text', text: 'interleaved note', ts: 1_700_000_001_500 },
      {
        type: 'say',
        say: 'api_req_started',
        text: JSON.stringify({ tokensIn: 10, tokensOut: 5 }),
        ts: 1_700_000_002_000,
      },
    ],
    history: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'hello\n<environment_details>\n<model>anthropic/claude-sonnet-4-6</model>\nCurrent Workspace Directory (/home/user/projects/acme-corp)\n</environment_details>',
          },
        ],
      },
    ],
  })

  // G1 (model without workspace marker) + G4 (project absent).
  await writeTask(baseDir, 'task-model-only', {
    uiMessages: [
      { type: 'say', say: 'text', text: 'model only fixture', ts: 1_700_000_000_000 },
      {
        type: 'say',
        say: 'api_req_started',
        text: JSON.stringify({ tokensIn: 20, tokensOut: 10 }),
        ts: 1_700_000_003_000,
      },
    ],
    history: [
      {
        role: 'user',
        content: [{ type: 'text', text: '<environment_details>\n<model>anthropic/claude-opus-5</model>\n</environment_details>' }],
      },
    ],
  })

  // G2 + G5: history file missing entirely -> fallback model, no workspace.
  await writeTask(baseDir, 'task-nohistory', {
    uiMessages: [
      {
        type: 'say',
        say: 'api_req_started',
        text: JSON.stringify({ tokensIn: 15, tokensOut: 7 }),
        ts: 1_700_000_004_000,
      },
    ],
    skipHistory: true,
  })

  // G2 + G6: history file malformed JSON -> fallback model, no workspace.
  await writeTask(baseDir, 'task-badhistory-json', {
    uiMessages: [
      {
        type: 'say',
        say: 'api_req_started',
        text: JSON.stringify({ tokensIn: 16, tokensOut: 8 }),
        ts: 1_700_000_005_000,
      },
    ],
    historyRaw: 'not valid json',
  })

  // G2 + G7: history parses to non-array -> fallback model, no workspace.
  await writeTask(baseDir, 'task-badhistory-shape', {
    uiMessages: [
      {
        type: 'say',
        say: 'api_req_started',
        text: JSON.stringify({ tokensIn: 17, tokensOut: 9 }),
        ts: 1_700_000_006_000,
      },
    ],
    historyRaw: JSON.stringify({ not: 'an array' }),
  })

  // G16: ts absent -> timestamp ''.
  await writeTask(baseDir, 'task-nots', {
    uiMessages: [
      {
        type: 'say',
        say: 'api_req_started',
        text: JSON.stringify({ tokensIn: 18, tokensOut: 10 }),
      },
    ],
  })

  // G10: zero-token entry skipped even with cache buckets.
  // G17: the zero-token index 0 burns its dedup key.
  await writeTask(baseDir, 'task-zerotoken', {
    uiMessages: [
      {
        type: 'say',
        say: 'api_req_started',
        text: JSON.stringify({ tokensIn: 0, tokensOut: 0, cacheReads: 7, cacheWrites: 3 }),
        ts: 1_700_000_007_000,
      },
      { type: 'say', say: 'text', text: 'interleaved in zero-token fixture', ts: 1_700_000_007_500 },
      {
        type: 'say',
        say: 'api_req_started',
        text: JSON.stringify({ tokensIn: 5, tokensOut: 2 }),
        ts: 1_700_000_008_000,
      },
    ],
  })

  // G15: entry text is malformed JSON -> tokens stay 0 -> skipped.
  await writeTask(baseDir, 'task-malformedtext', {
    uiMessages: [{ type: 'say', say: 'api_req_started', text: 'not valid json', ts: 1_700_000_009_000 }],
  })

  // G12: ui_messages.json missing -> yields nothing.
  await writeTask(baseDir, 'task-noui', {
    skipUi: true,
    history: [],
  })

  // G13: ui_messages.json malformed JSON -> yields nothing.
  await writeTask(baseDir, 'task-badui-json', {
    uiRaw: 'not valid json',
    history: [],
  })

  // G14: ui_messages.json parses to non-array -> yields nothing.
  await writeTask(baseDir, 'task-badui-shape', {
    uiRaw: JSON.stringify({ not: 'an array' }),
    history: [],
  })

  const ids = [
    'task-main',
    'task-model-only',
    'task-nohistory',
    'task-badhistory-json',
    'task-badhistory-shape',
    'task-nots',
    'task-zerotoken',
    'task-malformedtext',
    'task-noui',
    'task-badui-json',
    'task-badui-shape',
  ]

  return ids.map(id => ({
    path: join(baseDir, 'tasks', id),
    project: providerName,
    provider: providerName,
  }))
}

async function collect(providerName: string, source: SessionSource, seenKeys: Set<string>): Promise<ParsedProviderCall[]> {
  const calls: ParsedProviderCall[] = []
  let parser: ReturnType<typeof cline.createSessionParser>
  switch (providerName) {
    case 'cline':
      parser = cline.createSessionParser(source, seenKeys)
      break
    case 'ibm-bob':
      parser = ibmBob.createSessionParser(source, seenKeys)
      break
    case 'roo-code':
      parser = rooCode.createSessionParser(source, seenKeys)
      break
    case 'kilo-code':
      parser = kiloCode.createSessionParser(source, seenKeys)
      break
    default:
      throw new Error(`unknown provider ${providerName}`)
  }
  for await (const call of parser.parse()) calls.push(call)
  return calls
}

async function collectAll(providerName: string, sources: SessionSource[]): Promise<ParsedProviderCall[]> {
  const seenKeys = new Set<string>()
  const all: ParsedProviderCall[] = []
  for (const source of sources) {
    const calls = await collect(providerName, source, seenKeys)
    all.push(...calls)
  }
  return all
}

function goldenFor(providerName: string, fallbackModel: string): ParsedProviderCall[] {
  return [
    {
      provider: providerName,
      model: 'claude-sonnet-4-6',
      inputTokens: 200,
      outputTokens: 100,
      cacheCreationInputTokens: 30,
      cacheReadInputTokens: 50,
      cachedInputTokens: 50,
      reasoningTokens: 0,
      webSearchRequests: 0,
      costUSD: 0.05,
      costBasis: 'measured',
      tools: [],
      bashCommands: [],
      timestamp: '2023-11-14T22:13:21.000Z',
      speed: 'standard',
      deduplicationKey: `${providerName}:task-main:0`,
      userMessage: 'hello world',
      sessionId: 'task-main',
      project: 'acme-corp',
      projectPath: '/home/user/projects/acme-corp',
    },
    {
      provider: providerName,
      model: 'claude-sonnet-4-6',
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      costBasis: 'estimated',
      tools: [],
      bashCommands: [],
      timestamp: '2023-11-14T22:13:22.000Z',
      speed: 'standard',
      deduplicationKey: `${providerName}:task-main:1`,
      userMessage: '',
      sessionId: 'task-main',
      project: 'acme-corp',
      projectPath: '/home/user/projects/acme-corp',
    },
    {
      provider: providerName,
      model: 'claude-opus-5',
      inputTokens: 20,
      outputTokens: 10,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      costBasis: 'estimated',
      tools: [],
      bashCommands: [],
      timestamp: '2023-11-14T22:13:23.000Z',
      speed: 'standard',
      deduplicationKey: `${providerName}:task-model-only:0`,
      userMessage: 'model only fixture',
      sessionId: 'task-model-only',
      project: undefined,
      projectPath: undefined,
    },
    {
      provider: providerName,
      model: fallbackModel,
      inputTokens: 15,
      outputTokens: 7,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      costBasis: 'estimated',
      tools: [],
      bashCommands: [],
      timestamp: '2023-11-14T22:13:24.000Z',
      speed: 'standard',
      deduplicationKey: `${providerName}:task-nohistory:0`,
      userMessage: '',
      sessionId: 'task-nohistory',
      project: undefined,
      projectPath: undefined,
    },
    {
      provider: providerName,
      model: fallbackModel,
      inputTokens: 16,
      outputTokens: 8,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      costBasis: 'estimated',
      tools: [],
      bashCommands: [],
      timestamp: '2023-11-14T22:13:25.000Z',
      speed: 'standard',
      deduplicationKey: `${providerName}:task-badhistory-json:0`,
      userMessage: '',
      sessionId: 'task-badhistory-json',
      project: undefined,
      projectPath: undefined,
    },
    {
      provider: providerName,
      model: fallbackModel,
      inputTokens: 17,
      outputTokens: 9,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      costBasis: 'estimated',
      tools: [],
      bashCommands: [],
      timestamp: '2023-11-14T22:13:26.000Z',
      speed: 'standard',
      deduplicationKey: `${providerName}:task-badhistory-shape:0`,
      userMessage: '',
      sessionId: 'task-badhistory-shape',
      project: undefined,
      projectPath: undefined,
    },
    {
      provider: providerName,
      model: fallbackModel,
      inputTokens: 18,
      outputTokens: 10,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      costBasis: 'estimated',
      tools: [],
      bashCommands: [],
      timestamp: '',
      speed: 'standard',
      deduplicationKey: `${providerName}:task-nots:0`,
      userMessage: '',
      sessionId: 'task-nots',
      project: undefined,
      projectPath: undefined,
    },
    {
      provider: providerName,
      model: fallbackModel,
      inputTokens: 5,
      outputTokens: 2,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      costBasis: 'estimated',
      tools: [],
      bashCommands: [],
      timestamp: '2023-11-14T22:13:28.000Z',
      speed: 'standard',
      deduplicationKey: `${providerName}:task-zerotoken:1`,
      userMessage: '',
      sessionId: 'task-zerotoken',
      project: undefined,
      projectPath: undefined,
    },
  ] satisfies ParsedProviderCall[]
}

const GOLDEN_CLINE = goldenFor('cline', 'cline-auto')
const GOLDEN_IBM_BOB = goldenFor('ibm-bob', 'ibm-bob-auto')
const GOLDEN_ROO_CODE = goldenFor('roo-code', 'cline-auto')
const GOLDEN_KILO_CODE = goldenFor('kilo-code', 'cline-auto')

// `toEqual` treats an absent key and a present-but-`undefined` key as equal, so
// the goldens above cannot see a key-shape regression. These are the arms where
// presence is load-bearing: `costUSD` is conditionally spread (absent when
// estimated) while `project` / `projectPath` are written unconditionally
// (present-with-`undefined` when there is no workspace marker).
function expectGoldenKeyShape(calls: ParsedProviderCall[]): void {
  const measured = calls.find(c => c.costBasis === 'measured')!
  const estimated = calls.find(c => c.costBasis === 'estimated')!
  expect(Object.keys(measured)).toContain('costUSD')
  expect(Object.keys(estimated)).not.toContain('costUSD')
  for (const call of calls) {
    expect(Object.keys(call)).toContain('project')
    expect(Object.keys(call)).toContain('projectPath')
  }
}

describe('vscode-cline shared bridge - goldens (unmodified code)', () => {
  it('pins cline output byte-for-byte', async () => {
    const sources = await makeSources('cline')
    const calls = await collectAll('cline', sources)
    expect(calls).toEqual(GOLDEN_CLINE)
    expectGoldenKeyShape(calls)
  })

  it('pins ibm-bob output byte-for-byte', async () => {
    const sources = await makeSources('ibm-bob')
    const calls = await collectAll('ibm-bob', sources)
    expect(calls).toEqual(GOLDEN_IBM_BOB)
    expectGoldenKeyShape(calls)
  })

  it('pins roo-code output byte-for-byte', async () => {
    const sources = await makeSources('roo-code')
    const calls = await collectAll('roo-code', sources)
    expect(calls).toEqual(GOLDEN_ROO_CODE)
    expectGoldenKeyShape(calls)
  })

  it('pins kilo-code output byte-for-byte', async () => {
    const sources = await makeSources('kilo-code')
    const calls = await collectAll('kilo-code', sources)
    expect(calls).toEqual(GOLDEN_KILO_CODE)
    expectGoldenKeyShape(calls)
  })
})

describe('vscode-cline shared bridge - kilo-code dispatch', () => {
  it('still routes .db: sources to the SQLite arm instead of createClineParser', async () => {
    const baseDir = join(tmpDir, 'kilo-code-sqlite-dispatch')
    const taskDir = await writeTask(baseDir, 'task-sqlite', {
      uiMessages: [
        {
          type: 'say',
          say: 'api_req_started',
          text: JSON.stringify({ tokensIn: 99, tokensOut: 99 }),
          ts: 1_700_000_000_000,
        },
      ],
    })

    const dbSource: SessionSource = { path: `${taskDir}.db:session-id`, project: 'kilo-code', provider: 'kilo-code' }
    const seenKeys = new Set<string>()
    const parser = kiloCode.createSessionParser(dbSource, seenKeys)
    const calls: ParsedProviderCall[] = []

    // Positive proof the SQLite arm ran: its pre-existing open-failure path (in
    // the untouched sqlite-session-parser.ts) writes this line for a database
    // that does not exist. Capturing it also keeps the line out of test output.
    const written: string[] = []
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
      written.push(String(chunk))
      return true
    })
    try {
      for await (const call of parser.parse()) calls.push(call)
    } catch {
      // The SQLite arm is allowed to fail for a non-existent database; the point
      // is that it must not have produced the cline-arm golden for this source.
    } finally {
      writeSpy.mockRestore()
    }

    expect(written.join('')).toContain('cannot open KiloCode database')
    // If the source had gone through createClineParser, it would have yielded a
    // call with sessionId 'task-sqlite' and these token counts.
    expect(calls).toEqual([])
    expect(seenKeys.has('kilo-code:task-sqlite:0')).toBe(false)
  })
})

describe('vscode-cline shared bridge - dedup arms', () => {
  it('burns dedup key for zero-token entries and deduplicates across runs', async () => {
    for (const providerName of ['cline', 'ibm-bob', 'roo-code', 'kilo-code'] as const) {
      const baseDir = join(tmpDir, providerName, 'dedup')
      const taskDir = await writeTask(baseDir, 'task-dedup', {
        uiMessages: [
          {
            type: 'say',
            say: 'api_req_started',
            text: JSON.stringify({ tokensIn: 0, tokensOut: 0, cacheReads: 7, cacheWrites: 3 }),
            ts: 1_700_000_010_000,
          },
          {
            type: 'say',
            say: 'api_req_started',
            text: JSON.stringify({ tokensIn: 25, tokensOut: 12 }),
            ts: 1_700_000_011_000,
          },
        ],
      })

      const source: SessionSource = { path: taskDir, project: providerName, provider: providerName }
      const seenKeys = new Set<string>()

      const first = await collect(providerName, source, seenKeys)
      expect(first).toHaveLength(1)
      expect(first[0]!.deduplicationKey).toBe(`${providerName}:task-dedup:1`)
      expect(seenKeys.has(`${providerName}:task-dedup:0`)).toBe(true)
      expect(seenKeys.has(`${providerName}:task-dedup:1`)).toBe(true)

      const second = await collect(providerName, source, seenKeys)
      expect(second).toHaveLength(0)
    }
  })
})
