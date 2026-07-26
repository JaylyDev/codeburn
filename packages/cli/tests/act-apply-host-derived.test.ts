import { describe, it, expect } from 'vitest'

import {
  detectJunkReads,
  detectDuplicateReads,
  detectLowReadEditRatio,
  type ToolCall,
} from '../src/optimize.js'
import { resourceFingerprint } from '@codeburn/core/fingerprint'
import { getHostPrivacyKey } from '../src/privacy-key.js'

// Decision D5-A (phase 7): the three fingerprint-migrated detectors
// (junk-reads -> build-folder-reads, duplicate-reads -> redundant-rereads,
// context-bloat -> read-edit-ratio) delegate the DECISION and the counts to the
// pure @codeburn/core detector, which sees only fingerprinted resource refs. But
// every concrete `fix` payload and every displayed path/basename is re-derived
// HOST-SIDE from the CLI's own ToolCall[] — the reverse of the fingerprint,
// which the host holds because it never discarded its raw paths. This test locks
// two properties:
//   (1) the fix payloads stay byte-identical to their goldens, and
//   (2) the display path is produced from the host's raw calls (the "reverse
//       map"), NOT by inverting a fingerprint — proven by a case where the exact
//       basename can only come from raw data, while the core-visible fingerprint
//       never surfaces in the finding.

const rd = (fp: string): ToolCall => ({ name: 'Read', input: { file_path: fp }, sessionId: 's1', project: 'p1' })
const ed = (fp: string): ToolCall => ({ name: 'Edit', input: { file_path: fp }, sessionId: 's1', project: 'p1' })

describe('migrated detectors: fix payloads are byte-identical goldens', () => {
  it('build-folder-reads (junk-reads) fix payload', () => {
    const calls = Array.from({ length: 6 }, (_, i) => rd(`/home/u/proj/node_modules/pkg/f${i}.js`))
    const finding = detectJunkReads(calls)
    expect(finding).not.toBeNull()
    expect(finding!.fix).toEqual({
      type: 'paste',
      destination: 'claude-md',
      label: 'Append to your project CLAUDE.md:',
      text: 'Do not read or search files under these directories unless I explicitly ask: node_modules, .git, dist, __pycache__.',
    })
  })

  it('redundant-rereads (duplicate-reads) fix payload', () => {
    const calls = Array.from({ length: 7 }, () => rd('/home/u/proj/src/Zebra_9xQ.ts'))
    const finding = detectDuplicateReads(calls)
    expect(finding).not.toBeNull()
    expect(finding!.fix).toEqual({
      type: 'paste',
      destination: 'prompt',
      label: 'Point Claude at exact locations in your prompt, for example:',
      text: 'In <file> lines <start>-<end>, look at the <function> function.',
    })
  })

  it('read-edit-ratio (context-bloat) fix payload', () => {
    const calls = [
      ...Array.from({ length: 12 }, (_, i) => ed(`/home/u/proj/src/e${i}.ts`)),
      rd('/home/u/proj/src/a.ts'),
      rd('/home/u/proj/src/b.ts'),
    ]
    const finding = detectLowReadEditRatio(calls)
    expect(finding).not.toBeNull()
    expect(finding!.fix).toEqual({
      type: 'paste',
      destination: 'claude-md',
      label: 'Add to your CLAUDE.md:',
      text: 'Before editing any file, read it first. Before modifying a function, grep for all callers. Research before you edit.',
    })
  })
})

describe('displayed paths are host-derived (reverse map), never un-fingerprinted', () => {
  // The core Finding for duplicate-reads carries only a 16-hex resourceId + counts
  // (see packages/core/src/detectors/duplicate-reads.ts). The displayed per-file
  // breakdown names the actual basename, which the one-way HMAC fingerprint can
  // never yield. So its presence proves the host recovered the path from the raw
  // ToolCall[] it holds — the reverse map is REQUIRED to render this string.
  const RAW_PATH = '/home/u/proj/src/Zebra_9xQ_UNIQUE.ts'
  const BASENAME = 'Zebra_9xQ_UNIQUE.ts'

  it('the distinct basename is rendered, and its fingerprint never leaks', () => {
    const calls = Array.from({ length: 7 }, () => rd(RAW_PATH))
    const finding = detectDuplicateReads(calls)!
    const fp = resourceFingerprint(getHostPrivacyKey(), RAW_PATH)

    // A well-formed one-way fingerprint (what the core detector actually sees).
    expect(fp.resourceId).toMatch(/^[0-9a-f]{16}$/)
    expect(fp.resourceId).not.toBe(RAW_PATH)

    // Host-derived display: the real basename appears...
    expect(finding.explanation).toContain(BASENAME)
    // ...while the core-visible fingerprint appears nowhere in the finding.
    const serialized = JSON.stringify(finding)
    expect(serialized).not.toContain(fp.resourceId)
    expect(serialized).not.toContain(RAW_PATH) // full path is never emitted either
  })

  it('changing only the basename changes the display but not the core count', () => {
    // Same read structure (7 reads of one file) -> identical core decision/count;
    // only the host-held raw path differs, so only the displayed basename moves.
    const a = detectDuplicateReads(Array.from({ length: 7 }, () => rd('/home/u/proj/src/Alpha.ts')))!
    const b = detectDuplicateReads(Array.from({ length: 7 }, () => rd('/home/u/proj/src/Bravo.ts')))!

    expect(a.tokensSaved).toBe(b.tokensSaved) // count comes from core, path-agnostic
    expect(a.explanation).toContain('Alpha.ts')
    expect(a.explanation).not.toContain('Bravo.ts')
    expect(b.explanation).toContain('Bravo.ts')
    expect(b.explanation).not.toContain('Alpha.ts')
  })

  it('junk-reads names the directory from the raw path, not from any fingerprint', () => {
    // A junk dir buried in a distinctive path: the fix text must name the dir,
    // which is only knowable from the raw path the host retained.
    const calls = Array.from({ length: 6 }, (_, i) => rd(`/home/u/wsX/coverage/report-${i}.html`))
    const finding = detectJunkReads(calls)!
    expect(finding.fix.type).toBe('paste')
    if (finding.fix.type === 'paste') {
      expect(finding.fix.text).toContain('coverage')
    }
    // The fingerprint of that raw path must not surface in the finding.
    const fp = resourceFingerprint(getHostPrivacyKey(), '/home/u/wsX/coverage/report-0.html')
    expect(JSON.stringify(finding)).not.toContain(fp.resourceId)
  })
})
