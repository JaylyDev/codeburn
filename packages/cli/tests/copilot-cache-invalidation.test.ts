// End-to-end regression coverage for durable Copilot JetBrains history across
// parse-version and privacy-key changes.
//
// The hard case is one still-existing Nitrite DB whose cache contains both a
// current row and an older row the DB has already pruned. Dropping the cached
// file loses the pruned turn; carrying it naively duplicates the current turn
// when its public HMAC key changes. The correct result is a stable two-call
// union, with both records re-keyable from local-only cache identities.

// FIRST import: pins the host privacy key before any static module reads it.
import './setup/fixed-privacy-key.js'

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { createHash, createHmac } from 'crypto'
import { homedir } from 'os'
import { join } from 'path'

import { clearSessionCache, parseAllSessions } from '../src/parser.js'
import { FIXED_PRIVACY_KEY } from './setup/fixed-privacy-key.js'
import {
  CACHE_VERSION,
  computeEnvFingerprint,
  fingerprintFile,
  sessionCachePath,
  type CachedCall,
} from '../src/session-cache.js'

const TEST_ROOT = `${process.env['TMPDIR'] || '/tmp'}/copilot-cache-inv-${process.pid}-${Date.now()}`
const CACHE_DIR = join(TEST_ROOT, 'cache')
const JB_ROOT = join(TEST_ROOT, 'jetbrains')
const STORE_ID = 'store-rotate'

// Distinct lengths make loss or duplication visible in the public result.
const PRUNED_REPLY = 'p'.repeat(40) // 10 estimated output tokens
const LIVE_REPLY = 'l'.repeat(84) // 21 estimated output tokens

function legacyCacheIdentity(reply: string): string {
  const digest = createHash('sha256').update(reply).digest('hex').slice(0, 12)
  return `copilot:jb:${STORE_ID}:${digest}:1`
}

function keyedFromIdentity(privacyKey: string, identity: string): string {
  const match = /^(copilot:jb:.+):([0-9a-f]{12}):([1-9]\d*)$/.exec(identity)
  if (!match) throw new Error(`invalid test identity: ${identity}`)
  const digest = createHmac('sha256', privacyKey).update(match[2]!).digest('hex').slice(0, 12)
  return `${match[1]}:${digest}:${match[3]}`
}

function currentKey(privacyKey: string, reply: string): string {
  return keyedFromIdentity(privacyKey, legacyCacheIdentity(reply))
}

// #1074's short-lived integration format: HMAC over reply text directly.
function v1HmacKey(privacyKey: string, reply: string): string {
  const digest = createHmac('sha256', privacyKey).update(reply).digest('hex').slice(0, 12)
  return `copilot:jb:${STORE_ID}:${digest}:1`
}

function providerFingerprint(parseVersion: string, privacyKey?: string): string {
  const parts = [`parser=${parseVersion}`]
  if (privacyKey) {
    const keyDigest = createHash('sha256').update(privacyKey).digest('hex').slice(0, 16)
    parts.push(`privacy-key=${keyDigest}`)
  }
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16)
}

const V020_FINGERPRINT = providerFingerprint('cli-shutdown-cost-v1-skills-source-provenance-v1')
const PR1074_V1_FINGERPRINT = providerFingerprint(
  'cli-shutdown-cost-v1-skills-dedup-key-hmac-v1',
  FIXED_PRIVACY_KEY,
)

// Real Nitrite-like bytes used by the production JetBrains extractor.
function jbAssistantBlob(text: string): string {
  const innerMd = { type: 'Markdown', data: JSON.stringify({ text, annotations: [] }) }
  const valueMap: Record<string, unknown> = {
    'a1b2c3d4-0000-0000-0000-000000000001': { type: 'Value', value: JSON.stringify(innerMd) },
  }
  return JSON.stringify({ __first__: { type: 'Subgraph', value: JSON.stringify(valueMap) } })
}

function jbDbContent(replies: string[]): string {
  return (
    'H:2,block:9,blockSize:1000,format:3\n' +
    'com.github.copilot.agent.session.persistence.nitrite.entity.NtAgentTurn\n' +
    replies.map(jbAssistantBlob).join('\nt\x00\x00model\n') +
    '\n'
  )
}

async function writeJetBrainsDb(replies: string[]): Promise<string> {
  const dir = join(JB_ROOT, 'iu', 'chat-agent-sessions', STORE_ID)
  await mkdir(dir, { recursive: true })
  const dbPath = join(dir, 'copilot-agent-sessions-nitrite.db')
  await writeFile(dbPath, jbDbContent(replies))
  return dbPath
}

function cachedCall(outputTokens: number, deduplicationKey: string, cacheIdentityKey?: string): CachedCall {
  const timestamp = new Date().toISOString()
  return {
    provider: 'copilot',
    model: 'gpt-4o',
    usage: {
      inputTokens: 0,
      outputTokens,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      cacheCreationOneHourTokens: 0,
    },
    speed: 'standard',
    timestamp,
    tools: [],
    bashCommands: [],
    skills: [],
    subagentTypes: [],
    deduplicationKey,
    ...(cacheIdentityKey ? { cacheIdentityKey } : {}),
  }
}

async function seedPriorCache(
  version: 5 | 7,
  dbPath: string,
  envFingerprint: string,
  calls: CachedCall[],
): Promise<void> {
  const fp = await fingerprintFile(dbPath)
  if (!fp) throw new Error('failed to fingerprint seeded JetBrains DB')
  const turns = calls.map(call => ({
    timestamp: call.timestamp,
    sessionId: STORE_ID,
    userMessage: '',
    calls: [call],
  }))
  await mkdir(CACHE_DIR, { recursive: true })
  await writeFile(join(CACHE_DIR, `session-cache.v${version}.json`), JSON.stringify({
    version,
    complete: true,
    providers: {
      copilot: {
        envFingerprint,
        durable: true,
        files: { [dbPath]: { fingerprint: fp, mcpInventory: [], turns } },
      },
    },
  }))
}

type DiskCall = {
  deduplicationKey: string
  cacheIdentityKey?: string
  usage: { outputTokens: number }
}

async function cachedCopilotState(): Promise<{
  envFingerprint: string
  filePaths: string[]
  calls: DiskCall[]
}> {
  const raw = JSON.parse(await readFile(sessionCachePath(), 'utf8')) as {
    providers: Record<string, {
      envFingerprint: string
      files: Record<string, { turns: Array<{ calls: DiskCall[] }> }>
    }>
  }
  const section = raw.providers['copilot']
  return {
    envFingerprint: section.envFingerprint,
    filePaths: Object.keys(section.files),
    calls: Object.values(section.files).flatMap(file => file.turns.flatMap(turn => turn.calls)),
  }
}

async function parsedCopilotCalls() {
  const projects = await parseAllSessions(undefined, 'copilot')
  return projects.flatMap(project => project.sessions)
    .flatMap(session => session.turns)
    .flatMap(turn => turn.assistantCalls)
}

async function writeHostPrivacyKey(key: string): Promise<void> {
  const dir = join(homedir(), '.config', 'codeburn')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'privacy-key'), key + '\n', { mode: 0o600 })
}

async function parseInFreshProcess(): Promise<{
  calls: Awaited<ReturnType<typeof parsedCopilotCalls>>
  envFingerprint: string
}> {
  vi.resetModules()
  const parser = await import('../src/parser.js')
  const cache = await import('../src/session-cache.js')
  parser.clearSessionCache()
  const projects = await parser.parseAllSessions(undefined, 'copilot')
  return {
    calls: projects.flatMap(project => project.sessions)
      .flatMap(session => session.turns)
      .flatMap(turn => turn.assistantCalls),
    envFingerprint: cache.computeEnvFingerprint('copilot'),
  }
}

function outputTokens(calls: Awaited<ReturnType<typeof parsedCopilotCalls>>): number[] {
  return calls.map(call => call.usage.outputTokens).sort((a, b) => a - b)
}

beforeEach(async () => {
  clearSessionCache()
  await rm(TEST_ROOT, { recursive: true, force: true })
  process.env['CODEBURN_CACHE_DIR'] = CACHE_DIR
  process.env['CODEBURN_COPILOT_JETBRAINS_DIR'] = JB_ROOT
  process.env['CODEBURN_COPILOT_DISABLE_OTEL'] = '1'
  process.env['CODEBURN_COPILOT_SESSION_STATE_DIR'] = join(TEST_ROOT, 'no-session-state')
  process.env['CODEBURN_COPILOT_WS_STORAGE_DIR'] = join(TEST_ROOT, 'no-workspace-storage')
  process.env['CODEBURN_COPILOT_GLOBAL_STORAGE_DIR'] = join(TEST_ROOT, 'no-global-storage')
  await writeHostPrivacyKey(FIXED_PRIVACY_KEY)
})

afterAll(async () => {
  clearSessionCache()
  await writeHostPrivacyKey(FIXED_PRIVACY_KEY)
  await rm(TEST_ROOT, { recursive: true, force: true })
})

describe('Copilot durable cache key migration', () => {
  it('uses a v8 cache and a new parser fingerprint', () => {
    expect(CACHE_VERSION).toBe(8)
    expect(computeEnvFingerprint('copilot')).not.toBe(V020_FINGERPRINT)
    expect(computeEnvFingerprint('copilot')).not.toBe(PR1074_V1_FINGERPRINT)
  })

  it('adopts v7 and preserves a cached-only turn under a still-existing DB path', async () => {
    const dbPath = await writeJetBrainsDb([LIVE_REPLY])
    // v5 holds an older turn that was already gone when v7 was written. The
    // v8 adoption must union the same path instead of letting v7 overwrite it.
    await seedPriorCache(5, dbPath, V020_FINGERPRINT, [
      cachedCall(10, legacyCacheIdentity(PRUNED_REPLY)),
    ])
    await seedPriorCache(7, dbPath, V020_FINGERPRINT, [
      cachedCall(21, legacyCacheIdentity(LIVE_REPLY)),
    ])

    const calls = await parsedCopilotCalls()
    expect(outputTokens(calls)).toEqual([10, 21])
    expect(calls.reduce((sum, call) => sum + call.usage.outputTokens, 0)).toBe(31)
    expect(calls.flatMap(call => call.localDeduplicationAliases ?? [])).toContain(legacyCacheIdentity(PRUNED_REPLY))
    expect(JSON.stringify(calls)).not.toContain(legacyCacheIdentity(PRUNED_REPLY))

    const state = await cachedCopilotState()
    expect(state.filePaths).toEqual([dbPath])
    expect(state.calls).toHaveLength(2)
    expect(new Set(state.calls.map(call => call.deduplicationKey)).size).toBe(2)
    expect(state.calls.map(call => call.deduplicationKey).sort()).toEqual([
      currentKey(FIXED_PRIVACY_KEY, LIVE_REPLY),
      currentKey(FIXED_PRIVACY_KEY, PRUNED_REPLY),
    ].sort())
    expect(state.calls.map(call => call.cacheIdentityKey).sort()).toEqual([
      legacyCacheIdentity(LIVE_REPLY),
      legacyCacheIdentity(PRUNED_REPLY),
    ].sort())

    clearSessionCache()
    expect(outputTokens(await parsedCopilotCalls())).toEqual([10, 21])
    expect((await cachedCopilotState()).calls.map(call => call.deduplicationKey).sort())
      .toEqual(state.calls.map(call => call.deduplicationKey).sort())
  })

  it('prefers released history for an overlapping #1074 v7 path and reparses live records', async () => {
    const dbPath = await writeJetBrainsDb([LIVE_REPLY])
    // A developer can have an older released cache with both calls and a newer
    // #1074 cache containing the still-live call under HMAC(replyText). Adoption
    // initially has three key-distinct rows; the fresh decoder's two aliases
    // must collapse the overlapping live copies while retaining the pruned one.
    await seedPriorCache(5, dbPath, V020_FINGERPRINT, [
      cachedCall(10, legacyCacheIdentity(PRUNED_REPLY)),
      cachedCall(21, legacyCacheIdentity(LIVE_REPLY)),
    ])
    await seedPriorCache(7, dbPath, PR1074_V1_FINGERPRINT, [
      cachedCall(10, v1HmacKey(FIXED_PRIVACY_KEY, PRUNED_REPLY)),
      cachedCall(21, v1HmacKey(FIXED_PRIVACY_KEY, LIVE_REPLY)),
    ])

    expect(outputTokens(await parsedCopilotCalls())).toEqual([10, 21])
    const state = await cachedCopilotState()
    expect(state.calls).toHaveLength(2)
    expect(state.calls.map(call => call.deduplicationKey).sort()).toEqual([
      currentKey(FIXED_PRIVACY_KEY, PRUNED_REPLY),
      currentKey(FIXED_PRIVACY_KEY, LIVE_REPLY),
    ].sort())
  })

  it('reconciles #1074 HMAC-v1 records present in the DB without duplicating cached-only siblings', async () => {
    const dbPath = await writeJetBrainsDb([LIVE_REPLY])
    await seedPriorCache(7, dbPath, PR1074_V1_FINGERPRINT, [
      cachedCall(21, v1HmacKey(FIXED_PRIVACY_KEY, LIVE_REPLY)),
      cachedCall(10, v1HmacKey(FIXED_PRIVACY_KEY, PRUNED_REPLY)),
    ])

    expect(outputTokens(await parsedCopilotCalls())).toEqual([10, 21])
    const state = await cachedCopilotState()
    expect(state.calls).toHaveLength(2)
    const byTokens = new Map(state.calls.map(call => [call.usage.outputTokens, call]))
    expect(byTokens.get(21)?.deduplicationKey).toBe(currentKey(FIXED_PRIVACY_KEY, LIVE_REPLY))
    expect(byTokens.get(21)?.cacheIdentityKey).toBe(legacyCacheIdentity(LIVE_REPLY))
    // The DB-pruned v1 record cannot recover reply text, but its previous keyed
    // value becomes a stable local identity and remains safely re-keyable.
    const prunedV1Identity = v1HmacKey(FIXED_PRIVACY_KEY, PRUNED_REPLY)
    expect(byTokens.get(10)?.cacheIdentityKey).toBe(prunedV1Identity)
    expect(byTokens.get(10)?.deduplicationKey).toBe(keyedFromIdentity(FIXED_PRIVACY_KEY, prunedV1Identity))
  })
})

describe('Copilot privacy-key rotation with DB-pruned history', () => {
  const KEY_A = '11'.repeat(32)
  const KEY_B = '22'.repeat(32)

  it('re-keys the durable union without loss or double-counting', async () => {
    const dbPath = await writeJetBrainsDb([PRUNED_REPLY, LIVE_REPLY])

    await writeHostPrivacyKey(KEY_A)
    const first = await parseInFreshProcess()
    expect(outputTokens(first.calls)).toEqual([10, 21])
    const stateA = await cachedCopilotState()
    expect(stateA.calls.map(call => call.deduplicationKey).sort()).toEqual([
      currentKey(KEY_A, PRUNED_REPLY),
      currentKey(KEY_A, LIVE_REPLY),
    ].sort())

    // The path remains, but one DB row disappears. This establishes the exact
    // mixed state that #1074's invalidation test omitted.
    await writeJetBrainsDb([LIVE_REPLY])
    const afterPrune = await parseInFreshProcess()
    expect(outputTokens(afterPrune.calls)).toEqual([10, 21])
    expect((await cachedCopilotState()).filePaths).toEqual([dbPath])

    await writeHostPrivacyKey(KEY_B)
    const rotated = await parseInFreshProcess()
    expect(rotated.envFingerprint).not.toBe(first.envFingerprint)
    expect(outputTokens(rotated.calls)).toEqual([10, 21])

    const stateB = await cachedCopilotState()
    const keysB = stateB.calls.map(call => call.deduplicationKey).sort()
    expect(stateB.filePaths).toEqual([dbPath])
    expect(stateB.calls).toHaveLength(2)
    expect(new Set(keysB).size).toBe(2)
    expect(keysB).toEqual([
      currentKey(KEY_B, PRUNED_REPLY),
      currentKey(KEY_B, LIVE_REPLY),
    ].sort())
    expect(keysB).not.toContain(currentKey(KEY_A, PRUNED_REPLY))
    expect(keysB).not.toContain(currentKey(KEY_A, LIVE_REPLY))

    const reloaded = await parseInFreshProcess()
    expect(outputTokens(reloaded.calls)).toEqual([10, 21])
    expect((await cachedCopilotState()).calls.map(call => call.deduplicationKey).sort()).toEqual(keysB)
  })
})
