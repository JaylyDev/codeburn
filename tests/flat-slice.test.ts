/**
 * Tests for flatSlice — the SlicedString-retention fix.
 *
 * Background: `String.prototype.slice` returns a V8 SlicedString that
 * retains its entire parent string. Storing short slices of large session
 * strings (100KB+ agent prompts) in the long-lived session cache pinned
 * gigabytes of parent buffers during cold parses, OOMing the default heap
 * (issue observed at ~5.5GB peak for 3.2GB of kiro session files; ~300MB
 * after flattening).
 */

import { describe, it, expect } from 'vitest'

import { flatSlice, flatString } from '../src/content-utils.js'

describe('flatSlice', () => {
  it('returns the prefix for strings over the bound', () => {
    const big = 'x'.repeat(10_000)
    const out = flatSlice(big, 500)
    expect(out.length).toBe(500)
    expect(out).toBe(big.slice(0, 500))
  })

  it('returns the string itself when within the bound', () => {
    const small = 'hello world'
    expect(flatSlice(small, 500)).toBe(small)
  })

  it('handles multi-byte characters without corruption', () => {
    // Emoji + CJK near the boundary — Buffer round-trip must not produce
    // invalid UTF-8 replacement chars for chars fully inside the slice.
    const s = '🐾'.repeat(300) // each emoji is 2 UTF-16 code units
    const out = flatSlice(s, 500)
    expect(out).toBe(s.slice(0, 500))
  })

  it('documents the mid-surrogate-pair cut behavior (U+FFFD)', () => {
    // A cut landing between the high and low surrogate of a pair leaves a
    // lone surrogate. Plain .slice() preserves it; the Buffer round-trip
    // replaces it with U+FFFD. Either way the string is length-bounded and
    // the preceding content is intact — this test pins the chosen behavior
    // so a future implementation change is a conscious decision.
    const s = 'ab' + '🐾'.repeat(300) // odd offset puts every emoji across even boundaries
    const out = flatSlice(s, 501)     // cuts mid-pair
    expect(out.length).toBe(501)
    expect(out.slice(0, 500)).toBe(s.slice(0, 500)) // content before the cut intact
    expect(out.charCodeAt(500)).toBe(0xfffd)        // lone surrogate became U+FFFD
  })

  it('does not retain the parent string (heap growth stays bounded)', () => {
    // Property test for the retention fix: keep 1000 short prefixes of
    // 1000 distinct 100KB strings. With plain .slice() each prefix pins its
    // 100KB parent (~200MB in UTF-16 total). With flatSlice, retained data
    // is ~1000 × 500 chars ≈ 1MB. Assert heap growth is far below the
    // retention scenario. Threshold is generous (50MB) to be CI-safe while
    // still failing decisively if retention returns (>190MB). When the test
    // runner exposes gc (vitest under --expose-gc), force a collection so
    // transient parent garbage doesn't inflate the measurement.
    const before = process.memoryUsage().heapUsed
    const kept: string[] = []
    for (let i = 0; i < 1000; i++) {
      // Distinct content so V8 cannot intern/share the parents.
      const parent = (i % 10).toString().repeat(100_000)
      kept.push(flatSlice(parent + i, 500))
    }
    if (typeof global.gc === 'function') global.gc()
    const after = process.memoryUsage().heapUsed
    const growthMB = (after - before) / 1048576
    expect(kept.length).toBe(1000)
    expect(growthMB).toBeLessThan(50)
  })
})

describe('flatString', () => {
  it('returns an equal string for any input', () => {
    expect(flatString('')).toBe('')
    expect(flatString('hello')).toBe('hello')
    expect(flatString('🐾 multi-byte ✓')).toBe('🐾 multi-byte ✓')
  })

  it('does not retain the parent of a regex match group', () => {
    // match[1] is a SlicedString retaining the entire subject. flatString
    // must break that link: keep 1000 short match groups of distinct 100KB
    // subjects and assert bounded heap growth (same thresholds as the
    // flatSlice retention test).
    const before = process.memoryUsage().heapUsed
    const kept: string[] = []
    for (let i = 0; i < 1000; i++) {
      const subject = `<name>tool_${i}</name>` + (i % 10).toString().repeat(100_000)
      const m = /<name>([^<]+)<\/name>/.exec(subject)
      kept.push(flatString(m![1]!))
    }
    if (typeof global.gc === 'function') global.gc()
    const after = process.memoryUsage().heapUsed
    const growthMB = (after - before) / 1048576
    expect(kept.length).toBe(1000)
    expect(growthMB).toBeLessThan(50)
  })
})
