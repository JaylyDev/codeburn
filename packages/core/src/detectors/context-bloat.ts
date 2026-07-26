// Context-bloat / read-to-edit-ratio detector: editing far more than reading
// leads to retries and wasted tokens. Reproduces the host CLI's
// detectLowReadEditRatio.
//
// Counting is by canonical tool name, NOT by resource ref: pattern search tools
// (Grep/Glob) count as reads even though they touch no single file, and an edit
// with no file target still counts as an edit. Each tool-use occurrence in a
// call's toolNames is one read or one edit (the two name sets are disjoint), so
// on the host's one-tool-per-call envelope this equals the legacy per-ToolCall
// tally, and generalises cleanly to a rich multi-tool call.
//
// Savings math mirrors the host: the tokens for the extra reads a healthy ratio
// would have required.

import type { Detector, Finding } from '../contracts.js'
import { AVG_TOKENS_PER_READ, EDIT_TOOL_NAMES, READ_TOOL_NAMES, clamp01, forEachCall } from './shared.js'

export const CONTEXT_BLOAT_DETECTOR_ID = 'context-bloat'
export const CONTEXT_BLOAT_ALGORITHM_VERSION = '1.0.0'

const MIN_EDITS_FOR_RATIO = 10
const HEALTHY_READ_EDIT_RATIO = 4

export const contextBloatDetector: Detector = (envelope): Finding[] => {
  let reads = 0
  let edits = 0
  const sessionRefs = new Set<string>()

  forEachCall(envelope, (call, session) => {
    let touched = false
    for (const name of call.toolNames) {
      if (READ_TOOL_NAMES.has(name)) { reads++; touched = true }
      else if (EDIT_TOOL_NAMES.has(name)) { edits++; touched = true }
    }
    if (touched) sessionRefs.add(session.sessionRef)
  })

  if (edits < MIN_EDITS_FOR_RATIO) return []
  const ratio = reads / edits
  if (ratio >= HEALTHY_READ_EDIT_RATIO) return []

  const extraReadsNeeded = Math.max(Math.round(edits * HEALTHY_READ_EDIT_RATIO) - reads, 0)
  const tokensSaved = extraReadsNeeded * AVG_TOKENS_PER_READ
  // Lower ratio (further below healthy) = stronger signal.
  const score = clamp01(1 - ratio / HEALTHY_READ_EDIT_RATIO)

  const finding: Finding = {
    detectorId: CONTEXT_BLOAT_DETECTOR_ID,
    algorithmVersion: CONTEXT_BLOAT_ALGORITHM_VERSION,
    confidence: {
      score,
      basis: `read-to-edit ratio ${ratio.toFixed(2)}:1 over ${reads} reads / ${edits} edits; healthy is >=${HEALTHY_READ_EDIT_RATIO}`,
    },
    evidence: [
      { kind: 'reads', count: reads, sessionRefs: [...sessionRefs] },
      { kind: 'edits', count: edits },
      { kind: 'tokens-saved', count: tokensSaved },
    ],
  }
  return [finding]
}
