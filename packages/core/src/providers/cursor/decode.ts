// @codeburn/core Cursor decoder: pure decode over the five row sets the host
// hands it. No fs / env / clock / sqlite / pricing / strip-ansi.

import type { DecodeContext } from '../../contracts.js'
import type { RecordDiagnostic } from '../../diagnostics.js'
import type {
  CursorAgentKvRow,
  CursorAgentStream,
  CursorBubbleRow,
  CursorComposerMeta,
  CursorComposerMetaRow,
  CursorComposerScan,
  CursorDecodedCall,
  CursorInputSource,
  CursorUserMessageRow,
  CursorUserMessageQueue,
} from './types.js'

export type CursorDecodeInput = {
  bubbles: CursorBubbleRow[]
  agentKvRows: CursorAgentKvRow[]
  userMessageRows: CursorUserMessageRow[]
  composerMetaRows: CursorComposerMetaRow[]
  /** Host-supplied last-write time for agentKv-only sessions (DB mtime). */
  agentKvTimestamp: string
  context: DecodeContext
  /** Live dedup set the host mutates in place (the parser's fresh localSeen). */
  seenKeys?: Set<string>
}

export type CursorDecodeResult = {
  calls: CursorDecodedCall[]
  diagnostics: RecordDiagnostic[]
  /** Count behind the host's "skipped N unreadable Cursor entries" line. */
  skippedRecords: number
}

const CHARS_PER_TOKEN = 4

function estimateTokens(chars: number): number {
  if (chars <= 0) return 0
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

// Clone of packages/cli/src/sqlite.ts:35-39 so the decoder can decode BLOB
// columns non-fatally without importing host-side sqlite code.
const textDecoder = new TextDecoder('utf-8', { fatal: false })
function blobToText(value: Uint8Array | string | null | undefined): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  return textDecoder.decode(value)
}

/// Pulls the composer id out of a `bubbleId:<composerId>:<bubbleUuid>` key.
/// Returns null when the composer segment contains a CR/LF, which is the
/// signature Cursor uses for tool-call sub-composer rows in real data —
/// e.g. `bubbleId:task-call_xxxx\nfc_yyyy:<bubbleUuid>` is one key with a
/// literal newline between the `task-call_` and `fc_` halves. Those rows
/// are not standalone composers and would otherwise inflate the orphan
/// project's session count.
export function parseComposerIdFromKey(key: string | undefined): string | null {
  if (!key) return null
  const firstColon = key.indexOf(':')
  if (firstColon < 0) return null
  const secondColon = key.indexOf(':', firstColon + 1)
  if (secondColon < 0) return null
  const candidate = key.slice(firstColon + 1, secondColon)
  if (!candidate) return null
  // Reject any multi-line / control-char composer id. Real composer ids
  // (UUIDs) and synthetic fixture ids are both single-line.
  if (/[\r\n\x00]/.test(candidate)) return null
  return candidate
}

type CodeBlock = { languageId?: string }

export function extractLanguages(codeBlocksJson: string | null): string[] {
  if (!codeBlocksJson) return []
  try {
    const blocks = JSON.parse(codeBlocksJson) as CodeBlock[]
    if (!Array.isArray(blocks)) return []
    const langs = new Set<string>()
    for (const block of blocks) {
      if (block.languageId && block.languageId !== 'plaintext') {
        langs.add(block.languageId)
      }
    }
    return [...langs]
  } catch {
    return []
  }
}

function modelForDisplay(raw: string | null): string {
  if (!raw || raw === 'default') return 'cursor-auto'
  return raw
}

function buildUserMessageMap(rows: CursorUserMessageRow[]): Map<string, CursorUserMessageQueue> {
  const map = new Map<string, CursorUserMessageQueue>()
  for (const row of rows) {
    // Extract the composerId from the bubble key, matching the bubble arms.
    // The JSON `conversationId` field is empty in current Cursor builds.
    const composerId = parseComposerIdFromKey(row.bubble_key)
    // Guard on the RAW field: empty TEXT ('') is falsy and is skipped; empty
    // BLOB (new Uint8Array(0)) is truthy and is kept, decoding to ''.
    if (!composerId || !row.text) continue
    const text = blobToText(row.text)
    const existing = map.get(composerId)
    if (existing) {
      existing.messages.push(text)
    } else {
      map.set(composerId, { messages: [text], pos: 0 })
    }
  }
  return map
}

function takeUserMessage(queues: Map<string, CursorUserMessageQueue>, conversationId: string): string {
  const queue = queues.get(conversationId)
  if (!queue || queue.pos >= queue.messages.length) return ''
  const msg = queue.messages[queue.pos]
  queue.pos += 1
  return msg
}

function loadComposerMeta(rows: CursorComposerMetaRow[]): Map<string, CursorComposerMeta> {
  const map = new Map<string, CursorComposerMeta>()
  for (const r of rows) {
    // `||` rather than `??`: a recorded-but-zero breakdown must fall through
    // to the context meter instead of shadowing it.
    const tokens = (r.used || r.ctx) ?? 0
    if (r.composer_id && tokens > 0) map.set(r.composer_id, { tokens, createdAt: r.created_at ?? null })
  }
  return map
}

function newAgentStream(): CursorAgentStream {
  return { tools: [], bash: [], userChars: 0, contextChars: 0, assistantChars: 0, model: null }
}

// agentKv rows store content as a plain string or a block array; count only
// the text inside blocks so the JSON envelope and non-text parts are not
// billed as prompt characters.
export function contentTextLength(raw: string): number {
  const trimmed = raw.trimStart()
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      const blocks = Array.isArray(parsed) ? parsed : [parsed]
      let len = 0
      for (const block of blocks) {
        if (block == null || typeof block !== 'object') continue
        const b = block as { text?: unknown; content?: unknown }
        if (typeof b.text === 'string') len += b.text.length
        else if (typeof b.content === 'string') len += b.content.length
      }
      return len
    } catch {
      return raw.length
    }
  }
  return raw.length
}

// Cursor logs the agent's stream (prompt, injected context, tool calls, reply
// deltas) in agentKv blobs keyed by requestId. Bubbles carry the same
// requestId, so the map built from the scanned bubbles joins each request to
// its conversation. Requests with no matching bubble are kept separately:
// they are real sessions (background runs, older builds) that would otherwise
// vanish from totals.
function loadAgentStreams(
  rows: CursorAgentKvRow[],
  requestToComposer: Map<string, string>,
): { byComposer: Map<string, CursorAgentStream>; unjoined: Map<string, CursorAgentStream> } {
  const byComposer = new Map<string, CursorAgentStream>()
  const unjoined = new Map<string, CursorAgentStream>()

  const bucketFor = (requestId: string): CursorAgentStream => {
    const composer = requestToComposer.get(requestId)
    const map = composer ? byComposer : unjoined
    const key = composer ?? requestId
    const existing = map.get(key)
    if (existing) return existing
    const fresh = newAgentStream()
    map.set(key, fresh)
    return fresh
  }

  // Only the turn-opening (user) agentKv row carries the requestId; rows that
  // follow inherit it. Rows written BEFORE their request's id appears (the
  // system prompt and opening user prompt at a conversation start) buffer
  // until the next id, and a system row closes the previous request so
  // interleaved sessions cannot inherit across a conversation boundary.
  let currentRequestId: string | null = null
  let pendingUserChars = 0
  let pendingContextChars = 0
  for (const row of rows) {
    if (row.request_id) {
      currentRequestId = row.request_id
      if (pendingUserChars > 0 || pendingContextChars > 0) {
        const bucket = bucketFor(currentRequestId)
        bucket.userChars += pendingUserChars
        bucket.contextChars += pendingContextChars
        pendingUserChars = 0
        pendingContextChars = 0
      }
    }
    if (row.model && currentRequestId) {
      const bucket = bucketFor(currentRequestId)
      if (!bucket.model) bucket.model = row.model
    }
    // Guard on the RAW content field: empty TEXT is skipped; empty BLOB is kept.
    if (!row.content) continue

    if (row.role === 'system') {
      pendingContextChars += contentTextLength(blobToText(row.content))
      currentRequestId = null
      continue
    }
    if (row.role === 'user') {
      const len = contentTextLength(blobToText(row.content))
      if (currentRequestId) bucketFor(currentRequestId).userChars += len
      else pendingUserChars += len
      continue
    }
    if (row.role === 'tool') {
      if (currentRequestId) bucketFor(currentRequestId).contextChars += contentTextLength(blobToText(row.content))
      continue
    }
    if (row.role !== 'assistant' || !currentRequestId) continue

    let content: unknown
    try {
      content = JSON.parse(blobToText(row.content))
    } catch {
      continue
    }
    if (!Array.isArray(content)) continue
    const bucket = bucketFor(currentRequestId)
    for (const block of content as Array<{ type?: string; text?: unknown; toolName?: unknown; args?: { command?: unknown } }>) {
      if (block == null || typeof block !== 'object') continue
      if (typeof block.text === 'string') bucket.assistantChars += block.text.length
      if (block.type !== 'tool-call' || typeof block.toolName !== 'string' || !block.toolName) continue
      // Cursor's terminal tool is 'Shell'; emit the canonical 'Bash' so the
      // cross-provider tool and command breakdowns merge.
      bucket.tools.push(block.toolName === 'Shell' ? 'Bash' : block.toolName)
      if (block.toolName === 'Shell' && typeof block.args?.command === 'string') {
        // Store the raw command string; the host extracts base names with
        // strip-ansi so that dependency never enters core.
        bucket.bash.push(block.args.command)
      }
    }
  }
  return { byComposer, unjoined }
}

function inputSource(
  cid: string,
  scans: Map<string, CursorComposerScan>,
  composerMeta: Map<string, CursorComposerMeta>,
  agentStreams: Map<string, CursorAgentStream>,
): CursorInputSource {
  if (scans.get(cid)?.hasRealTokens) return 'bubbleTokens'
  if (composerMeta.has(cid)) return 'meter'
  const stream = agentStreams.get(cid)
  if ((stream?.userChars ?? 0) + (stream?.contextChars ?? 0) > 0) return 'stream'
  return 'text'
}

function buildScans(rows: CursorBubbleRow[]): {
  scans: Map<string, CursorComposerScan>
  requestToComposer: Map<string, string>
} {
  const scans = new Map<string, CursorComposerScan>()
  const requestToComposer = new Map<string, string>()
  for (const row of rows) {
    const cid = parseComposerIdFromKey(row.bubble_key)
    if (!cid) continue
    if (row.request_id) requestToComposer.set(row.request_id, cid)
    let scan = scans.get(cid)
    if (!scan) {
      scan = { hasRealTokens: false, firstBubbleTs: null, assistantTextChars: 0, model: null }
      scans.set(cid, scan)
    }
    if ((row.input_tokens ?? 0) > 0 || (row.output_tokens ?? 0) > 0) scan.hasRealTokens = true
    if (!scan.firstBubbleTs && row.created_at) scan.firstBubbleTs = row.created_at
    if (row.bubble_type !== 1) scan.assistantTextChars += row.text_length ?? 0
    if (!scan.model && row.model) scan.model = row.model
  }
  return { scans, requestToComposer }
}

export function decodeCursor(input: CursorDecodeInput): CursorDecodeResult {
  const { bubbles, agentKvRows, userMessageRows, composerMetaRows, agentKvTimestamp, seenKeys } = input
  const localSeen = seenKeys ?? new Set<string>()
  const results: CursorDecodedCall[] = []
  let skipped = 0

  const composerMeta = loadComposerMeta(composerMetaRows)
  const { scans, requestToComposer } = buildScans(bubbles)
  const { byComposer: agentStreams, unjoined } = loadAgentStreams(agentKvRows, requestToComposer)
  const userMessages = buildUserMessageMap(userMessageRows)
  const lastUserMsg = new Map<string, string>()

  const toolsAttached = new Set<string>()

  for (const row of bubbles) {
    try {
      const conversationId = parseComposerIdFromKey(row.bubble_key)
      if (!conversationId) {
        skipped++
        continue
      }
      const createdAt = row.created_at
      if (!createdAt) continue

      // Pair each user turn with its own prompt (even when the turn itself
      // emits nothing) so the assistant reply that follows classifies against
      // the right question.
      if (row.bubble_type === 1) {
        lastUserMsg.set(conversationId, takeUserMessage(userMessages, conversationId))
      }

      let inputTokens = row.input_tokens ?? 0
      let outputTokens = row.output_tokens ?? 0
      if (inputTokens === 0 && outputTokens === 0) {
        const textLen = row.text_length ?? 0
        if (row.bubble_type === 1) {
          // Conversation-level input (meter or stream) is emitted once after
          // this loop; per-bubble text only counts when it is the
          // conversation's best available signal.
          if (inputSource(conversationId, scans, composerMeta, agentStreams) === 'text' && textLen > 0) {
            inputTokens = estimateTokens(textLen)
          }
        } else {
          outputTokens = estimateTokens(textLen)
        }
        if (inputTokens === 0 && outputTokens === 0) continue
      }

      // Use the SQLite row key (bubbleId:<unique>) as the dedup key.
      // Cursor mutates token counts on the row in place when streaming
      // completes — including tokens in the dedup key (the previous
      // implementation) caused the same bubble to be counted twice once
      // its tokens stabilized.
      const dedupKey = `cursor:bubble:${row.bubble_key}`
      if (localSeen.has(dedupKey)) continue
      localSeen.add(dedupKey)

      // User bubbles (type=1) carry no modelInfo, so fall back to the
      // conversation's model seen on its assistant bubbles or agent stream.
      const effectiveModel = row.model ?? scans.get(conversationId)?.model ?? agentStreams.get(conversationId)?.model ?? null

      const userQuestion = lastUserMsg.get(conversationId) ?? ''
      const assistantText = blobToText(row.user_text)
      const userText = (userQuestion + ' ' + assistantText).trim()

      const languages = extractLanguages(blobToText(row.code_blocks))
      const hasCode = languages.length > 0

      // Meter/stream conversations carry their agent tools on the synthetic
      // conversation record below; the rest attach them to their first
      // emitted call so they are counted exactly once.
      let agentTurn: CursorAgentStream | undefined
      const source = inputSource(conversationId, scans, composerMeta, agentStreams)
      if ((source === 'text' || source === 'bubbleTokens') && !toolsAttached.has(conversationId)) {
        agentTurn = agentStreams.get(conversationId)
        if (agentTurn) toolsAttached.add(conversationId)
      }

      results.push({
        provider: 'cursor',
        model: modelForDisplay(effectiveModel),
        rawModel: effectiveModel,
        inputTokens,
        outputTokens,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        webSearchRequests: 0,
        speed: 'standard',
        tools: [
          ...(hasCode ? ['cursor:edit', ...languages.map(l => `lang:${l}`)] : []),
          ...(agentTurn?.tools ?? []),
        ],
        rawBashCommands: agentTurn?.bash ?? [],
        timestamp: createdAt,
        deduplicationKey: dedupKey,
        userMessage: userText,
        sessionId: conversationId,
      })
    } catch {
      skipped++
    }
  }

  // One conversation-level input record per metered/stream conversation,
  // anchored to the conversation's own start (composerData.createdAt) so the
  // credited day never depends on the parse window or cache state, and keyed
  // by composerId so re-parses and daily-cache gap fills dedupe instead of
  // multiplying. The meter is the LATEST context size, not a per-turn sum;
  // growth after the anchor day is finalized stays uncounted, which keeps the
  // documented undercount-vs-admin-console tradeoff but never double counts.
  for (const [cid, scan] of scans) {
    const source = inputSource(cid, scans, composerMeta, agentStreams)
    if (source !== 'meter' && source !== 'stream') continue
    const stream = agentStreams.get(cid)
    const meta = composerMeta.get(cid)
    const inputTokens = source === 'meter'
      ? meta?.tokens ?? 0
      : estimateTokens((stream?.userChars ?? 0) + (stream?.contextChars ?? 0))
    // Reply text normally lives on assistant bubbles; count the stream's
    // reply deltas only when the bubbles carried none.
    const outputTokens = scan.assistantTextChars > 0 ? 0 : estimateTokens(stream?.assistantChars ?? 0)
    if (inputTokens === 0 && outputTokens === 0) continue

    const dedupKey = `cursor:composer-input:${cid}`
    if (localSeen.has(dedupKey)) continue
    localSeen.add(dedupKey)

    const createdAtMs = meta?.createdAt
    const timestamp = typeof createdAtMs === 'number' && createdAtMs > 0 ? new Date(createdAtMs).toISOString() : scan.firstBubbleTs
    if (!timestamp) continue

    const effectiveModel = scan.model ?? stream?.model ?? null
    results.push({
      provider: 'cursor',
      model: modelForDisplay(effectiveModel),
      rawModel: effectiveModel,
      inputTokens,
      outputTokens,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      speed: 'standard',
      tools: stream?.tools ?? [],
      rawBashCommands: stream?.bash ?? [],
      timestamp,
      deduplicationKey: dedupKey,
      userMessage: '',
      sessionId: cid,
    })
  }

  // Sessions recorded only in the agent stream (no bubble carries their
  // requestId). agentKv stores no timestamps, so these reuse the DB file's
  // mtime as a bounded "last write" time, like the pre-composer parser did.
  for (const [requestId, stream] of unjoined) {
    const inputTokens = estimateTokens(stream.userChars + stream.contextChars)
    const outputTokens = estimateTokens(stream.assistantChars)
    if (inputTokens === 0 && outputTokens === 0) continue

    const dedupKey = `cursor:agentKv:${requestId}`
    if (localSeen.has(dedupKey)) continue
    localSeen.add(dedupKey)

    results.push({
      provider: 'cursor',
      model: modelForDisplay(stream.model),
      rawModel: stream.model,
      inputTokens,
      outputTokens,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      speed: 'standard',
      tools: stream.tools,
      rawBashCommands: stream.bash,
      timestamp: agentKvTimestamp,
      deduplicationKey: dedupKey,
      userMessage: '',
      sessionId: requestId,
    })
  }

  return { calls: results, diagnostics: [], skippedRecords: skipped }
}
