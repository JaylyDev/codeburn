import { describe, expect, it } from 'vitest'

import { Finding } from '../src/contracts.js'
import type { CallObservation, ObservationEnvelope, SessionObservation } from '../src/observations.js'
import type { ResourceClassName, ResourceRef } from '../src/schema.js'
import {
  contextBloatDetector,
  detectors,
  duplicateReadsDetector,
  junkReadsDetector,
} from '../src/detectors/index.js'

// ── Envelope builders ──────────────────────────────────────────────────────

let idSeq = 0
function hex32(): string {
  idSeq++
  return idSeq.toString(16).padStart(32, '0')
}

function ref(resourceClass: ResourceClassName, resourceId = hex32()): ResourceRef {
  return { resourceId, resourceClass }
}

function callWith(fields: Partial<CallObservation>): CallObservation {
  return {
    provider: 'claude',
    model: 'claude-opus-4-8',
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheCreate: 0 },
    webSearchRequests: 0,
    speed: 'standard',
    costBasis: 'estimated',
    timestamp: '2026-07-17T10:00:00.000Z',
    dedupKey: `d${idSeq++}`,
    toolNames: [],
    turnIndex: 0,
    ...fields,
  }
}

// Map a short test label to a stable 32-hex sessionRef (evidence.sessionRefs
// must be fingerprints, so a bare 's1' would fail Finding validation).
const srefs = new Map<string, string>()
function srefFor(label: string): string {
  let v = srefs.get(label)
  if (!v) { v = hex32(); srefs.set(label, v) }
  return v
}

function session(label: string, calls: CallObservation[]): SessionObservation {
  return {
    sessionRef: srefFor(label),
    projectRef: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
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
  expect(Finding.safeParse(f).success).toBe(true)
  const finding = f as import('../src/contracts.js').Finding
  expect(finding.evidence.length).toBeGreaterThan(0)
  expect(finding.confidence.basis.length).toBeGreaterThan(0)
  expect(finding.confidence.score).toBeGreaterThanOrEqual(0)
  expect(finding.confidence.score).toBeLessThanOrEqual(1)
  expect(finding.algorithmVersion).toBe('1.0.0')
}

// ── junk-reads ─────────────────────────────────────────────────────────────

describe('junkReadsDetector', () => {
  const junkCall = (n: number, cls: ResourceClassName = 'dependency') =>
    callWith({ toolNames: ['Read'], resourceReads: Array.from({ length: n }, () => ref(cls)) })

  it('returns nothing below the 3-read threshold', () => {
    expect(junkReadsDetector(envelope([session('s1', [junkCall(2)])]))).toEqual([])
  })

  it('flags at exactly the threshold (boundary)', () => {
    const findings = junkReadsDetector(envelope([session('s1', [junkCall(3)])]))
    expect(findings).toHaveLength(1)
    assertWellFormed(findings[0])
    const ev = findings[0].evidence.find(e => e.kind === 'junk-reads')!
    expect(ev.count).toBe(3)
    expect(findings[0].evidence.find(e => e.kind === 'tokens-saved')!.count).toBe(1800)
  })

  it('counts dependency, build and vcs classes as junk', () => {
    const call = callWith({
      toolNames: ['Read'],
      resourceReads: [ref('dependency'), ref('build'), ref('vcs')],
    })
    expect(junkReadsDetector(envelope([session('s1', [call])]))).toHaveLength(1)
  })

  it('ignores non-junk resource classes (source/config/doc/other)', () => {
    const call = callWith({
      toolNames: ['Read'],
      resourceReads: [ref('source'), ref('config'), ref('doc'), ref('other')],
    })
    expect(junkReadsDetector(envelope([session('s1', [call])]))).toEqual([])
  })

  it('scales confidence with read count', () => {
    const low = junkReadsDetector(envelope([session('s1', [junkCall(3)])]))[0]
    const high = junkReadsDetector(envelope([session('s1', [junkCall(20)])]))[0]
    expect(high.confidence.score).toBeGreaterThan(low.confidence.score)
  })
})

// ── duplicate-reads ──────────────────────────────────────────────────────────

describe('duplicateReadsDetector', () => {
  it('sums extra reads of the same file within a session', () => {
    const id = hex32()
    const call = callWith({ toolNames: ['Read'], resourceReads: Array.from({ length: 6 }, () => ref('source', id)) })
    const findings = duplicateReadsDetector(envelope([session('s1', [call])]))
    expect(findings).toHaveLength(1)
    assertWellFormed(findings[0])
    expect(findings[0].evidence.find(e => e.kind === 'duplicate-reads')!.count).toBe(5)
  })

  it('does not count the same file across different sessions', () => {
    const id = hex32()
    const mk = (s: string) => session(s, [callWith({ toolNames: ['Read'], resourceReads: [ref('source', id)] })])
    expect(duplicateReadsDetector(envelope([mk('s1'), mk('s2'), mk('s3')]))).toEqual([])
  })

  it('excludes junk-class re-reads', () => {
    const id = hex32()
    const call = callWith({ toolNames: ['Read'], resourceReads: Array.from({ length: 10 }, () => ref('dependency', id)) })
    expect(duplicateReadsDetector(envelope([session('s1', [call])]))).toEqual([])
  })

  it('is null just below the 5-extra threshold and flags at it (boundary)', () => {
    const idA = hex32()
    const four = callWith({ toolNames: ['Read'], resourceReads: Array.from({ length: 5 }, () => ref('source', idA)) })
    expect(duplicateReadsDetector(envelope([session('s1', [four])]))).toEqual([]) // 4 extras
    const idB = hex32()
    const five = callWith({ toolNames: ['Read'], resourceReads: Array.from({ length: 6 }, () => ref('source', idB)) })
    expect(duplicateReadsDetector(envelope([session('s1', [five])]))).toHaveLength(1) // 5 extras
  })
})

// ── context-bloat (read-to-edit ratio) ────────────────────────────────────────

describe('contextBloatDetector', () => {
  const reads = (n: number, name = 'Read') => Array.from({ length: n }, () => callWith({ toolNames: [name] }))
  const edits = (n: number, name = 'Edit') => Array.from({ length: n }, () => callWith({ toolNames: [name] }))

  it('returns nothing below the minimum edit count', () => {
    expect(contextBloatDetector(envelope([session('s1', [...reads(1), ...edits(2)])]))).toEqual([])
  })

  it('returns nothing when the ratio is healthy (boundary at 4:1)', () => {
    expect(contextBloatDetector(envelope([session('s1', [...reads(40), ...edits(10)])]))).toEqual([])
  })

  it('flags when edits outpace reads', () => {
    const findings = contextBloatDetector(envelope([session('s1', [...reads(5), ...edits(10)])]))
    expect(findings).toHaveLength(1)
    assertWellFormed(findings[0])
    expect(findings[0].evidence.find(e => e.kind === 'reads')!.count).toBe(5)
    expect(findings[0].evidence.find(e => e.kind === 'edits')!.count).toBe(10)
    // extraReadsNeeded = round(10*4) - 5 = 35 -> 35 * 600
    expect(findings[0].evidence.find(e => e.kind === 'tokens-saved')!.count).toBe(21000)
  })

  it('counts Grep and Glob as reads', () => {
    // 40 Grep reads / 10 edits = healthy -> no finding
    expect(contextBloatDetector(envelope([session('s1', [...reads(40, 'Grep'), ...edits(10)])]))).toEqual([])
  })

  it('counts Write and NotebookEdit as edits', () => {
    const findings = contextBloatDetector(envelope([session('s1', [...reads(15), ...edits(6, 'Write'), ...edits(4, 'NotebookEdit')])]))
    expect(findings).toHaveLength(1)
  })
})

describe('detectors registry', () => {
  it('exports all three detectors', () => {
    expect(detectors).toHaveLength(3)
  })

  it('every emitted finding across detectors is well-formed', () => {
    const env = envelope([
      session('s1', [
        callWith({ toolNames: ['Read'], resourceReads: [ref('dependency'), ref('build'), ref('vcs')] }),
        callWith({ toolNames: ['Read'], resourceReads: Array.from({ length: 6 }, () => ref('source', 'cccccccccccccccccccccccccccccccc')) }),
        ...Array.from({ length: 5 }, () => callWith({ toolNames: ['Read'] })),
        ...Array.from({ length: 10 }, () => callWith({ toolNames: ['Edit'] })),
      ]),
    ])
    const all = detectors.flatMap(d => d(env))
    expect(all.length).toBe(3)
    for (const f of all) assertWellFormed(f)
  })
})
