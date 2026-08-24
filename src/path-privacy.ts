import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'

function normalizedPath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/\/+$/, '')
}

/** True when an absolute path identifies a user home root, not a project. */
export function isUserHomeRoot(value: string | undefined): boolean {
  if (!value) return false
  const normalized = normalizedPath(value)
  if (normalized.toLowerCase() === normalizedPath(homedir()).toLowerCase()) return true
  return /(?:^|\/)(?:users|home|profiles)\/[^/]+$/i.test(normalized)
    || normalized === '/root'
}

/** Absolute, non-home provider cwd eligible for outbound provenance. */
export function isTrustedAbsoluteWorkingDirectory(value: string | undefined): value is string {
  if (!value || isUserHomeRoot(value)) return false
  return posix.isAbsolute(value) || win32.isAbsolute(value)
}
