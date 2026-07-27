// Junk-reads detector: flags reads into dependency/build/vcs resources (the
// path-free redesign of the host CLI's JUNK_DIRS check).
//
// Identity semantics vs the legacy host detector: the CLI matched a raw-path
// regex over JUNK_DIRS. Here "junk" is resourceClass ∈ {dependency, build, vcs}
// (see JUNK_RESOURCE_CLASSES). classifyResource's segment tables are kept a
// STRICT SUPERSET of that regex: every directory the regex named is now a junk
// class — including the extras that used to map to 'other' and are folded in as
// of this phase: '__pycache__', 'coverage', '.cache', '.nuxt', '.output' (build),
// bare 'venv' (dependency), '.svn' and '.hg' (vcs). The class set ALSO catches
// vendor / site-packages / out / target, which the old regex missed — the
// intended superset improvement, so the redesign never flags FEWER reads than
// the legacy detector, only the same or (deliberately) more. The one legacy
// token not added is '.tsbuildinfo', which names a file (tsconfig.tsbuildinfo),
// never a directory segment, so `/.tsbuildinfo/` can match no real read path.
// Grouping is by resourceId, so two raw paths that normalise to one fingerprint
// count once.

import { FINDING_SCHEMA_VERSION, type Detector, type Finding } from '../contracts.js'
import {
  ASSUMED_TOKENS_PER_READ,
  FIXED_READ_TOKEN_METHOD_ID,
  FIXED_READ_TOKEN_METHOD_VERSION,
  JUNK_RESOURCE_CLASSES,
  clamp01,
  perSession,
} from './shared.js'

export const JUNK_READS_DETECTOR_ID = 'junk-reads'
export const JUNK_READS_ALGORITHM_VERSION = '2.0.0'

const MIN_JUNK_READS_TO_FLAG = 3
const JUNK_READS_HIGH_THRESHOLD = 20

export const junkReadsDetector: Detector = (envelope): Finding[] =>
  perSession(envelope, (session) => {
    let total = 0
    const junkRefs = new Set<string>()

    for (const call of session.calls) {
      for (const ref of call.resourceReads ?? []) {
        if (!JUNK_RESOURCE_CLASSES.has(ref.resourceClass)) continue
        total++
        junkRefs.add(ref.resourceId)
      }
    }

    if (total < MIN_JUNK_READS_TO_FLAG) return null

    const basis: Finding['confidence']['basis'] = ['threshold-only', 'count-strength']
    if (junkRefs.size > 1) basis.push('repeated-evidence')

    return {
      schemaVersion: FINDING_SCHEMA_VERSION,
      detector: {
        id: JUNK_READS_DETECTOR_ID,
        algorithmVersion: JUNK_READS_ALGORITHM_VERSION,
      },
      subject: { kind: 'session', ref: session.sessionRef },
      confidence: {
        score: clamp01(total / JUNK_READS_HIGH_THRESHOLD),
        basis,
      },
      evidence: [
        {
          kind: 'junk-reads',
          count: total,
          refs: [...junkRefs],
          sessionRefs: [session.sessionRef],
        },
      ],
      // A read into node_modules/dist/.git is work the session did not need, so
      // the tokens are avoidable under the fixed-cost assumption.
      estimate: {
        metric: 'avoidable-tokens',
        value: total * ASSUMED_TOKENS_PER_READ,
        unit: 'tokens',
        methodId: FIXED_READ_TOKEN_METHOD_ID,
        methodVersion: FIXED_READ_TOKEN_METHOD_VERSION,
        nonCash: true,
      },
    }
  })
