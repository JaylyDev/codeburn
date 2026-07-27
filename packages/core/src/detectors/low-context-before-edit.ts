// Low-context-before-edit detector: a session that edits far more than it reads
// is working with thin context, which correlates with retries and rework.
//
// RENAMED from `context-bloat`, which described the opposite of what it
// measures. "Bloat" implies too much context; the rule fires when there is too
// LITTLE — few reads per edit.
//
// It also no longer emits a token estimate. The old one computed the reads a
// healthy ratio WOULD have required and reported them as `tokens-saved`. Those
// reads never happened, and performing them would have ADDED tokens, not
// removed them. The number had the wrong sign and the wrong name: acting on the
// finding costs tokens up front in the hope of avoiding more later, and core
// cannot observe whether that trade paid off. Counts and the ratio are the
// honest output; whether to spend more context is the host's call.
//
// Counting is by canonical tool name, NOT by resource ref: pattern search tools
// (Grep/Glob) count as reads even though they touch no single file, and an edit
// with no file target still counts as an edit. Each tool-use occurrence in a
// call's toolNames is one read or one edit (the two name sets are disjoint).

import { FINDING_SCHEMA_VERSION, type Detector, type Finding } from '../contracts.js'
import { EDIT_TOOL_NAMES, READ_TOOL_NAMES, clamp01, perSession } from './shared.js'

export const LOW_CONTEXT_BEFORE_EDIT_DETECTOR_ID = 'low-context-before-edit'
export const LOW_CONTEXT_BEFORE_EDIT_ALGORITHM_VERSION = '2.0.0'

const MIN_EDITS_FOR_RATIO = 10
const HEALTHY_READ_EDIT_RATIO = 4

export const lowContextBeforeEditDetector: Detector = (envelope): Finding[] =>
  perSession(envelope, (session) => {
    let reads = 0
    let edits = 0

    for (const call of session.calls) {
      for (const name of call.toolNames) {
        if (READ_TOOL_NAMES.has(name)) reads++
        else if (EDIT_TOOL_NAMES.has(name)) edits++
      }
    }

    if (edits < MIN_EDITS_FOR_RATIO) return null
    const ratio = reads / edits
    if (ratio >= HEALTHY_READ_EDIT_RATIO) return null

    return {
      schemaVersion: FINDING_SCHEMA_VERSION,
      detector: {
        id: LOW_CONTEXT_BEFORE_EDIT_DETECTOR_ID,
        algorithmVersion: LOW_CONTEXT_BEFORE_EDIT_ALGORITHM_VERSION,
      },
      subject: { kind: 'session', ref: session.sessionRef },
      confidence: {
        // Further below the healthy ratio is a stronger signal.
        score: clamp01(1 - ratio / HEALTHY_READ_EDIT_RATIO),
        basis: ['threshold-only', 'count-strength'],
      },
      evidence: [
        { kind: 'reads', count: reads, sessionRefs: [session.sessionRef] },
        { kind: 'edits', count: edits },
        { kind: 'read-to-edit-ratio', value: ratio },
      ],
      // No `estimate` — see the header. Reads that did not happen cannot be
      // avoidable tokens.
    }
  })
