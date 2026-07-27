import { describe, expect, it } from 'vitest'

import {
  detectors,
  duplicateReadsDetector,
  junkReadsDetector,
  lowContextBeforeEditDetector,
  ASSUMED_TOKENS_PER_READ,
} from '../src/detectors/index.js'
import { Finding, FINDING_SCHEMA_VERSION } from '../src/contracts.js'
import type { CallObservation, ObservationEnvelope, SessionObservation } from '../src/observations.js'
import type { ResourceClassName, ResourceRef } from '../src/schema.js'

// ── Envelope builders ──────────────────────────────────────────────────────

let idSeq = 0
function hex32(): string {
  idSeq++
  return idSeq.toString(16).padStart(32, '0')
}

function ref(resourceClass: ResourceClassName, resourceId = hex32()): ResourceRef {
  return { resourceId, resourceClass }
}

function callWith(overrides: Partial<CallObservation> = {}): CallObservation {
  return {
    provider: 'claude',
    model: 'claude-opus-4-8',
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheCreate: 0 },
    webSearchRequests: 0,
    speed: 'standard',
    costBasis: 'estimated',
    timestamp: '2026-07-17T10:00:00.000Z',
    callRef: hex32(),
    toolNames: [],
    turnIndex: 0,
    ...overrides,
  }
}

const srefs = new Map<string, string>()
function srefFor(label: string): string {
  let v = srefs.get(label)
  if (!v) {
    v = hex32()
    srefs.set(label, v)
  }
  return v
}

function session(label: string, calls: CallObservation[]): SessionObservation {
  return {
    sessionRef: srefFor(label),
    projectRef: 'a'.repeat(32),
    providerId: 'claude',
    startedAt: '2026-07-17T10:00:00.000Z',
    calls,
    turnCount: 1,
  }
}

function envelope(sessions: SessionObservation[]): ObservationEnvelope {
  return {
    schemaVersion: '0.3.0',
    generator: { name: '@codeburn/core', version: '0.0.0-test' },
    fingerprints: { algorithm: 'hmac-sha256-128', keyId: 'test-key' },
    sessions,
  }
}

/** Every finding must satisfy the wire contract and the gate-4 invariants. */
function assertWellFormed(f: unknown) {
  const parsed = Finding.safeParse(f)
  expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)
  const finding = f as import('../src/contracts.js').Finding
  expect(finding.schemaVersion).toBe(FINDING_SCHEMA_VERSION)
  expect(finding.evidence.length).toBeGreaterThan(0)
  expect(finding.confidence.basis.length).toBeGreaterThan(0)
  expect(finding.confidence.score).toBeGreaterThanOrEqual(0)
  expect(finding.confidence.score).toBeLessThanOrEqual(1)
  expect(finding.subject.ref).toMatch(/^[0-9a-f]{32}$/)
  // No finding may carry money, in any form.
  expect(JSON.stringify(finding)).not.toMatch(/usd|impact|dollar|cash.{0,4}:.{0,4}false/i)
}

const junkCall = (n: number, cls: ResourceClassName = 'dependency') =>
  callWith({
    toolNames: ['Read'],
    resourceReads: Array.from({ length: n }, () => ref(cls)),
  })

const editCalls = (n: number) =>
  Array.from({ length: n }, () => callWith({ toolNames: ['Edit'] }))

// ── junk-reads ─────────────────────────────────────────────────────────────

describe('junkReadsDetector', () => {
  it('does not flag below the threshold', () => {
    expect(junkReadsDetector(envelope([session('s1', [junkCall(2)])]))).toEqual([])
  })

  it('flags at exactly the threshold (boundary)', () => {
    const found = junkReadsDetector(envelope([session('s1', [junkCall(3)])]))
    expect(found).toHaveLength(1)
    assertWellFormed(found[0])
    expect(found[0]!.evidence[0]!.count).toBe(3)
  })

  it('ignores reads of the user own source', () => {
    expect(junkReadsDetector(envelope([session('s1', [junkCall(9, 'source')])]))).toEqual([])
  })

  it('estimates avoidable tokens, labelled non-cash and method-versioned', () => {
    const [finding] = junkReadsDetector(envelope([session('s1', [junkCall(5)])]))
    expect(finding!.estimate).toEqual({
      metric: 'avoidable-tokens',
      value: 5 * ASSUMED_TOKENS_PER_READ,
      unit: 'tokens',
      methodId: 'fixed-read-token-assumption',
      methodVersion: '1.0.0',
      nonCash: true,
    })
  })
})

// ── duplicate-reads ────────────────────────────────────────────────────────

describe('duplicateReadsDetector', () => {
  it('does not flag distinct files read once each', () => {
    const calls = Array.from({ length: 9 }, () =>
      callWith({ toolNames: ['Read'], resourceReads: [ref('source')] }),
    )
    expect(duplicateReadsDetector(envelope([session('s1', calls)]))).toEqual([])
  })

  it('sums extra reads of the same file within a session', () => {
    const id = hex32()
    const calls = Array.from({ length: 7 }, () =>
      callWith({ toolNames: ['Read'], resourceReads: [ref('source', id)] }),
    )
    const [finding] = duplicateReadsDetector(envelope([session('s1', calls)]))
    assertWellFormed(finding)
    // 7 reads of one file = 6 extras.
    expect(finding!.evidence[0]!.count).toBe(6)
    expect(finding!.estimate!.value).toBe(6 * ASSUMED_TOKENS_PER_READ)
  })

  it('does not pool duplicate counts across sessions', () => {
    const id = hex32()
    const threeReads = () =>
      Array.from({ length: 3 }, () =>
        callWith({ toolNames: ['Read'], resourceReads: [ref('source', id)] }),
      )
    // 2 extras per session — under the threshold of 5 in BOTH, and pooling
    // them would wrongly reach 4. Neither may flag.
    const found = duplicateReadsDetector(
      envelope([session('pool-a', threeReads()), session('pool-b', threeReads())]),
    )
    expect(found).toEqual([])
  })

  it('excludes junk resources from the duplicate count', () => {
    const id = hex32()
    const calls = Array.from({ length: 9 }, () =>
      callWith({ toolNames: ['Read'], resourceReads: [ref('dependency', id)] }),
    )
    expect(duplicateReadsDetector(envelope([session('s1', calls)]))).toEqual([])
  })
})

// ── low-context-before-edit ────────────────────────────────────────────────

describe('lowContextBeforeEditDetector', () => {
  it('does not flag below the minimum edit count', () => {
    expect(lowContextBeforeEditDetector(envelope([session('s1', editCalls(9))]))).toEqual([])
  })

  it('does not flag a healthy read-to-edit ratio', () => {
    const calls = [
      ...editCalls(10),
      ...Array.from({ length: 40 }, () => callWith({ toolNames: ['Read'] })),
    ]
    expect(lowContextBeforeEditDetector(envelope([session('s1', calls)]))).toEqual([])
  })

  it('flags when edits outpace reads', () => {
    const calls = [...editCalls(10), callWith({ toolNames: ['Read'] })]
    const [finding] = lowContextBeforeEditDetector(envelope([session('s1', calls)]))
    assertWellFormed(finding)
    expect(finding!.detector.id).toBe('low-context-before-edit')
    const byKind = Object.fromEntries(finding!.evidence.map((e) => [e.kind, e]))
    expect(byKind['reads']!.count).toBe(1)
    expect(byKind['edits']!.count).toBe(10)
    expect(byKind['read-to-edit-ratio']!.value).toBeCloseTo(0.1)
  })

  // The regression the rename exists to prevent.
  it('emits NO token estimate for ten edits and zero reads', () => {
    const [finding] = lowContextBeforeEditDetector(envelope([session('s1', editCalls(10))]))
    expect(finding).toBeDefined()
    expect(finding!.estimate).toBeUndefined()
    expect(JSON.stringify(finding)).not.toContain('avoidable-tokens')
    // The old detector produced 10 edits * 4 * 600 = 24000 "tokens saved" here.
    expect(JSON.stringify(finding)).not.toContain('24000')
  })

  it('never claims avoidable tokens at any ratio', () => {
    for (const reads of [0, 1, 5, 20, 39]) {
      const calls = [
        ...editCalls(10),
        ...Array.from({ length: reads }, () => callWith({ toolNames: ['Read'] })),
      ]
      for (const f of lowContextBeforeEditDetector(envelope([session(`r${reads}`, calls)]))) {
        expect(f.estimate, `ratio with ${reads} reads`).toBeUndefined()
      }
    }
  })
})

// ── per-session scoping ────────────────────────────────────────────────────

describe('findings are scoped to one session', () => {
  it('emits one finding for the only session that crosses the threshold', () => {
    const env = envelope([
      session('quiet', [junkCall(1)]),
      session('noisy', [junkCall(8)]),
    ])
    const found = junkReadsDetector(env)
    expect(found).toHaveLength(1)
    expect(found[0]!.subject).toEqual({ kind: 'session', ref: srefFor('noisy') })
    expect(found[0]!.evidence[0]!.count).toBe(8)
  })

  it('emits two separate findings when both sessions cross, never one aggregate', () => {
    const env = envelope([
      session('both-a', [junkCall(4)]),
      session('both-b', [junkCall(6)]),
    ])
    const found = junkReadsDetector(env)
    expect(found).toHaveLength(2)
    expect(found.map((f) => f.subject.ref).sort()).toEqual(
      [srefFor('both-a'), srefFor('both-b')].sort(),
    )
    // Each finding counts only its own session.
    const counts = found.map((f) => f.evidence[0]!.count).sort()
    expect(counts).toEqual([4, 6])
    for (const f of found) {
      expect(f.evidence[0]!.sessionRefs).toEqual([f.subject.ref])
    }
  })

  it('never emits a finding whose evidence spans more than its subject session', () => {
    const env = envelope([
      session('span-a', [junkCall(5)]),
      session('span-b', [junkCall(5)]),
      session('span-c', [junkCall(5)]),
    ])
    for (const detector of detectors) {
      for (const f of detector(env)) {
        for (const e of f.evidence) {
          expect(e.sessionRefs ?? [f.subject.ref]).toEqual([f.subject.ref])
        }
      }
    }
  })
})

// ── registry ───────────────────────────────────────────────────────────────

describe('detectors registry', () => {
  it('every emitted finding across detectors is well-formed', () => {
    const calls = [
      ...editCalls(12),
      junkCall(6),
      ...Array.from({ length: 6 }, () =>
        callWith({ toolNames: ['Read'], resourceReads: [ref('source', 'b'.repeat(32))] }),
      ),
    ]
    const env = envelope([session('registry', calls)])
    const all = detectors.flatMap((d) => d(env))
    expect(all.length).toBeGreaterThan(0)
    for (const f of all) assertWellFormed(f)
  })

  it('emits a stable, unique detector id per finding', () => {
    const env = envelope([session('ids', [junkCall(9)])])
    const ids = detectors.flatMap((d) => d(env)).map((f) => f.detector.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/)
  })

  it('returns nothing for an empty envelope', () => {
    for (const d of detectors) expect(d(envelope([]))).toEqual([])
  })
})

// ── wire contract negatives ────────────────────────────────────────────────

describe('the finding wire contract rejects dishonest shapes', () => {
  const base = () => ({
    schemaVersion: FINDING_SCHEMA_VERSION,
    detector: { id: 'junk-reads', algorithmVersion: '2.0.0' },
    subject: { kind: 'session' as const, ref: 'c'.repeat(32) },
    confidence: { score: 0.5, basis: ['threshold-only' as const] },
    evidence: [{ kind: 'junk-reads' as const, count: 3 }],
  })

  it('accepts the baseline (so the rejections below mean something)', () => {
    expect(Finding.safeParse(base()).success).toBe(true)
  })

  it('rejects a dollar value', () => {
    expect(Finding.safeParse({ ...base(), impactUSD: 12.5 }).success).toBe(false)
  })

  it('rejects a missing subject', () => {
    const { subject: _omitted, ...noSubject } = base()
    expect(Finding.safeParse(noSubject).success).toBe(false)
  })

  it('rejects a subject that is not a fingerprint', () => {
    const f = { ...base(), subject: { kind: 'session', ref: 'session-abc' } }
    expect(Finding.safeParse(f).success).toBe(false)
  })

  it('rejects nonCash: false', () => {
    const f = {
      ...base(),
      estimate: {
        metric: 'avoidable-tokens',
        value: 100,
        unit: 'tokens',
        methodId: 'fixed-read-token-assumption',
        methodVersion: '1.0.0',
        nonCash: false,
      },
    }
    expect(Finding.safeParse(f).success).toBe(false)
  })

  it('rejects an unknown estimate metric', () => {
    const f = {
      ...base(),
      estimate: {
        metric: 'tokens-saved',
        value: 100,
        unit: 'tokens',
        methodId: 'fixed-read-token-assumption',
        methodVersion: '1.0.0',
        nonCash: true,
      },
    }
    expect(Finding.safeParse(f).success).toBe(false)
  })

  it('rejects a cash unit', () => {
    const f = {
      ...base(),
      estimate: {
        metric: 'avoidable-tokens',
        value: 100,
        unit: 'usd',
        methodId: 'fixed-read-token-assumption',
        methodVersion: '1.0.0',
        nonCash: true,
      },
    }
    expect(Finding.safeParse(f).success).toBe(false)
  })

  it('rejects an estimate with no method identity', () => {
    const f = {
      ...base(),
      estimate: { metric: 'avoidable-tokens', value: 100, unit: 'tokens', nonCash: true },
    }
    expect(Finding.safeParse(f).success).toBe(false)
  })

  it('rejects free-text confidence rationale', () => {
    const f = { ...base(), confidence: { score: 0.5, basis: '3 junk reads; flags at >=3' } }
    expect(Finding.safeParse(f).success).toBe(false)
  })

  it('rejects an unknown confidence basis code', () => {
    const f = { ...base(), confidence: { score: 0.5, basis: ['vibes'] } }
    expect(Finding.safeParse(f).success).toBe(false)
  })

  it('rejects an empty confidence basis', () => {
    const f = { ...base(), confidence: { score: 0.5, basis: [] } }
    expect(Finding.safeParse(f).success).toBe(false)
  })

  it('rejects an arbitrary evidence kind', () => {
    const f = { ...base(), evidence: [{ kind: 'the user read too many files', count: 1 }] }
    expect(Finding.safeParse(f).success).toBe(false)
  })

  it('rejects the retired tokens-saved evidence kind', () => {
    const f = { ...base(), evidence: [{ kind: 'tokens-saved', count: 24000 }] }
    expect(Finding.safeParse(f).success).toBe(false)
  })

  it('rejects evidence-free findings', () => {
    expect(Finding.safeParse({ ...base(), evidence: [] }).success).toBe(false)
  })

  it('rejects a stale schema version', () => {
    expect(Finding.safeParse({ ...base(), schemaVersion: '0.2.0' }).success).toBe(false)
  })
})
