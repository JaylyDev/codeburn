// Large-line JSONL scanner for Claude transcripts.
//
// Claude session lines can be multi-KB (big tool blobs). Rather than JSON.parse
// the whole line into V8 strings, this scans the raw string/Buffer in place,
// extracting only the small set of fields the decode needs. Pure over the
// supplied line — no fs, no env, no clock, no pricing. Do NOT convert or
// re-buffer the input: Buffers and strings are scanned by index as given.

import { BASH_TOOLS, EDIT_TOOLS } from './tool-vocab.js'
import type { ApiUsageIteration, AssistantMessageContent, JournalEntry, ToolUseBlock } from './types.js'

export const LARGE_JSONL_LINE_BYTES = 32 * 1024

export const RAW_HEAD_BYTES = 2048

export const USER_TEXT_CAP = 2000
export const BASH_COMMAND_CAP = 2000
export const MAX_TOOL_BLOCKS = 500
export const MAX_ADDED_NAMES = 1000

type JsonValueBounds = {
  start: number
  end: number
  kind: 'string' | 'object' | 'array' | 'scalar'
}

type JsonIndexedSource = string | Buffer

type JsonSource = {
  readonly raw: JsonIndexedSource
  readonly length: number
  readonly slice: (start: number, end: number, maxChars?: number) => string
}

function isAsciiWhitespace(ch: number | undefined): boolean {
  return ch === 0x20 || ch === 0x0a || ch === 0x0d || ch === 0x09 || ch === 0x0b || ch === 0x0c
}

function isBufferWhitespaceAt(source: Buffer, index: number): boolean {
  const byte = source[index]
  if (isAsciiWhitespace(byte)) return true
  if (byte === undefined || byte < 0x80) return false

  let start = index
  while (start > 0) {
    const preceding = source[start]
    if (preceding === undefined || (preceding & 0xc0) !== 0x80) break
    start--
  }
  const first = source[start]
  if (first === undefined) return false
  let codePoint: number | undefined
  let byteLength = 0
  if (first >= 0xc2 && first <= 0xdf) {
    const second = source[start + 1]
    if (second === undefined || (second & 0xc0) !== 0x80) return false
    codePoint = ((first & 0x1f) << 6) | (second & 0x3f)
    byteLength = 2
  } else if (first >= 0xe0 && first <= 0xef) {
    const second = source[start + 1]
    const third = source[start + 2]
    if (second === undefined || third === undefined || (second & 0xc0) !== 0x80 || (third & 0xc0) !== 0x80) return false
    codePoint = ((first & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f)
    byteLength = 3
  } else if (first >= 0xf0 && first <= 0xf4) {
    const second = source[start + 1]
    const third = source[start + 2]
    const fourth = source[start + 3]
    if (second === undefined || third === undefined || fourth === undefined || (second & 0xc0) !== 0x80 || (third & 0xc0) !== 0x80 || (fourth & 0xc0) !== 0x80) {
      return false
    }
    codePoint = ((first & 0x07) << 18) | ((second & 0x3f) << 12) | ((third & 0x3f) << 6) | (fourth & 0x3f)
    byteLength = 4
  }
  if (codePoint === undefined || index >= start + byteLength) return false
  return codePoint === 0x00a0 || codePoint === 0x1680 || (codePoint >= 0x2000 && codePoint <= 0x200a) || codePoint === 0x2028 || codePoint === 0x2029 || codePoint === 0x202f || codePoint === 0x205f || codePoint === 0x3000 || codePoint === 0xfeff
}

function safeBufferSegmentEnd(source: Buffer, index: number): number {
  while (index > 0 && ((source[index] ?? 0) & 0xc0) === 0x80) index--
  return index
}

function createJsonSource(source: string | Buffer): JsonSource {
  if (typeof source === 'string') {
    return {
      raw: source,
      length: source.length,
      slice: (start, end, maxChars = Number.POSITIVE_INFINITY) => source.slice(start, Math.min(end, start + maxChars)),
    }
  }

  return {
    raw: source,
    length: source.length,
    slice: (start, end, maxChars = Number.POSITIVE_INFINITY) => {
      const cappedEnd = Number.isFinite(maxChars) ? safeBufferSegmentEnd(source, Math.min(end, start + maxChars * 4)) : end
      return source.subarray(start, cappedEnd).toString('utf-8').slice(0, maxChars)
    },
  }
}

function jsonCharCodeAt(source: JsonSource, index: number): number {
  return typeof source.raw === 'string' ? source.raw.charCodeAt(index) : source.raw[index] ?? Number.NaN
}

function skipJsonWhitespace(source: JsonSource, start: number, limit = source.length): number {
  if (typeof source.raw === 'string') {
    let i = start
    while (i < limit && /\s/.test(source.raw[i]!)) i++
    return i
  }
  let i = start
  while (i < limit && isBufferWhitespaceAt(source.raw, i)) i++
  return i
}

function findJsonStringEnd(source: JsonSource, start: number, limit = source.length): number {
  return typeof source.raw === 'string'
    ? findJsonStringEndString(source.raw, start, limit)
    : findJsonStringEndBuffer(source.raw, start, limit)
}

function findJsonContainerEnd(source: JsonSource, start: number, open: number, close: number, limit = source.length): number {
  return typeof source.raw === 'string'
    ? findJsonContainerEndString(source.raw, start, open, close, limit)
    : findJsonContainerEndBuffer(source.raw, start, open, close, limit)
}

function findObjectFieldValue(source: JsonSource, objectStart: number, objectEnd: number, field: string): JsonValueBounds | null {
  return typeof source.raw === 'string'
    ? findObjectFieldValueString(source.raw, objectStart, objectEnd, field)
    : findObjectFieldValueBuffer(source.raw, objectStart, objectEnd, field)
}

function findJsonValueBounds(source: JsonSource, start: number, limit = source.length): JsonValueBounds | null {
  return typeof source.raw === 'string'
    ? findJsonValueBoundsString(source.raw, start, limit)
    : findJsonValueBoundsBuffer(source.raw, start, limit)
}

function readJsonString(source: JsonSource, bounds: JsonValueBounds | null, cap = Number.POSITIVE_INFINITY): string | undefined {
  if (typeof source.raw === 'string') return readJsonStringString(source.raw, bounds, cap)
  return readJsonStringBuffer(source.raw, bounds, cap)
}

function readJsonNumberField(source: JsonSource, objectBounds: JsonValueBounds | null, field: string): number | undefined {
  if (!objectBounds || objectBounds.kind !== 'object') return undefined
  const bounds = findObjectFieldValue(source, objectBounds.start, objectBounds.end, field)
  if (!bounds) return undefined
  const value = Number(source.slice(bounds.start, bounds.end))
  return Number.isFinite(value) ? value : undefined
}

// The large-line parsers avoid JSON.parse on the whole (multi-KB) line, but the
// usage object itself is tiny; parse just that slice to recover advisor
// (/advisor) iterations, which the byte-scanner cannot cheaply extract. Without
// this, an advisor escalation on a large assistant turn would be dropped.
function extractAdvisorIterations(usageObjectJson: string): ApiUsageIteration[] | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(usageObjectJson)
  } catch {
    return undefined
  }
  const iterations = (parsed as { iterations?: unknown }).iterations
  if (!Array.isArray(iterations)) return undefined
  const advisor = iterations.filter(
    (it): it is ApiUsageIteration =>
      !!it && typeof it === 'object' && (it as { type?: unknown }).type === 'advisor_message',
  )
  return advisor.length > 0 ? advisor : undefined
}

function parseLargeUsage(source: JsonSource, usageBounds: JsonValueBounds | null) {
  const usage: AssistantMessageContent['usage'] = {
    input_tokens: readJsonNumberField(source, usageBounds, 'input_tokens') ?? 0,
    output_tokens: readJsonNumberField(source, usageBounds, 'output_tokens') ?? 0,
    cache_creation_input_tokens: readJsonNumberField(source, usageBounds, 'cache_creation_input_tokens'),
    cache_read_input_tokens: readJsonNumberField(source, usageBounds, 'cache_read_input_tokens'),
  }

  if (usageBounds?.kind === 'object') {
    const cacheCreation = findObjectFieldValue(source, usageBounds.start, usageBounds.end, 'cache_creation')
    const ephemeral5m = readJsonNumberField(source, cacheCreation, 'ephemeral_5m_input_tokens')
    const ephemeral1h = readJsonNumberField(source, cacheCreation, 'ephemeral_1h_input_tokens')
    if (ephemeral5m !== undefined || ephemeral1h !== undefined) {
      ;(usage as AssistantMessageContent['usage']).cache_creation = {
        ...(ephemeral5m !== undefined ? { ephemeral_5m_input_tokens: ephemeral5m } : {}),
        ...(ephemeral1h !== undefined ? { ephemeral_1h_input_tokens: ephemeral1h } : {}),
      }
    }

    const serverToolUse = findObjectFieldValue(source, usageBounds.start, usageBounds.end, 'server_tool_use')
    const webSearch = readJsonNumberField(source, serverToolUse, 'web_search_requests')
    const webFetch = readJsonNumberField(source, serverToolUse, 'web_fetch_requests')
    if (webSearch !== undefined || webFetch !== undefined) {
      ;(usage as AssistantMessageContent['usage']).server_tool_use = {
        ...(webSearch !== undefined ? { web_search_requests: webSearch } : {}),
        ...(webFetch !== undefined ? { web_fetch_requests: webFetch } : {}),
      }
    }

    const speed = readJsonString(source, findObjectFieldValue(source, usageBounds.start, usageBounds.end, 'speed'))
    if (speed === 'standard' || speed === 'fast') usage.speed = speed

    const advisor = extractAdvisorIterations(source.slice(usageBounds.start, usageBounds.end))
    if (advisor) usage.iterations = advisor
  }

  return usage
}

function extractLargeToolBlocks(source: JsonSource, contentBounds: JsonValueBounds | null): ToolUseBlock[] {
  if (!contentBounds || contentBounds.kind !== 'array') return []
  const tools: ToolUseBlock[] = []
  let i = contentBounds.start + 1
  while (i < contentBounds.end - 1 && tools.length < MAX_TOOL_BLOCKS) {
    i = skipJsonWhitespace(source, i, contentBounds.end)
    if (jsonCharCodeAt(source, i) === 0x2c) {
      i++
      continue
    }
    if (jsonCharCodeAt(source, i) !== 0x7b) {
      i++
      continue
    }
    const objectEnd = findJsonContainerEnd(source, i, 0x7b, 0x7d, contentBounds.end)
    if (objectEnd === -1) break
    const objectBounds = { start: i, end: objectEnd + 1, kind: 'object' as const }
    const blockType = readJsonString(source, findObjectFieldValue(source, objectBounds.start, objectBounds.end, 'type'))
    if (blockType === 'tool_use') {
      const name = readJsonString(source, findObjectFieldValue(source, objectBounds.start, objectBounds.end, 'name')) ?? ''
      const id = readJsonString(source, findObjectFieldValue(source, objectBounds.start, objectBounds.end, 'id')) ?? ''
      const inputBounds = findObjectFieldValue(source, objectBounds.start, objectBounds.end, 'input')
      const input: Record<string, unknown> = {}
      if (inputBounds?.kind === 'object') {
        if (name === 'Skill') {
          const skill = readJsonString(source, findObjectFieldValue(source, inputBounds.start, inputBounds.end, 'skill'), 200)
          const skillName = readJsonString(source, findObjectFieldValue(source, inputBounds.start, inputBounds.end, 'name'), 200)
          if (skill !== undefined) input['skill'] = skill
          if (skillName !== undefined) input['name'] = skillName
        } else if (name === 'Read' || name === 'FileReadTool' || EDIT_TOOLS.has(name)) {
          const filePath = readJsonString(source, findObjectFieldValue(source, inputBounds.start, inputBounds.end, 'file_path'), BASH_COMMAND_CAP)
          if (filePath !== undefined) input['file_path'] = filePath
        } else if (name === 'Agent' || name === 'Task') {
          const subagentType = readJsonString(source, findObjectFieldValue(source, inputBounds.start, inputBounds.end, 'subagent_type'), 200)
          if (subagentType !== undefined) input['subagent_type'] = subagentType
        } else if (BASH_TOOLS.has(name)) {
          const command = readJsonString(source, findObjectFieldValue(source, inputBounds.start, inputBounds.end, 'command'), BASH_COMMAND_CAP)
          if (command !== undefined) input['command'] = command
        }
      }
      tools.push({ type: 'tool_use', id, name, input })
    }
    i = objectEnd + 1
  }
  return tools
}

function extractLargeUserText(source: JsonSource, contentBounds: JsonValueBounds | null): string | undefined {
  if (!contentBounds) return undefined
  if (contentBounds.kind === 'string') return readJsonString(source, contentBounds, USER_TEXT_CAP)
  if (contentBounds.kind !== 'array') return undefined

  let text = ''
  let i = contentBounds.start + 1
  while (i < contentBounds.end - 1 && text.length < USER_TEXT_CAP) {
    i = skipJsonWhitespace(source, i, contentBounds.end)
    if (jsonCharCodeAt(source, i) === 0x2c) {
      i++
      continue
    }
    if (jsonCharCodeAt(source, i) !== 0x7b) {
      i++
      continue
    }
    const objectEnd = findJsonContainerEnd(source, i, 0x7b, 0x7d, contentBounds.end)
    if (objectEnd === -1) break
    const objectBounds = { start: i, end: objectEnd + 1, kind: 'object' as const }
    const type = readJsonString(source, findObjectFieldValue(source, objectBounds.start, objectBounds.end, 'type'))
    if (type === 'text' || type === 'input_text') {
      const part = readJsonString(
        source,
        findObjectFieldValue(source, objectBounds.start, objectBounds.end, 'text'),
        USER_TEXT_CAP - text.length,
      )
      if (part) text += (text ? ' ' : '') + part
    }
    i = objectEnd + 1
  }
  return text || undefined
}

function extractLargeAddedNames(source: JsonSource, attachmentBounds: JsonValueBounds | null): string[] {
  if (!attachmentBounds || attachmentBounds.kind !== 'object') return []
  const attachmentType = readJsonString(source, findObjectFieldValue(source, attachmentBounds.start, attachmentBounds.end, 'type'))
  if (attachmentType !== 'deferred_tools_delta') return []
  const addedNames = findObjectFieldValue(source, attachmentBounds.start, attachmentBounds.end, 'addedNames')
  if (!addedNames || addedNames.kind !== 'array') return []
  const names: string[] = []
  let i = addedNames.start + 1
  while (i < addedNames.end - 1 && names.length < MAX_ADDED_NAMES) {
    i = skipJsonWhitespace(source, i, addedNames.end)
    if (jsonCharCodeAt(source, i) === 0x2c) {
      i++
      continue
    }
    if (jsonCharCodeAt(source, i) !== 0x22) {
      i++
      continue
    }
    const end = findJsonStringEnd(source, i, addedNames.end)
    if (end === -1) break
    const name = readJsonString(source, { start: i, end: end + 1, kind: 'string' }, 500)
    if (name) names.push(name)
    i = end + 1
  }
  return names
}

// Does the raw key bytes/chars at [keyStart, keyEnd) equal one of `fields`? This
// compares the RAW key (escapes and all), exactly as findObjectFieldValue did, so
// a key like "type" still does not match "type". Returns the matched field
// name so the caller can bucket the value.
function matchCapturedField(
  source: JsonSource,
  fieldBuffers: Buffer[] | null,
  keyStart: number,
  keyEnd: number,
  fields: readonly string[],
): string | null {
  if (fieldBuffers === null) {
    const key = (source.raw as string).slice(keyStart, keyEnd)
    return fields.includes(key) ? key : null
  }
  const raw = source.raw as Buffer
  const keyLength = keyEnd - keyStart
  for (let k = 0; k < fields.length; k++) {
    const fieldBuffer = fieldBuffers[k]!
    if (keyLength === fieldBuffer.length && raw.subarray(keyStart, keyEnd).equals(fieldBuffer)) return fields[k]!
  }
  return null
}

// Single pass over one JSON object, capturing the bounds of several top-level
// fields at once. This is the multi-field generalization of findObjectFieldValue:
// it reproduces that walk exactly — same whitespace/comma handling, same
// first-match-wins on duplicate keys, and the same "stop on a truncated key or an
// unparseable value" behavior that findObjectFieldValue expressed as `return null`
// — but visits each byte once instead of re-walking the object per field. On large
// Claude lines a multi-KB tool blob often precedes these keys, so a per-field walk
// re-scanned that blob once for every field it trailed.
function extractObjectFields(
  source: JsonSource,
  objectStart: number,
  objectEnd: number,
  fields: readonly string[],
): Record<string, JsonValueBounds | null> {
  const captured: Record<string, JsonValueBounds | null> = {}
  for (const field of fields) captured[field] = null
  if (jsonCharCodeAt(source, objectStart) !== 0x7b) return captured

  const fieldBuffers = typeof source.raw === 'string' ? null : fields.map((f) => Buffer.from(f))
  let remaining = fields.length
  let i = objectStart + 1
  while (i < objectEnd - 1 && remaining > 0) {
    i = skipJsonWhitespace(source, i, objectEnd)
    const ch = jsonCharCodeAt(source, i)
    if (ch === 0x2c) {
      i++
      continue
    }
    // Any non-'"' byte here is stray content between members; step over it and
    // resync on the next quote, exactly as the per-field walk did.
    if (ch !== 0x22) {
      i++
      continue
    }
    const keyEnd = findJsonStringEnd(source, i, objectEnd)
    if (keyEnd === -1) break // truncated key: findObjectFieldValue returned null here
    const keyStart = i + 1
    i = skipJsonWhitespace(source, keyEnd + 1, objectEnd)
    if (jsonCharCodeAt(source, i) !== 0x3a) continue // missing ':' — resync on the next member
    const value = findJsonValueBounds(source, i + 1, objectEnd)
    if (!value) break // unparseable value: findObjectFieldValue returned null here
    const matched = matchCapturedField(source, fieldBuffers, keyStart, keyEnd, fields)
    if (matched !== null && captured[matched] === null) {
      captured[matched] = value // keep the first occurrence, like findObjectFieldValue
      remaining-- // once every field is found the rest of the object is dead weight
    }
    i = value.end
  }
  return captured
}

const LARGE_ROOT_FIELDS = ['type', 'timestamp', 'sessionId', 'cwd', 'gitBranch', 'attachment', 'message'] as const
const LARGE_ASSISTANT_MESSAGE_FIELDS = ['model', 'usage', 'id', 'content'] as const

export function parseLargeJsonl(line: string | Buffer): JournalEntry | null {
  const source = createJsonSource(line)
  const rootStart = skipJsonWhitespace(source, 0)
  const rootEnd = findJsonContainerEnd(source, rootStart, 0x7b, 0x7d)
  if (rootEnd === -1) return null
  const rootLimit = rootEnd + 1
  const root = extractObjectFields(source, rootStart, rootLimit, LARGE_ROOT_FIELDS)
  const type = readJsonString(source, root['type'])
  if (!type) return null

  const entry: JournalEntry = { type }
  const timestamp = readJsonString(source, root['timestamp'])
  const sessionId = readJsonString(source, root['sessionId'])
  const cwd = readJsonString(source, root['cwd'])
  const gitBranch = readJsonString(source, root['gitBranch'])
  if (timestamp !== undefined) entry.timestamp = timestamp
  if (sessionId !== undefined) entry.sessionId = sessionId
  if (cwd !== undefined) entry.cwd = cwd
  if (gitBranch !== undefined) entry.gitBranch = gitBranch
  const addedNames = extractLargeAddedNames(source, root['attachment'])
  if (addedNames.length > 0) {
    ;(entry as Record<string, unknown>)['attachment'] = { type: 'deferred_tools_delta', addedNames }
  }

  const message = root['message']
  if (type === 'user') {
    if (message?.kind === 'object') {
      const content = findObjectFieldValue(source, message.start, message.end, 'content')
      const text = extractLargeUserText(source, content)
      if (text !== undefined) entry.message = { role: 'user', content: text }
    }
    return entry
  }

  if (type !== 'assistant') return entry
  if (message?.kind !== 'object') return entry
  const messageFields = extractObjectFields(source, message.start, message.end, LARGE_ASSISTANT_MESSAGE_FIELDS)
  const model = readJsonString(source, messageFields['model'])
  const usageBounds = messageFields['usage']
  if (!model || usageBounds?.kind !== 'object') return entry
  const id = readJsonString(source, messageFields['id'])
  const contentBounds = messageFields['content']

  entry.message = {
    type: 'message',
    role: 'assistant',
    model,
    ...(id !== undefined ? { id } : {}),
    content: extractLargeToolBlocks(source, contentBounds),
    usage: parseLargeUsage(source, usageBounds),
  }

  return entry
}

function findJsonStringEndString(source: string, start: number, limit = source.length): number {
  for (let i = start + 1; i < limit; i++) {
    const ch = source.charCodeAt(i)
    if (ch === 0x5c) {
      i++
      continue
    }
    if (ch === 0x22) return i
  }
  return -1
}

function findJsonContainerEndString(source: string, start: number, open: number, close: number, limit = source.length): number {
  let depth = 0
  let inString = false
  for (let i = start; i < limit; i++) {
    const ch = source.charCodeAt(i)
    if (inString) {
      if (ch === 0x5c) {
        i++
      } else if (ch === 0x22) {
        inString = false
      }
      continue
    }
    if (ch === 0x22) {
      inString = true
    } else if (ch === open) {
      depth++
    } else if (ch === close) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function findJsonValueBoundsString(source: string, start: number, limit = source.length): JsonValueBounds | null {
  let i = start
  while (i < limit && /\s/.test(source[i]!)) i++
  if (i >= limit) return null
  const ch = source.charCodeAt(i)
  if (ch === 0x22) {
    const end = findJsonStringEndString(source, i, limit)
    return end === -1 ? null : { start: i, end: end + 1, kind: 'string' }
  }
  if (ch === 0x7b) {
    const end = findJsonContainerEndString(source, i, 0x7b, 0x7d, limit)
    return end === -1 ? null : { start: i, end: end + 1, kind: 'object' }
  }
  if (ch === 0x5b) {
    const end = findJsonContainerEndString(source, i, 0x5b, 0x5d, limit)
    return end === -1 ? null : { start: i, end: end + 1, kind: 'array' }
  }
  let end = i
  while (end < limit) {
    const c = source.charCodeAt(end)
    if (c === 0x2c || c === 0x7d || c === 0x5d || /\s/.test(source[end]!)) break
    end++
  }
  return { start: i, end, kind: 'scalar' }
}

function findJsonStringEndBuffer(source: Buffer, start: number, limit = source.length): number {
  for (let i = start + 1; i < limit; i++) {
    const ch = source[i]
    if (ch === 0x5c) {
      i++
      continue
    }
    if (ch === 0x22) return i
  }
  return -1
}

function findJsonContainerEndBuffer(source: Buffer, start: number, open: number, close: number, limit = source.length): number {
  let depth = 0
  let inString = false
  for (let i = start; i < limit; i++) {
    const ch = source[i]
    if (inString) {
      if (ch === 0x5c) {
        i++
      } else if (ch === 0x22) {
        inString = false
      }
      continue
    }
    if (ch === 0x22) {
      inString = true
    } else if (ch === open) {
      depth++
    } else if (ch === close) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function findJsonValueBoundsBuffer(source: Buffer, start: number, limit = source.length): JsonValueBounds | null {
  let i = start
  while (i < limit && isBufferWhitespaceAt(source, i)) i++
  if (i >= limit) return null
  const ch = source[i]
  if (ch === 0x22) {
    const end = findJsonStringEndBuffer(source, i, limit)
    return end === -1 ? null : { start: i, end: end + 1, kind: 'string' }
  }
  if (ch === 0x7b) {
    const end = findJsonContainerEndBuffer(source, i, 0x7b, 0x7d, limit)
    return end === -1 ? null : { start: i, end: end + 1, kind: 'object' }
  }
  if (ch === 0x5b) {
    const end = findJsonContainerEndBuffer(source, i, 0x5b, 0x5d, limit)
    return end === -1 ? null : { start: i, end: end + 1, kind: 'array' }
  }
  let end = i
  while (end < limit) {
    const c = source[end]
    if (c === 0x2c || c === 0x7d || c === 0x5d || isBufferWhitespaceAt(source, end)) break
    end++
  }
  return { start: i, end, kind: 'scalar' }
}

function findObjectFieldValueString(source: string, objectStart: number, objectEnd: number, field: string): JsonValueBounds | null {
  if (source.charCodeAt(objectStart) !== 0x7b) return null
  let i = objectStart + 1
  while (i < objectEnd - 1) {
    while (i < objectEnd && /\s/.test(source[i]!)) i++
    if (source.charCodeAt(i) === 0x2c) {
      i++
      continue
    }
    if (source.charCodeAt(i) !== 0x22) {
      i++
      continue
    }
    const keyEnd = findJsonStringEndString(source, i, objectEnd)
    if (keyEnd === -1) return null
    const keyStart = i + 1
    i = keyEnd + 1
    while (i < objectEnd && /\s/.test(source[i]!)) i++
    if (source.charCodeAt(i) !== 0x3a) continue
    const value = findJsonValueBoundsString(source, i + 1, objectEnd)
    if (!value) return null
    if (source.slice(keyStart, keyEnd) === field) return value
    i = value.end
  }
  return null
}

function findObjectFieldValueBuffer(source: Buffer, objectStart: number, objectEnd: number, field: string): JsonValueBounds | null {
  if (source[objectStart] !== 0x7b) return null
  let i = objectStart + 1
  while (i < objectEnd - 1) {
    while (i < objectEnd && isBufferWhitespaceAt(source, i)) i++
    if (source[i] === 0x2c) {
      i++
      continue
    }
    if (source[i] !== 0x22) {
      i++
      continue
    }
    const keyEnd = findJsonStringEndBuffer(source, i, objectEnd)
    if (keyEnd === -1) return null
    const keyStart = i + 1
    i = keyEnd + 1
    while (i < objectEnd && isBufferWhitespaceAt(source, i)) i++
    if (source[i] !== 0x3a) continue
    const value = findJsonValueBoundsBuffer(source, i + 1, objectEnd)
    if (!value) return null
    if (keyEnd - keyStart === field.length && source.subarray(keyStart, keyEnd).equals(Buffer.from(field))) return value
    i = value.end
  }
  return null
}

function appendStringJsonSegment(source: string, start: number, end: number, current: string, cap: number): string {
  if (start >= end || current.length >= cap) return current
  return current + source.slice(start, Math.min(end, start + cap - current.length))
}

function appendBufferJsonSegment(source: Buffer, start: number, end: number, current: string, cap: number): string {
  if (start >= end || current.length >= cap) return current
  const remaining = cap - current.length
  const cappedEnd = Number.isFinite(cap) ? safeBufferSegmentEnd(source, Math.min(end, start + remaining * 4)) : end
  return current + source.subarray(start, cappedEnd).toString('utf-8').slice(0, remaining)
}

function readJsonStringString(source: string, bounds: JsonValueBounds | null, cap = Number.POSITIVE_INFINITY): string | undefined {
  if (!bounds || bounds.kind !== 'string') return undefined
  let out = ''
  const contentEnd = bounds.end - 1
  let segmentStart = bounds.start + 1
  let i = segmentStart
  let scanLimit = Number.isFinite(cap) ? Math.min(contentEnd, segmentStart + cap) : contentEnd
  while (i < contentEnd && out.length < cap) {
    if (i >= scanLimit) {
      out = appendStringJsonSegment(source, segmentStart, i, out, cap)
      if (out.length >= cap) break
      segmentStart = i
      scanLimit = Number.isFinite(cap) ? Math.min(contentEnd, i + cap - out.length) : contentEnd
      continue
    }
    const ch = source.charCodeAt(i)
    if (ch !== 0x5c) {
      i++
      continue
    }
    out = appendStringJsonSegment(source, segmentStart, i, out, cap)
    if (out.length >= cap) break
    i++
    const next = source.charCodeAt(i)
    if (Number.isNaN(next)) break
    if (next === 0x6e) out += '\n'
    else if (next === 0x72) out += '\r'
    else if (next === 0x74) out += '\t'
    else if (next === 0x62) out += '\b'
    else if (next === 0x66) out += '\f'
    else if (next === 0x75 && i + 4 < bounds.end) {
      const code = Number.parseInt(source.slice(i + 1, i + 5), 16)
      if (Number.isFinite(code)) out += String.fromCharCode(code)
      i += 4
    } else {
      out += String.fromCharCode(next)
    }
    segmentStart = i + 1
    i++
  }
  return appendStringJsonSegment(source, segmentStart, contentEnd, out, cap)
}

function readJsonStringBuffer(source: Buffer, bounds: JsonValueBounds | null, cap = Number.POSITIVE_INFINITY): string | undefined {
  if (!bounds || bounds.kind !== 'string') return undefined
  let out = ''
  const contentEnd = bounds.end - 1
  let segmentStart = bounds.start + 1
  let i = segmentStart
  let scanLimit = Number.isFinite(cap) ? Math.min(contentEnd, segmentStart + cap * 4) : contentEnd
  while (i < contentEnd && out.length < cap) {
    if (i >= scanLimit) {
      const segmentEnd = safeBufferSegmentEnd(source, i)
      out = appendBufferJsonSegment(source, segmentStart, segmentEnd, out, cap)
      if (out.length >= cap) break
      segmentStart = segmentEnd
      i = segmentEnd
      scanLimit = Number.isFinite(cap) ? Math.min(contentEnd, i + (cap - out.length) * 4) : contentEnd
      continue
    }
    const ch = source[i]
    if (ch !== 0x5c) {
      i++
      continue
    }
    out = appendBufferJsonSegment(source, segmentStart, i, out, cap)
    if (out.length >= cap) break
    i++
    const next = source[i]
    if (next === undefined) break
    if (next === 0x6e) out += '\n'
    else if (next === 0x72) out += '\r'
    else if (next === 0x74) out += '\t'
    else if (next === 0x62) out += '\b'
    else if (next === 0x66) out += '\f'
    else if (next === 0x75 && i + 4 < bounds.end) {
      const code = Number.parseInt(source.subarray(i + 1, i + 5).toString('ascii'), 16)
      if (Number.isFinite(code)) out += String.fromCharCode(code)
      i += 4
    } else {
      out += String.fromCharCode(next)
    }
    segmentStart = i + 1
    i++
  }
  return appendBufferJsonSegment(source, segmentStart, contentEnd, out, cap)
}

export function getTopLevelRawJsonStringField(head: string, field: string): string | null {
  let i = 0
  while (i < head.length && /\s/.test(head[i]!)) i++
  if (head.charCodeAt(i) !== 0x7b) return null
  i++
  while (i < head.length) {
    while (i < head.length && /\s/.test(head[i]!)) i++
    if (head.charCodeAt(i) === 0x2c) {
      i++
      continue
    }
    if (head.charCodeAt(i) === 0x7d) return null
    if (head.charCodeAt(i) !== 0x22) return null
    const keyEnd = findJsonStringEndString(head, i)
    if (keyEnd === -1) return null
    const key = head.slice(i + 1, keyEnd)
    i = keyEnd + 1
    while (i < head.length && /\s/.test(head[i]!)) i++
    if (head.charCodeAt(i) !== 0x3a) return null
    const value = findJsonValueBoundsString(head, i + 1)
    if (!value) return null
    if (key === field) return readJsonStringString(head, value) ?? null
    i = value.end
  }
  return null
}
