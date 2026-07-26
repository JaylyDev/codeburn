// Pure, fingerprint-based detectors. Each consumes an ObservationEnvelope and
// emits Finding[] with zero fs/env/clock access — the detector-purity property
// the import-smoke guardrail enforces over this subpath.

import type { Detector } from '../contracts.js'

export * from './shared.js'
export * from './duplicate-reads.js'
export * from './junk-reads.js'
export * from './context-bloat.js'

import { duplicateReadsDetector } from './duplicate-reads.js'
import { junkReadsDetector } from './junk-reads.js'
import { contextBloatDetector } from './context-bloat.js'

/** All fingerprint-based detectors, in a stable order. */
export const detectors: readonly Detector[] = [
  junkReadsDetector,
  duplicateReadsDetector,
  contextBloatDetector,
]
