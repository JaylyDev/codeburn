import { describe, it, expect } from 'vitest'

import fallback from '../src/data/pricing-fallback.json' with { type: 'json' }
import snapshot from '../src/data/litellm-snapshot.json' with { type: 'json' }

// The gap-fill fallback is generated from models.dev / OpenRouter. These assert
// the bundler's hygiene guarantees on the committed artifact, so a future
// rebundle that regresses them fails CI rather than shipping bad pricing.
describe('pricing-fallback.json data hygiene', () => {
  const entries = Object.entries(fallback as Record<string, (number | null)[]>)

  it('is non-empty', () => {
    expect(entries.length).toBeGreaterThan(50)
  })

  it('has no negative rates (OpenRouter -1 "variable price" sentinels)', () => {
    const bad = entries.filter(([, v]) => (v[0] ?? 0) < 0 || (v[1] ?? 0) < 0 || (v[2] ?? 0) < 0 || (v[3] ?? 0) < 0)
    expect(bad.map(([k]) => k)).toEqual([])
  })

  it('has no entry that is free on both input and output', () => {
    const bad = entries.filter(([, v]) => v[0] === 0 && v[1] === 0)
    expect(bad.map(([k]) => k)).toEqual([])
  })

  it('has no unreachable @pin or date-suffixed keys', () => {
    const bad = entries.filter(([k]) => /@/.test(k) || /\d{8}$/.test(k))
    expect(bad.map(([k]) => k)).toEqual([])
  })

  it('stores per-token rates (no per-million values leaked through)', () => {
    // A per-million value would be >= 1; real per-token rates are tiny.
    const bad = entries.filter(([, v]) => (v[0] ?? 0) >= 1 || (v[1] ?? 0) >= 1)
    expect(bad.map(([k]) => k)).toEqual([])
  })
})

// MANUAL_ENTRIES from scripts/bundle-litellm.mjs land in litellm-snapshot.json.
// These pin the hand-curated tuples so a rebundle that regresses them fails CI,
// and hold them to the same hygiene guarantees the fallback checks enforce.
describe('litellm-snapshot.json manual entries', () => {
  const manual = snapshot as unknown as Record<string, (number | null)[]>

  it('pins ornith-1.0-35b ($0.10/M in, $0.75/M out, no published cache rates)', () => {
    expect(manual['ornith-1.0-35b']).toEqual([1e-7, 7.5e-7, null, null])
  })

  it('pins ornith-1.5-35b-a3b ($0.10/M in, $0.40/M out, $0.01/M cache read)', () => {
    expect(manual['ornith-1.5-35b-a3b']).toEqual([1e-7, 4e-7, null, 1e-8])
  })

  it('keeps manual entries free of negative, free-on-both, or per-million rates', () => {
    const bad = Object.entries(manual).filter(
      ([k, v]) =>
        ['ornith-1.0-35b', 'ornith-1.5-35b-a3b'].includes(k) &&
        ((v[0] ?? 0) < 0 || (v[1] ?? 0) < 0 || (v[2] ?? 0) < 0 || (v[3] ?? 0) < 0 ||
          (v[0] === 0 && v[1] === 0) || (v[0] ?? 0) >= 1 || (v[1] ?? 0) >= 1),
    )
    expect(bad.map(([k]) => k)).toEqual([])
  })

  it('uses reachable keys (no @pin or date suffix)', () => {
    for (const k of ['ornith-1.0-35b', 'ornith-1.5-35b-a3b']) {
      expect(/@/.test(k) || /\d{8}$/.test(k)).toBe(false)
      expect(manual[k]).toBeDefined()
    }
  })
})
