// Host privacy key (decision D1). A random 32-byte key, generated once and
// persisted in the codeburn config dir alongside config.json, that scopes every
// resource fingerprint. Keeping it stable across runs makes resourceIds stable
// (so the same file always fingerprints the same way); regenerating it would
// scramble them. The key is NEVER printed and NEVER leaves the host — only the
// HMAC fingerprints it produces cross into any payload.
//
// Read synchronously (and cached) because the optimize detectors that need it
// are synchronous. This mirrors config.ts's storage location while staying on
// the sync fs API those detectors require.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'

import { getConfigDir } from './config.js'

const KEY_FILE = 'privacy-key'
const KEY_HEX = /^[0-9a-f]{64}$/

let cached: string | undefined

function keyPath(): string {
  return join(getConfigDir(), KEY_FILE)
}

/**
 * Return the host privacy key, generating and persisting one on first use.
 * Falls back to an in-memory ephemeral key if the config dir is unwritable, so
 * a read-only environment still gets stable (per-process) fingerprints rather
 * than throwing.
 */
export function getHostPrivacyKey(): string {
  if (cached) return cached

  const path = keyPath()
  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, 'utf-8').trim()
      if (KEY_HEX.test(raw)) {
        cached = raw
        return cached
      }
    } catch {
      // fall through to regenerate
    }
  }

  const key = randomBytes(32).toString('hex')
  try {
    mkdirSync(getConfigDir(), { recursive: true })
    writeFileSync(path, key + '\n', { mode: 0o600 })
  } catch {
    // Config dir unwritable — keep the key in memory for this process only.
  }
  cached = key
  return cached
}
