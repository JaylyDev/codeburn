// Duplicate-reads detector: the same file read more than once within a single
// session loads its content into context again for no new information.
//
// Reproduces the host CLI's detectDuplicateReads: group whole-file reads by
// (session, file), exclude junk resources, and sum the extra reads (count - 1)
// per file. Flags at >= MIN_DUPLICATE_READS_TO_FLAG total extras.
//
// Identity semantics: files are keyed by resourceId (fingerprint of the
// normalised path) rather than the raw path, and sessions by sessionRef. Two raw
// paths that normalise to one fingerprint (e.g. a trailing slash, or a
// case-only difference on a Windows-style path) count as the SAME file here — on
// a POSIX corpus with canonical read paths this is a 1:1 relabelling, so counts
// match the legacy detector. Junk exclusion uses resourceClass (see junk-reads
// for how that differs from the legacy JUNK_DIRS regex at the edges).

import type { Detector, Finding } from '../contracts.js'
import { AVG_TOKENS_PER_READ, JUNK_RESOURCE_CLASSES, clamp01, forEachCall } from './shared.js'

export const DUPLICATE_READS_DETECTOR_ID = 'duplicate-reads'
export const DUPLICATE_READS_ALGORITHM_VERSION = '1.0.0'

const MIN_DUPLICATE_READS_TO_FLAG = 5
const DUPLICATE_READS_HIGH_THRESHOLD = 30

export const duplicateReadsDetector: Detector = (envelope): Finding[] => {
  // sessionRef -> resourceId -> read count.
  const perSession = new Map<string, Map<string, number>>()

  forEachCall(envelope, (call, session) => {
    for (const ref of call.resourceReads ?? []) {
      if (JUNK_RESOURCE_CLASSES.has(ref.resourceClass)) continue
      let files = perSession.get(session.sessionRef)
      if (!files) {
        files = new Map()
        perSession.set(session.sessionRef, files)
      }
      files.set(ref.resourceId, (files.get(ref.resourceId) ?? 0) + 1)
    }
  })

  let totalDuplicates = 0
  const dupRefs = new Set<string>()
  const dupSessions = new Set<string>()

  for (const [sessionRef, files] of perSession) {
    for (const [resourceId, count] of files) {
      if (count <= 1) continue
      totalDuplicates += count - 1
      dupRefs.add(resourceId)
      dupSessions.add(sessionRef)
    }
  }

  if (totalDuplicates < MIN_DUPLICATE_READS_TO_FLAG) return []

  const tokensSaved = totalDuplicates * AVG_TOKENS_PER_READ
  const score = clamp01(totalDuplicates / DUPLICATE_READS_HIGH_THRESHOLD)

  const finding: Finding = {
    detectorId: DUPLICATE_READS_DETECTOR_ID,
    algorithmVersion: DUPLICATE_READS_ALGORITHM_VERSION,
    confidence: {
      score,
      basis: `${totalDuplicates} redundant re-reads of ${dupRefs.size} file(s) across ${dupSessions.size} session(s); flags at >=${MIN_DUPLICATE_READS_TO_FLAG}`,
    },
    evidence: [
      { kind: 'duplicate-reads', count: totalDuplicates, refs: [...dupRefs], sessionRefs: [...dupSessions] },
      { kind: 'tokens-saved', count: tokensSaved },
    ],
  }
  return [finding]
}
