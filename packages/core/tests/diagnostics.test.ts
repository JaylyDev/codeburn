import { describe, expect, it } from 'vitest'

import {
  DIAGNOSTIC_DETAIL_MAX,
  DiagnosticDetail,
  RecordDiagnostic,
  isolateRecords,
  sanitizeDetail,
} from '../src/diagnostics.js'
import type { SessionObservation } from '../src/observations.js'

const fakeSession = (ref: string): SessionObservation => ({
  sessionRef: ref,
  projectRef: '0000000000000000',
  providerId: 'claude',
  startedAt: '2026-07-17T10:00:00.000Z',
  calls: [],
  turnCount: 0,
})

describe('DiagnosticDetail validator', () => {
  it('accepts a bounded, path-free message', () => {
    expect(DiagnosticDetail.safeParse('unexpected token at position 4').success).toBe(true)
  })

  it('rejects forward-slash paths', () => {
    expect(DiagnosticDetail.safeParse('failed on /home/u/secret.json').success).toBe(false)
  })

  it('rejects backslash paths', () => {
    expect(DiagnosticDetail.safeParse('failed on C:\\Users\\me\\x').success).toBe(false)
  })

  it('rejects strings over the max length', () => {
    expect(DiagnosticDetail.safeParse('x'.repeat(DIAGNOSTIC_DETAIL_MAX + 1)).success).toBe(false)
  })

  it('RecordDiagnostic is strict (rejects unknown fields)', () => {
    expect(
      RecordDiagnostic.safeParse({ code: 'other', detail: 'ok', extra: 'nope' }).success,
    ).toBe(false)
  })
})

describe('sanitizeDetail', () => {
  it('strips path separators so the result passes DiagnosticDetail', () => {
    const out = sanitizeDetail(new Error('cannot read /etc/passwd or C:\\secret'))
    expect(out).not.toMatch(/[\\/]/)
    expect(DiagnosticDetail.safeParse(out).success).toBe(true)
  })

  it('caps length at the max', () => {
    expect(sanitizeDetail('y'.repeat(1000)).length).toBe(DIAGNOSTIC_DETAIL_MAX)
  })
})

describe('isolateRecords poison isolation', () => {
  it('a throwing record becomes a diagnostic and never drops its siblings', () => {
    const records = ['good-1', 'POISON', 'good-2']
    const { observations, diagnostics } = isolateRecords(records, (record, index) => {
      if (record === 'POISON') throw new Error('kaboom at /secret/path')
      return { observations: [fakeSession(`ref-${index}`)] }
    })

    expect(observations.map((o) => o.sessionRef)).toEqual(['ref-0', 'ref-2'])
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0].index).toBe(1)
    expect(diagnostics[0].code).toBe('other')
    // The thrown message's path must have been sanitized out.
    expect(diagnostics[0].detail).not.toMatch(/[\\/]/)
    expect(RecordDiagnostic.safeParse(diagnostics[0]).success).toBe(true)
  })

  it('aggregates observations and diagnostics returned by decodeOne', () => {
    const { observations, diagnostics } = isolateRecords([1, 2], (_r, index) => ({
      observations: [fakeSession(`s-${index}`)],
      diagnostics: [{ index, code: 'invalid-value' as const, detail: 'clamped a value' }],
    }))
    expect(observations).toHaveLength(2)
    expect(diagnostics).toHaveLength(2)
  })

  it('never throws even when every record is poison', () => {
    const { observations, diagnostics } = isolateRecords(['a', 'b'], () => {
      throw new Error('always bad')
    })
    expect(observations).toEqual([])
    expect(diagnostics).toHaveLength(2)
  })
})
