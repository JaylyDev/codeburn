// Shared minimizing step: turn a rich decode's toolSequence (which carries raw
// file paths host-side) into fingerprinted ResourceRefs for the observation
// envelope. The RAW path is HMAC'd via resourceFingerprint and never emitted —
// only its 16-hex id and coarse class cross the boundary.

import { resourceFingerprint } from '../fingerprint.js'
import type { ResourceRef } from '../schema.js'
import { EDIT_TOOLS } from './claude/tool-vocab.js'

/** Whole-file read tools. Pattern tools (Grep/Glob) target no single file. */
const READ_RESOURCE_TOOLS = new Set(['Read', 'FileReadTool'])

/** One tool invocation as the rich decoders record it (tool name + optional file). */
export interface ToolSequenceEntry {
  tool: string
  file?: string
  command?: string
}

/**
 * Fingerprint the file paths in a call's toolSequence into resourceReads /
 * resourceEdits. Read-family reads become `resourceReads`; edit-family writes
 * become `resourceEdits`. Absent arrays are omitted so a call with no file
 * touches stays byte-identical to schema 0.1.0.
 */
export function extractResourceRefs(
  privacyKey: string,
  toolSequence: ToolSequenceEntry[][] | undefined,
): { resourceReads?: ResourceRef[]; resourceEdits?: ResourceRef[] } {
  if (!toolSequence) return {}
  const reads: ResourceRef[] = []
  const edits: ResourceRef[] = []
  for (const group of toolSequence) {
    for (const tc of group) {
      if (!tc.file) continue
      const fp = resourceFingerprint(privacyKey, tc.file)
      const ref: ResourceRef = { resourceId: fp.resourceId, resourceClass: fp.resourceClass }
      if (READ_RESOURCE_TOOLS.has(tc.tool)) reads.push(ref)
      else if (EDIT_TOOLS.has(tc.tool)) edits.push(ref)
    }
  }
  const out: { resourceReads?: ResourceRef[]; resourceEdits?: ResourceRef[] } = {}
  if (reads.length > 0) out.resourceReads = reads
  if (edits.length > 0) out.resourceEdits = edits
  return out
}
