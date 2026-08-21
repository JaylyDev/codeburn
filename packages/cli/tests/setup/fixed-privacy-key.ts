// Pins the host privacy key for tests that assert HMAC-derived literals.
//
// The bridge threads getHostPrivacyKey() into every rich decode, so dedup keys
// (sourceRefFingerprint, copilot's JetBrains per-turn HMAC) are derived from a
// RANDOM per-install key. Under tests/setup/env-isolation.ts HOME points at a
// fresh sandbox, so that key is minted at random on first use — which makes any
// golden that embeds a digest non-reproducible from one run to the next, and
// machine-dependent if HOME ever escaped the sandbox.
//
// Importing this module (side effect, before the first getHostPrivacyKey call)
// writes a FIXED key into the sandbox config dir, so the digests are constants
// a golden can pin. Import it FIRST in such a test file: ESM evaluates imports
// in declaration order, and privacy-key.ts memoizes the key on first read.
//
// Deliberately NOT an env-var override in src/: production has no reason to
// accept an externally supplied privacy key, and adding that knob would be a
// far worse hole than the goldens are worth.
import { createHmac } from 'node:crypto'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join, sep } from 'node:path'

import { normalizePath } from '@codeburn/core'

/** The pinned key every digest literal in the goldens is derived under. */
export const FIXED_PRIVACY_KEY = 'c0de6b12'.repeat(8)

// This module OVERWRITES <home>/.config/codeburn/privacy-key. That is harmless
// against the throwaway sandbox env-isolation.ts mints, and destructive against
// a real one: silently replacing a developer's key re-keys every resource
// fingerprint and orphans everything already synced — the exact failure
// privacy-key.ts refuses to cause on its own (it never overwrites a key file).
// So refuse unless HOME really is that sandbox. Its shape is the check: a
// mkdtemp dir under tmpdir() named `codeburn-test-env-*`. Run outside vitest —
// tsx, a stray node -e, a REPL — and this throws instead of eating the key.
const home = homedir()

// Resolve both sides before comparing. Without this the check is a string
// prefix test on an UNRESOLVED path, so a symlink at a sandbox-shaped location
// (HOME=/tmp/codeburn-test-env-x -> /Users/me) passes it and the write lands in
// the real home anyway. It also makes the honest case work on macOS, where
// tmpdir() is /var/folders/... and the mkdtemp dir resolves under /private/var.
// A path that cannot be resolved falls through as-is and gets refused below.
const resolve = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}
const realHome = resolve(home)
if (!realHome.startsWith(resolve(tmpdir()) + sep) || !basename(realHome).startsWith('codeburn-test-env-')) {
  throw new Error(
    `fixed-privacy-key.ts refuses to write into HOME=${home}: it overwrites ` +
    `<home>/.config/codeburn/privacy-key, and that is only safe against the ` +
    `throwaway sandbox tests/setup/env-isolation.ts mints (a ` +
    `codeburn-test-env-* dir under ${tmpdir()}). Import it only from a vitest ` +
    `test run under that setup file.`,
  )
}

const configDir = join(home, '.config', 'codeburn')
mkdirSync(configDir, { recursive: true })
writeFileSync(join(configDir, 'privacy-key'), FIXED_PRIVACY_KEY + '\n', { mode: 0o600 })

/**
 * The source-ref fingerprint a dedup key must contain, re-derived INDEPENDENTLY
 * of the function under test: HMAC-SHA256(FIXED_PRIVACY_KEY, "source:" +
 * normalized path), first 16 hex chars — core's fingerprint encoding written
 * out longhand. A golden that called `sourceRefFingerprint` instead would pin
 * nothing: it would compute the expected value with the same function, under
 * the same key, that production uses, so any change to either side would move
 * both together. This version fails if the domain tag, the key, or the
 * truncation ever change. `normalizePath` is reused deliberately — it is the
 * input spelling, not the fingerprint encoding, that it owns.
 */
export function expectedSourceRef(sourcePath: string): string {
  return createHmac('sha256', FIXED_PRIVACY_KEY)
    .update(`source:${normalizePath(sourcePath)}`)
    .digest('hex')
    .slice(0, 16)
}
