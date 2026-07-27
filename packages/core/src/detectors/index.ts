// Pure, fingerprint-based detectors. Each consumes an ObservationEnvelope and
// emits Finding[] with zero fs/env/clock access — the detector-purity property
// the import-smoke guardrail enforces over this subpath.
//
// Every detector evaluates one session at a time and emits at most one finding
// per session, each naming that session as its subject. Project-level rollups
// are a host concern: the host already knows each session's projectRef.

import type { Detector } from '../contracts.js'

export * from './shared.js'
export * from './duplicate-reads.js'
export * from './junk-reads.js'
export * from './low-context-before-edit.js'

import { duplicateReadsDetector } from './duplicate-reads.js'
import { junkReadsDetector } from './junk-reads.js'
import { lowContextBeforeEditDetector } from './low-context-before-edit.js'

/** All fingerprint-based detectors, in a stable order. */
export const detectors: readonly Detector[] = [
  junkReadsDetector,
  duplicateReadsDetector,
  lowContextBeforeEditDetector,
]
