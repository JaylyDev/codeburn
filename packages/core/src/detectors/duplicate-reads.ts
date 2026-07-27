// Duplicate-reads detector: the same file read more than once within a single
// session loads its content into context again for no new information.
//
// Group whole-file reads by resourceId within ONE session, exclude junk
// resources, and sum the extra reads (count - 1) per file. Emits at most one
// finding per session, at >= MIN_DUPLICATE_READS_TO_FLAG total extras.
//
// Identity semantics: files are keyed by resourceId (fingerprint of the
// normalised path) rather than the raw path. Two raw paths that normalise to one
// fingerprint (a trailing slash, or a case-only difference on a Windows-style
// path) count as the SAME file here. Junk exclusion uses resourceClass (see
// junk-reads for how that differs from the legacy JUNK_DIRS regex at the edges).

import { FINDING_SCHEMA_VERSION, type Detector, type Finding } from '../contracts.js'
import {
  ASSUMED_TOKENS_PER_READ,
  FIXED_READ_TOKEN_METHOD_ID,
  FIXED_READ_TOKEN_METHOD_VERSION,
  JUNK_RESOURCE_CLASSES,
  clamp01,
  perSession,
} from './shared.js'

export const DUPLICATE_READS_DETECTOR_ID = 'duplicate-reads'
export const DUPLICATE_READS_ALGORITHM_VERSION = '2.0.0'

const MIN_DUPLICATE_READS_TO_FLAG = 5
const DUPLICATE_READS_HIGH_THRESHOLD = 30

export const duplicateReadsDetector: Detector = (envelope): Finding[] =>
  perSession(envelope, (session) => {
    const readsByResource = new Map<string, number>()

    for (const call of session.calls) {
      for (const ref of call.resourceReads ?? []) {
        if (JUNK_RESOURCE_CLASSES.has(ref.resourceClass)) continue
        readsByResource.set(ref.resourceId, (readsByResource.get(ref.resourceId) ?? 0) + 1)
      }
    }

    let totalDuplicates = 0
    const dupRefs: string[] = []
    for (const [resourceId, count] of readsByResource) {
      if (count <= 1) continue
      totalDuplicates += count - 1
      dupRefs.push(resourceId)
    }

    if (totalDuplicates < MIN_DUPLICATE_READS_TO_FLAG) return null

    const basis: Finding['confidence']['basis'] = ['threshold-only', 'count-strength']
    if (dupRefs.length > 1) basis.push('repeated-evidence')

    return {
      schemaVersion: FINDING_SCHEMA_VERSION,
      detector: {
        id: DUPLICATE_READS_DETECTOR_ID,
        algorithmVersion: DUPLICATE_READS_ALGORITHM_VERSION,
      },
      subject: { kind: 'session', ref: session.sessionRef },
      confidence: {
        score: clamp01(totalDuplicates / DUPLICATE_READS_HIGH_THRESHOLD),
        basis,
      },
      evidence: [
        {
          kind: 'duplicate-reads',
          count: totalDuplicates,
          refs: dupRefs,
          sessionRefs: [session.sessionRef],
        },
      ],
      // Re-reading a file it already had is work the session could have skipped,
      // so the tokens are genuinely avoidable — under the fixed-cost assumption,
      // which methodId names.
      estimate: {
        metric: 'avoidable-tokens',
        value: totalDuplicates * ASSUMED_TOKENS_PER_READ,
        unit: 'tokens',
        methodId: FIXED_READ_TOKEN_METHOD_ID,
        methodVersion: FIXED_READ_TOKEN_METHOD_VERSION,
        nonCash: true,
      },
    }
  })
