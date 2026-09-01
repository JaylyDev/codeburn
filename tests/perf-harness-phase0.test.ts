import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('..', import.meta.url))

describe('perf harness phase 0', () => {
  it('refuses to write the synthetic fixture under the real home', () => {
    const result = spawnSync(process.execPath, [join(repo, 'scripts/perf/gen-fixture.mjs'), '--home', process.env.HOME ?? ''], {
      encoding: 'utf8',
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/refusing to write fixtures under the real home/)
  })

  it('generates a marked isolated fixture with mixed event types', () => {
    const home = mkdtempSync(join(tmpdir(), 'codeburn-perf-test-'))
    try {
      const result = spawnSync(process.execPath, [join(repo, 'scripts/perf/gen-fixture.mjs'), '--home', home, '--target-mb', '1'], {
        encoding: 'utf8',
      })
      expect(result.status, result.stderr).toBe(0)
      const marker = JSON.parse(readFileSync(join(home, '.codeburn-perf-fixture.json'), 'utf8'))
      expect(marker.kind).toBe('codeburn-perf-fixture')
      expect(marker.bytes).toBeGreaterThan(500_000)
      expect(existsSync(join(home, '.claude', 'projects'))).toBe(true)
      expect(existsSync(join(home, '.codex', 'sessions'))).toBe(true)
      expect(JSON.stringify(marker)).not.toMatch(/Users\/a\/(?:\.codex|Documents)/)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 30_000)
})
