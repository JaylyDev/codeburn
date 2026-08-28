import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import {
  computeAcceptanceFingerprint,
  buildDisclosure,
  CORE_SYNC_FIELD_MEANINGS,
  type FingerprintInput,
  type DisclosureInput,
} from '../src/sync/consent.js'
import { readSyncConfig, writeSyncConfig, readReceipts, appendReceipt } from '../src/sync/config.js'
import { CORE_SYNC_ATTRIBUTE_KEYS } from '../src/sync/otlp.js'

describe('Fingerprint', () => {
  it('is deterministic - same input produces same hash', () => {
    const input: FingerprintInput = {
      org: 'test-org',
      destination: 'https://endpoint.example.com',
      outboundFields: ['ai.cost_usd', 'ai.model'],
      workMatching: true,
      scopeSinceDays: 7,
      cadence: 'daily',
    }

    const fp1 = computeAcceptanceFingerprint(input)
    const fp2 = computeAcceptanceFingerprint(input)
    expect(fp1).toBe(fp2)
    expect(fp1).toMatch(/^[a-f0-9]{64}$/)
  })

  it('differs when org changes', () => {
    const base: FingerprintInput = {
      org: 'org1',
      destination: 'https://endpoint.example.com',
      outboundFields: ['ai.cost_usd'],
      workMatching: true,
      scopeSinceDays: null,
      cadence: 'daily',
    }

    const changed = { ...base, org: 'org2' }
    const fp1 = computeAcceptanceFingerprint(base)
    const fp2 = computeAcceptanceFingerprint(changed)
    expect(fp1).not.toBe(fp2)
  })

  it('differs when destination changes', () => {
    const base: FingerprintInput = {
      org: 'test-org',
      destination: 'https://endpoint1.example.com',
      outboundFields: ['ai.cost_usd'],
      workMatching: true,
      scopeSinceDays: null,
      cadence: 'daily',
    }

    const changed = { ...base, destination: 'https://endpoint2.example.com' }
    const fp1 = computeAcceptanceFingerprint(base)
    const fp2 = computeAcceptanceFingerprint(changed)
    expect(fp1).not.toBe(fp2)
  })

  it('differs when fields change', () => {
    const base: FingerprintInput = {
      org: 'test-org',
      destination: 'https://endpoint.example.com',
      outboundFields: ['ai.cost_usd', 'ai.model'],
      workMatching: true,
      scopeSinceDays: null,
      cadence: 'daily',
    }

    const changed = { ...base, outboundFields: ['ai.cost_usd', 'ai.model', 'git.repo'] }
    const fp1 = computeAcceptanceFingerprint(base)
    const fp2 = computeAcceptanceFingerprint(changed)
    expect(fp1).not.toBe(fp2)
  })

  it('differs when workMatching changes', () => {
    const base: FingerprintInput = {
      org: 'test-org',
      destination: 'https://endpoint.example.com',
      outboundFields: ['ai.cost_usd'],
      workMatching: true,
      scopeSinceDays: null,
      cadence: 'daily',
    }

    const changed = { ...base, workMatching: false }
    const fp1 = computeAcceptanceFingerprint(base)
    const fp2 = computeAcceptanceFingerprint(changed)
    expect(fp1).not.toBe(fp2)
  })

  it('differs when scopeSinceDays changes', () => {
    const base: FingerprintInput = {
      org: 'test-org',
      destination: 'https://endpoint.example.com',
      outboundFields: ['ai.cost_usd'],
      workMatching: true,
      scopeSinceDays: null,
      cadence: 'daily',
    }

    const changed = { ...base, scopeSinceDays: 7 }
    const fp1 = computeAcceptanceFingerprint(base)
    const fp2 = computeAcceptanceFingerprint(changed)
    expect(fp1).not.toBe(fp2)
  })

  it('differs when cadence changes', () => {
    const base: FingerprintInput = {
      org: 'test-org',
      destination: 'https://endpoint.example.com',
      outboundFields: ['ai.cost_usd'],
      workMatching: true,
      scopeSinceDays: null,
      cadence: 'daily',
    }

    const changed = { ...base, cadence: 'hourly' }
    const fp1 = computeAcceptanceFingerprint(base)
    const fp2 = computeAcceptanceFingerprint(changed)
    expect(fp1).not.toBe(fp2)
  })
})

describe('Disclosure', () => {
  it('builds readable disclosure text', () => {
    const input: DisclosureInput = {
      destination: 'test-org',
      destinationUrl: 'https://endpoint.example.com',
      cadence: 'daily',
      outboundFields: [
        { key: 'ai.cost_usd', disclosure: 'Dollar cost of API calls' },
        { key: 'ai.model', disclosure: 'AI model name' },
      ],
      workMatching: true,
      scopeSinceDays: null,
    }

    const disclosure = buildDisclosure(input)
    expect(disclosure).toContain('test-org')
    expect(disclosure).toContain('https://endpoint.example.com')
    expect(disclosure).toContain('once per day')
    expect(disclosure).toContain('ai.cost_usd')
    expect(disclosure).toContain('ai.model')
    expect(disclosure).toContain('raw prompts')
    expect(disclosure).toContain('file paths')
    expect(disclosure).toContain('codeburn sync auto disable')
  })

  it('states hourly cadence correctly', () => {
    const input: DisclosureInput = {
      destination: 'test-org',
      destinationUrl: 'https://endpoint.example.com',
      cadence: 'hourly',
      outboundFields: [],
      workMatching: true,
      scopeSinceDays: null,
    }

    const disclosure = buildDisclosure(input)
    expect(disclosure).toContain('once per hour')
  })

  it('states scope correctly for null (full history)', () => {
    const input: DisclosureInput = {
      destination: 'test-org',
      destinationUrl: 'https://endpoint.example.com',
      cadence: 'daily',
      outboundFields: [],
      workMatching: true,
      scopeSinceDays: null,
    }

    const disclosure = buildDisclosure(input)
    expect(disclosure).toContain('full history')
  })

  it('states scope correctly for 0 (today only)', () => {
    const input: DisclosureInput = {
      destination: 'test-org',
      destinationUrl: 'https://endpoint.example.com',
      cadence: 'daily',
      outboundFields: [],
      workMatching: true,
      scopeSinceDays: 0,
    }

    const disclosure = buildDisclosure(input)
    expect(disclosure).toContain('today only')
  })

  it('states scope correctly for days', () => {
    const input: DisclosureInput = {
      destination: 'test-org',
      destinationUrl: 'https://endpoint.example.com',
      cadence: 'daily',
      outboundFields: [],
      workMatching: true,
      scopeSinceDays: 7,
    }

    const disclosure = buildDisclosure(input)
    expect(disclosure).toContain('last 7 days')
  })

  it('core field meanings map contains all core attribute keys', () => {
    const meaningsKeys = new Set(CORE_SYNC_FIELD_MEANINGS.keys())
    for (const key of CORE_SYNC_ATTRIBUTE_KEYS) {
      expect(meaningsKeys.has(key)).toBe(true)
    }
  })

  it('disclosure contains no empty field meanings', () => {
    const input: DisclosureInput = {
      destination: 'test-org',
      destinationUrl: 'https://endpoint.example.com',
      cadence: 'daily',
      outboundFields: [
        { key: 'ai.cost_usd', disclosure: 'the cost of the call in US dollars' },
        { key: 'ai.model', disclosure: 'which AI model handled the call' },
        { key: 'custom.field', disclosure: 'custom plugin field' },
      ],
      workMatching: false,
      scopeSinceDays: 7,
    }

    const disclosure = buildDisclosure(input)
    // Check that no field line (starting with spaces) ends with ":" and nothing after
    const lines = disclosure.split('\n')
    for (const line of lines) {
      if (line.startsWith('  ') && line.includes(':')) {
        // Field line: should have content after the colon
        expect(line).not.toMatch(/:\s*$/)
      }
    }
  })
})

describe('Config with auto block', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'codeburn-test-'))
    process.env.HOME = tmpDir
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('round-trips auto block through config with attribution', async () => {
    const configDir = join(tmpDir, '.config', 'codeburn')
    await mkdir(configDir, { recursive: true })

    const config = {
      baseUrl: 'https://endpoint.example.com',
      clientId: 'test-client',
      tracesPath: '/v1/traces',
      issuer: 'https://issuer.example.com',
      auto: {
        accepted: {
          fingerprint: 'abc123',
          acceptedAt: new Date().toISOString(),
          cadence: 'daily' as const,
          disclosure: 'Test disclosure',
          attribution: true,
        },
        killed: false,
      },
    }

    writeSyncConfig(config)
    const loaded = readSyncConfig()

    expect(loaded?.auto?.accepted?.fingerprint).toBe('abc123')
    expect(loaded?.auto?.accepted?.cadence).toBe('daily')
    expect(loaded?.auto?.accepted?.attribution).toBe(true)
    expect(loaded?.auto?.killed).toBe(false)
  })

  it('status recompute matches original fingerprint when attribution choice stored', () => {
    // Simulate what enable does: compute fingerprint with 7-day scope and stored attribution choice
    const fields = ['ai.cost_usd', 'ai.model', 'git.repo']
    const attribution = false // User did NOT request --attribution
    const cadence = 'daily' as const

    const enableInput: FingerprintInput = {
      org: 'test-client',
      destination: 'https://endpoint.example.com',
      outboundFields: fields,
      workMatching: attribution,
      scopeSinceDays: 7,
      cadence,
    }
    const storedFingerprint = computeAcceptanceFingerprint(enableInput)

    // Now simulate what status does: recompute with same config
    const statusInput: FingerprintInput = {
      org: 'test-client',
      destination: 'https://endpoint.example.com',
      outboundFields: fields,
      workMatching: attribution, // Same as what was stored
      scopeSinceDays: 7, // Same as what was stored
      cadence,
    }
    const recomputedFingerprint = computeAcceptanceFingerprint(statusInput)

    expect(recomputedFingerprint).toBe(storedFingerprint)
  })

  it('handles missing auto block', () => {
    const configDir = join(tmpDir, '.config', 'codeburn')
    mkdir(configDir, { recursive: true })

    const config = {
      baseUrl: 'https://endpoint.example.com',
      clientId: 'test-client',
      tracesPath: '/v1/traces',
      issuer: 'https://issuer.example.com',
    }

    writeSyncConfig(config)
    const loaded = readSyncConfig()

    expect(loaded?.auto).toBeUndefined()
  })
})

describe('Receipts', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'codeburn-test-'))
    process.env.HOME = tmpDir
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('appends receipts to JSONL file', () => {
    const configDir = join(tmpDir, '.config', 'codeburn')
    mkdir(configDir, { recursive: true })

    const receipt1 = { at: '2024-01-01T00:00:00Z', result: 'pushed', spans: 10 }
    const receipt2 = { at: '2024-01-02T00:00:00Z', result: 'killed' }

    appendReceipt(receipt1)
    appendReceipt(receipt2)

    const receipts = readReceipts()
    expect(receipts).toHaveLength(2)
    expect(receipts[0]?.result).toBe('pushed')
    expect(receipts[1]?.result).toBe('killed')
  })

  it('reads last N receipts', () => {
    const configDir = join(tmpDir, '.config', 'codeburn')
    mkdir(configDir, { recursive: true })

    for (let i = 0; i < 10; i++) {
      appendReceipt({ at: `2024-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`, result: 'pushed' })
    }

    const last5 = readReceipts(5)
    expect(last5).toHaveLength(5)
    expect(last5[0]?.at).toContain('01-06')
    expect(last5[4]?.at).toContain('01-10')
  })

  it('returns empty array when receipts file does not exist', () => {
    const receipts = readReceipts()
    expect(receipts).toEqual([])
  })

  it('creates directory if missing when appending receipt', () => {
    // Don't pre-create configDir - test that appendReceipt creates it
    process.env.HOME = tmpDir

    const receipt = { at: '2024-01-01T00:00:00Z', result: 'pushed', spans: 5 }
    appendReceipt(receipt)

    const receipts = readReceipts()
    expect(receipts).toHaveLength(1)
    expect(receipts[0]?.result).toBe('pushed')
  })
})
