import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { readdir, readFile, stat } from 'fs/promises'
import { join, basename } from 'path'
import { homedir } from 'os'

import { decodeCursorAgent } from '@codeburn/core/providers/cursor-agent'
import type { ConversationSummaryRow, CursorAgentDecodedCall } from '@codeburn/core/providers/cursor-agent'

import { openDatabase, type SqliteDatabase } from '../sqlite.js'
import { createBridgedProvider } from './bridge.js'
import type { Provider, SessionSource, ParsedProviderCall } from './types.js'

const CONVERSATION_SUMMARY_QUERY = `
  SELECT conversationId, model, title, updatedAt
  FROM conversation_summaries
  WHERE conversationId = ?
`

const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DIGITS_ONLY = /^\d+$/

const modelDisplayNames: Record<string, string> = {
  'claude-4.5-opus-high-thinking': 'Opus 4.5 (Thinking)',
  'claude-4-opus': 'Opus 4',
  'claude-4-sonnet-thinking': 'Sonnet 4 (Thinking)',
  'claude-4.5-sonnet-thinking': 'Sonnet 4.5 (Thinking)',
  'claude-4.6-sonnet': 'Sonnet 4.6',
  'composer-1': 'Composer 1',
  'grok-code-fast-1': 'Grok Code Fast',
  'gemini-3-pro': 'Gemini 3 Pro',
  'gpt-5.1-codex-high': 'GPT-5.1 Codex',
  'gpt-5': 'GPT-5',
  'gpt-4.1': 'GPT-4.1',
  default: 'Auto (Sonnet est.)',
}

const warnedUnrecognizedTranscripts = new Set<string>()

function getCursorAgentBaseDir(baseDirOverride?: string): string {
  if (baseDirOverride) return baseDirOverride
  // Windows paths unverified; tracked as Open Question 3 in issue #55.
  return join(homedir(), '.cursor')
}

function getProjectsDir(baseDir: string): string {
  return join(baseDir, 'projects')
}

function getAttributionDbPath(baseDir: string): string {
  return join(baseDir, 'ai-tracking', 'ai-code-tracking.db')
}

function prettifyProjectId(raw: string): string {
  if (!raw) return raw

  if (DIGITS_ONLY.test(raw)) {
    const num = Number(raw)
    if (!Number.isNaN(num) && raw.length >= 13) {
      const iso = new Date(num).toISOString()
      return `cursor-agent:${iso}`
    }
  }

  const withoutPrefix = raw.replace(/^-Users-/, '')
  const parts = withoutPrefix.split('-').filter(Boolean)
  if (parts.length > 0) return parts[parts.length - 1]!

  return raw
}

function transcriptStem(transcriptPath: string): string {
  const name = basename(transcriptPath)
  if (name.endsWith('.jsonl')) return name.slice(0, -'.jsonl'.length)
  if (name.endsWith('.txt')) return name.slice(0, -'.txt'.length)
  return name
}

function toConversationId(transcriptPath: string): string {
  const filename = transcriptStem(transcriptPath)
  if (filename.length === 36 && UUID_LIKE.test(filename)) return filename
  return createHash('sha1').update(transcriptPath).digest('hex').slice(0, 16)
}

async function appendTranscriptSources(
  scanDir: string,
  projectId: string,
  sources: SessionSource[],
): Promise<void> {
  const transcriptEntries = await readdir(scanDir, { withFileTypes: true })
  for (const transcript of transcriptEntries) {
    // Legacy format: .txt files directly in the scan dir
    if (transcript.isFile() && transcript.name.endsWith('.txt')) {
      sources.push({
        path: join(scanDir, transcript.name),
        project: projectId,
        provider: 'cursor-agent',
      })
      continue
    }

    // Composer 2 format: UUID subdirectories with .jsonl files
    if (transcript.isDirectory() && UUID_LIKE.test(transcript.name)) {
      const subdir = join(scanDir, transcript.name)
      const subEntries = await readdir(subdir, { withFileTypes: true }).catch(() => [])
      const transcriptFilesByStem = new Map<string, { jsonl?: string; txt?: string }>()

      for (const sub of subEntries) {
        if (sub.isFile() && (sub.name.endsWith('.jsonl') || sub.name.endsWith('.txt'))) {
          const stem = transcriptStem(sub.name)
          const existing = transcriptFilesByStem.get(stem) ?? {}
          if (sub.name.endsWith('.jsonl')) {
            transcriptFilesByStem.set(stem, { ...existing, jsonl: sub.name })
          } else {
            transcriptFilesByStem.set(stem, { ...existing, txt: sub.name })
          }
          continue
        }

        // Subagent transcripts inside a subagents/ directory
        if (sub.isDirectory() && sub.name === 'subagents') {
          const subagentEntries = await readdir(join(subdir, sub.name), { withFileTypes: true }).catch(() => [])
          for (const sa of subagentEntries) {
            if (!sa.isFile()) continue
            if (!sa.name.endsWith('.jsonl') && !sa.name.endsWith('.txt')) continue
            sources.push({
              path: join(subdir, sub.name, sa.name),
              project: projectId,
              provider: 'cursor-agent',
            })
          }
        }
      }

      for (const files of transcriptFilesByStem.values()) {
        const selectedName = files.jsonl ?? files.txt
        if (selectedName) {
          sources.push({
            path: join(subdir, selectedName),
            project: projectId,
            provider: 'cursor-agent',
          })
        }
      }
    }
  }
}

// Map one rich, cost-free decoder call into the host's ParsedProviderCall. Cost
// re-enters here: `costBasis: 'estimated'` marks the call so the parser.ts
// pricing pass fills `costUSD` from the token buckets. Cursor Agent transcripts
// never carry shell commands, so `bashCommands` is always empty.
function toProviderCall(rich: CursorAgentDecodedCall): ParsedProviderCall {
  return {
    provider: 'cursor-agent',
    model: rich.model,
    inputTokens: rich.inputTokens,
    outputTokens: rich.outputTokens,
    cacheCreationInputTokens: rich.cacheCreationInputTokens,
    cacheReadInputTokens: rich.cacheReadInputTokens,
    cachedInputTokens: rich.cachedInputTokens,
    reasoningTokens: rich.reasoningTokens,
    webSearchRequests: rich.webSearchRequests,
    costBasis: 'estimated',
    tools: rich.tools,
    bashCommands: [],
    timestamp: rich.timestamp,
    speed: rich.speed,
    deduplicationKey: rich.deduplicationKey,
    userMessage: rich.userMessage,
    sessionId: rich.sessionId,
  }
}

export function createCursorAgentProvider(baseDirOverride?: string): Provider {
  const baseDir = getCursorAgentBaseDir(baseDirOverride)
  const projectsDir = getProjectsDir(baseDir)
  const dbPath = getAttributionDbPath(baseDir)
  const summariesByConversationId = new Map<string, ConversationSummaryRow>()

  return createBridgedProvider<CursorAgentDecodedCall>({
    name: 'cursor-agent',
    displayName: 'Cursor Agent',

    modelDisplayName(model: string): string {
      if (model === 'cursor-agent-auto') return 'Cursor (auto)'
      const label = modelDisplayNames[model] ?? model
      return `${label} (est.)`
    },

    toolDisplayName(rawTool: string): string {
      return rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      if (!existsSync(projectsDir)) return []

      const projectEntries = await readdir(projectsDir, { withFileTypes: true })
      const sources: SessionSource[] = []

      for (const entry of projectEntries) {
        if (!entry.isDirectory()) continue

        const projectId = prettifyProjectId(entry.name)
        const projectDir = join(projectsDir, entry.name)
        if (entry.name === 'agent-transcripts') {
          await appendTranscriptSources(projectDir, projectId, sources)
          continue
        }

        const transcriptDir = join(projectDir, 'agent-transcripts')
        if (!existsSync(transcriptDir)) continue
        await appendTranscriptSources(transcriptDir, projectId, sources)
      }

      return sources
    },

    // I/O adapter: open the sqlite database host-side, read the conversation
    // summary (cached per conversation id, as the pre-migration parser did),
    // read the transcript file, and return the plain record objects for the
    // core decoder.
    async readRecords(source: SessionSource): Promise<unknown[] | null> {
      const conversationId = toConversationId(source.path)

      let summary = summariesByConversationId.get(conversationId)
      let db: SqliteDatabase | null = null

      try {
        if (!summary && existsSync(dbPath)) {
          try {
            db = openDatabase(dbPath)
            const rows = db.query<{
              conversationId: string
              model: string | null
              title: string | null
              updatedAt: string | number | null
            }>(CONVERSATION_SUMMARY_QUERY, [conversationId])

            if (rows.length > 0) {
              const row = rows[0]!
              summary = {
                conversationId: row.conversationId,
                model: row.model,
                title: row.title,
                updatedAt: typeof row.updatedAt === 'number'
                  ? new Date(row.updatedAt < 1e12 ? row.updatedAt * 1000 : row.updatedAt).toISOString()
                  : (row.updatedAt ?? null),
              }
              summariesByConversationId.set(conversationId, summary)
            }
          } catch {
            summary = undefined
          }
        }
      } finally {
        db?.close()
      }

      const transcript = await readFile(source.path, 'utf-8')
      const fileStat = await stat(source.path)

      return [{
        summary: summary ?? null,
        transcript,
        transcriptPath: source.path,
        fileMtime: fileStat.mtime.toISOString(),
        conversationId,
      }]
    },

    // The core decoder reports a transcript that parsed to nothing recognizable
    // as a record diagnostic, which the bridge discards. The pre-migration
    // decode printed one warning per such transcript path, so that notice is
    // re-emitted here rather than silently dropped.
    decode(input) {
      const { calls, diagnostics } = decodeCursorAgent(input)
      if (diagnostics.length > 0) {
        const path = input.context.sourceRef
        if (!warnedUnrecognizedTranscripts.has(path)) {
          warnedUnrecognizedTranscripts.add(path)
          process.stderr.write(`codeburn: skipped ${basename(path)}: unrecognized cursor-agent transcript format\n`)
        }
      }
      return { calls }
    },
    toProviderCall,
  })
}

export const cursor_agent = createCursorAgentProvider()
