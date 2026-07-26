import { describe, expect, it } from 'vitest'

import { Confidence, Evidence, Finding } from '../src/contracts.js'

// Advisory-findings gate (decision D5-A, phase 7). The phase-6 architecture gate
// (architecture-gate.test.ts) proves, by scanning the compiled JSON schema, that
// no free-text string FIELD exists on the Finding. This complements it from the
// other direction: it exercises the zod schema at runtime to prove the Finding
// contract is structurally incapable of carrying a concrete fix payload — a
// file path, file content, a command, or paste text. Every concrete fix payload
// is re-derived host-side (optimize.ts) from the CLI's own ToolCall[]; a core
// Finding may only carry counts, confidence and 16-hex fingerprint refs, so a
// migrated detector can never become a channel for host-executable content.

// Names a WasteAction / apply payload would use if one ever leaked into the wire
// Finding. None of these may exist on the Finding, its Evidence, or Confidence.
const FORBIDDEN_KEYS = [
  'fix',
  'command',
  'content',
  'path',
  'text',
  'file_path',
  'filePath',
  'cmd',
  'apply',
  'destination',
  'label',
] as const

const baseFinding = () => ({
  detectorId: 'duplicate-reads',
  algorithmVersion: '1.0.0',
  confidence: { score: 0.5, basis: 'demo' },
  evidence: [
    { kind: 'duplicate-reads', count: 7, refs: ['deadbeefcafe0011'], sessionRefs: ['a1b2c3d4e5f60718'] },
    { kind: 'tokens-saved', count: 3500 },
  ],
})

describe('Finding contract cannot carry a fix payload (D5-A advisory gate)', () => {
  it('the golden-shaped Finding parses', () => {
    expect(Finding.safeParse(baseFinding()).success).toBe(true)
  })

  it('the Finding schema declares none of the fix-payload keys', () => {
    const declared = Object.keys(Finding.shape)
    for (const key of FORBIDDEN_KEYS) {
      expect(declared, `Finding must not declare "${key}"`).not.toContain(key)
    }
    // Positive lock on the entire allowed surface: if a new top-level key is
    // added it must be reviewed here, not silently accepted.
    expect(declared.sort()).toEqual(
      ['algorithmVersion', 'confidence', 'detectorId', 'evidence', 'impactUSD'].sort(),
    )
  })

  it('.strict() rejects a fix-payload key smuggled at the top level', () => {
    for (const key of FORBIDDEN_KEYS) {
      const smuggled = { ...baseFinding(), [key]: 'rm -rf / || cat /etc/passwd' }
      expect(Finding.safeParse(smuggled).success, `top-level "${key}" must be rejected`).toBe(false)
    }
  })

  it('.strict() rejects a fix-payload key smuggled onto an Evidence item', () => {
    for (const key of FORBIDDEN_KEYS) {
      const evil = { kind: 'duplicate-reads', count: 1, [key]: '/Users/victim/.ssh/id_rsa' }
      expect(Evidence.safeParse(evil).success, `evidence "${key}" must be rejected`).toBe(false)
      const finding = { ...baseFinding(), evidence: [evil] }
      expect(Finding.safeParse(finding).success, `nested evidence "${key}" must be rejected`).toBe(false)
    }
  })

  it('.strict() rejects a fix-payload key smuggled onto Confidence', () => {
    for (const key of FORBIDDEN_KEYS) {
      const evil = { score: 0.5, basis: 'demo', [key]: 'echo pwned' }
      expect(Confidence.safeParse(evil).success, `confidence "${key}" must be rejected`).toBe(false)
    }
  })

  it('evidence refs and sessionRefs accept only 16-char lowercase-hex fingerprints', () => {
    const notFingerprints = [
      '/Users/torukmakto/project/src/secret.ts', // a raw path
      'deadbeefcafe0011deadbeef', // 24 hex (too long)
      'deadbeefcafe001', // 15 hex (too short)
      'DEADBEEFCAFE0011', // uppercase
      'deadbeefcafeg011', // non-hex char
      'src/index.ts', // arbitrary text
    ]
    for (const bad of notFingerprints) {
      const finding = { ...baseFinding(), evidence: [{ kind: 'k', refs: [bad] }] }
      expect(Finding.safeParse(finding).success, `ref "${bad}" must be rejected`).toBe(false)
      const finding2 = { ...baseFinding(), evidence: [{ kind: 'k', sessionRefs: [bad] }] }
      expect(Finding.safeParse(finding2).success, `sessionRef "${bad}" must be rejected`).toBe(false)
    }
    const ok = { ...baseFinding(), evidence: [{ kind: 'k', refs: ['0f1e2d3c4b5a6978'] }] }
    expect(Finding.safeParse(ok).success).toBe(true)
  })

  it('a parsed Finding recursively contains no fix-payload key', () => {
    const parsed = Finding.parse(baseFinding())
    const seen: string[] = []
    const walk = (node: unknown) => {
      if (Array.isArray(node)) return node.forEach(walk)
      if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
          seen.push(k)
          walk(v)
        }
      }
    }
    walk(parsed)
    for (const key of FORBIDDEN_KEYS) {
      expect(seen, `parsed Finding must not surface "${key}"`).not.toContain(key)
    }
  })
})
