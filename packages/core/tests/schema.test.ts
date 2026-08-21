import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import Ajv from 'ajv'
import { describe, expect, it } from 'vitest'

import { Finding } from '../src/contracts.js'
import { ObservationEnvelope } from '../src/observations.js'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')

function readJson(rel: string): unknown {
  return JSON.parse(readFileSync(resolve(pkgRoot, rel), 'utf8'))
}

const goldenEnvelope = readJson('tests/fixtures/golden-envelope.json')
const goldenFinding = readJson('tests/fixtures/golden-finding.json')
const observationSchema = readJson('schemas/observation-0.3.0.json') as object
const legacyObservationSchema = readJson('schemas/observation-0.2.0.json') as object
const findingSchema = readJson('schemas/finding-0.1.0.json') as object

// strict:false so unknown string formats (date-time) are ignored rather than
// erroring — we validate structure/shape, not RFC date grammar (zod already
// enforces the timestamp format on the runtime side).
const ajv = new Ajv({ strict: false, allErrors: true })
// date-time is a semantic annotation here; zod enforces the timestamp format at
// runtime, so we register it as always-valid to keep ajv from warning.
ajv.addFormat('date-time', true)
const validateEnvelope = ajv.compile(observationSchema)
const validateLegacyEnvelope = ajv.compile(legacyObservationSchema)
const validateFinding = ajv.compile(findingSchema)

/**
 * THREE-WAY AGREEMENT.
 *
 * For each golden fixture we assert all three views of the contract accept it:
 *   1. TypeScript types  — this file imports the inferred types and compiles.
 *   2. zod validator     — the runtime source-of-truth.
 *   3. JSON Schema       — the checked-in artifact, validated with ajv.
 *
 * We use ajv (a real JSON Schema validator, already in the tree) rather than a
 * structural comparison because only real validation proves the emitted schema
 * actually ACCEPTS conforming data — a structural diff would only prove the two
 * shapes look alike, not that the schema is usable by an external consumer.
 */
describe('three-way agreement: golden envelope', () => {
  it('zod accepts it', () => {
    const parsed = ObservationEnvelope.safeParse(goldenEnvelope)
    expect(parsed.success, JSON.stringify((parsed as { error?: unknown }).error)).toBe(true)
  })

  it('JSON Schema (ajv) accepts it', () => {
    const ok = validateEnvelope(goldenEnvelope)
    expect(ok, JSON.stringify(validateEnvelope.errors)).toBe(true)
  })
})

describe('three-way agreement: golden finding', () => {
  it('zod accepts it', () => {
    const parsed = Finding.safeParse(goldenFinding)
    expect(parsed.success, JSON.stringify((parsed as { error?: unknown }).error)).toBe(true)
  })

  it('JSON Schema (ajv) accepts it', () => {
    const ok = validateFinding(goldenFinding)
    expect(ok, JSON.stringify(validateFinding.errors)).toBe(true)
  })
})

describe('strictness / structural minimization', () => {
  it('keeps the published 0.2.0 model contract valid for archived envelopes', () => {
    const archived = structuredClone(goldenEnvelope) as {
      schemaVersion: string
      sessions: { calls: Array<Record<string, unknown>> }[]
    }
    archived.schemaVersion = '0.2.0'
    archived.sessions[0].calls[0].model = 'Gemini 3.5 Flash (High)'
    expect(validateLegacyEnvelope(archived), JSON.stringify(validateLegacyEnvelope.errors)).toBe(true)
    expect(validateEnvelope(archived)).toBe(false)
  })

  it('zod rejects an unknown top-level field', () => {
    expect(ObservationEnvelope.safeParse({ ...(goldenEnvelope as object), title: 'x' }).success).toBe(false)
  })

  it('JSON Schema also rejects an unknown top-level field (additionalProperties:false)', () => {
    expect(validateEnvelope({ ...(goldenEnvelope as object), title: 'x' })).toBe(false)
  })

  it('rejects a call whose measuredCostUSD is set without a measured costBasis', () => {
    const env = structuredClone(goldenEnvelope) as {
      sessions: { calls: Array<Record<string, unknown>> }[]
    }
    env.sessions[0].calls[1].measuredCostUSD = 0.99 // this call is 'estimated'
    expect(ObservationEnvelope.safeParse(env).success).toBe(false)
  })

  it('rejects a toolNames entry that carries arguments', () => {
    const env = structuredClone(goldenEnvelope) as {
      sessions: { calls: Array<Record<string, unknown>> }[]
    }
    env.sessions[0].calls[0].toolNames = ['Bash(rm -rf /)']
    expect(ObservationEnvelope.safeParse(env).success).toBe(false)
  })

  it('rejects a non-fingerprint sessionRef', () => {
    const env = structuredClone(goldenEnvelope) as { sessions: Array<Record<string, unknown>> }
    env.sessions[0].sessionRef = 'raw-session-id-not-a-hash'
    expect(ObservationEnvelope.safeParse(env).success).toBe(false)
  })
})
