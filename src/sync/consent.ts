/**
 * codeburn sync - consent-once auto-sync with fingerprint and receipts.
 *
 * Manages acceptance fingerprints, disclosure building, and receipt tracking
 * for automatic scheduled pushes.
 */

import { createHash } from 'crypto'

export const WIRE_CONTRACT_VERSION = 'v2'

export interface FingerprintInput {
  org: string
  destination: string
  outboundFields: string[]
  workMatching: boolean
  scopeSinceDays: number | null
  cadence: 'daily' | 'hourly'
}

export function computeAcceptanceFingerprint(input: FingerprintInput): string {
  const canonical = {
    org: input.org,
    destination: input.destination,
    contractVersion: WIRE_CONTRACT_VERSION,
    outboundFields: [...input.outboundFields].sort(),
    workMatching: input.workMatching,
    scopeSinceDays: input.scopeSinceDays,
    cadence: input.cadence,
  }
  const json = JSON.stringify(canonical)
  return createHash('sha256').update(json).digest('hex')
}

export interface DisclosureInput {
  destination: string
  destinationUrl: string
  cadence: 'daily' | 'hourly'
  outboundFields: Array<{ key: string; disclosure: string }>
  workMatching: boolean
  scopeSinceDays: number | null
}

export function buildDisclosure(input: DisclosureInput): string {
  const cadenceText = input.cadence === 'daily' ? 'once per day' : 'once per hour'
  const scopeText = input.scopeSinceDays === null
    ? 'full history (up to 6 months)'
    : input.scopeSinceDays === 0
      ? 'today only'
      : `last ${input.scopeSinceDays} days`

  const fieldsList = input.outboundFields.length > 0
    ? input.outboundFields
      .map(f => `  ${f.key}: ${f.disclosure}`)
      .join('\n')
    : '  (no fields)'

  return [
    `Destination: ${input.destination}`,
    `URL: ${input.destinationUrl}`,
    `Cadence: ${cadenceText}`,
    `Scope: ${scopeText}`,
    '',
    'Data sent to the endpoint:',
    fieldsList,
    '',
    'Data that stays local:',
    '  raw prompts (never sent)',
    '  file paths (only project basename sent)',
    '  provider configuration files',
    '',
    'You can stop automatic sync at any time with: codeburn sync auto disable',
    'Any change to what would be sent requires your acceptance again before an automatic push runs.',
  ].join('\n')
}

export interface AcceptanceRecord {
  fingerprint: string
  acceptedAt: string
  cadence: 'daily' | 'hourly'
  disclosure: string
  attribution: boolean
}

export interface AutoSyncConfig {
  accepted?: AcceptanceRecord
  killed?: boolean
  lastRun?: {
    at: string
    result: string
  }
}

export type ReceiptResult =
  | { result: 'killed' }
  | { result: 'not-accepted' }
  | { result: 'acceptance-required'; changed: string[] }
  | { result: 'pushed'; spans: number }
  | { result: 'error'; reason: string }

export interface Receipt {
  at: string
  fingerprint?: string
  result: string
  [key: string]: unknown
}

export function buildReceipt(at: string, fingerprint: string | undefined, data: ReceiptResult): Receipt {
  return {
    at,
    ...(fingerprint && { fingerprint }),
    ...data,
  }
}
