import { readdir, readFile } from 'fs/promises'
import { join } from 'path'

import { sanitize } from './session-message.js'
import type { SessionSource } from './types.js'

// OpenCode 1.1+ stores sessions as file-based JSON instead of a SQLite DB:
//   storage/session/<projectID>/<sessionID>.json   session metadata
//   storage/message/<sessionID>/<messageID>.json    one file per message
//   storage/part/<messageID>/<partID>.json          one file per part
// The message/part shape matches the SQLite layout, so the per-message build
// logic is shared via @codeburn/core/providers/opencode-session.

type SessionMeta = {
  id?: string
  directory?: string
  title?: string
  time?: { created?: number }
}

type FileMessageData = {
  id?: string
  role: string
  modelID?: string
  model?: string
  cost?: number
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  }
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
  time?: { created?: number }
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return null
  }
}

export async function discoverOpenCodeFileSessions(
  dataDir: string,
  providerName: string,
): Promise<SessionSource[]> {
  const sessionRoot = join(dataDir, 'storage', 'session')
  let projectDirs: string[]
  try {
    projectDirs = await readdir(sessionRoot)
  } catch {
    return []
  }

  const sources: SessionSource[] = []
  for (const project of projectDirs) {
    let files: string[]
    try {
      files = await readdir(join(sessionRoot, project))
    } catch {
      continue
    }
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      const path = join(sessionRoot, project, f)
      const meta = await readJson<SessionMeta>(path)
      if (!meta?.id) continue
      sources.push({
        path,
        project: sanitize(meta.directory || meta.title || ''),
        provider: providerName,
      })
    }
  }
  return sources
}

export async function readOpenCodeFileRecords(
  source: SessionSource,
  dataDir: string,
): Promise<unknown[] | null> {
  const meta = await readJson<SessionMeta>(source.path)
  if (!meta?.id) return null
  const sessionId = meta.id

  const messageDir = join(dataDir, 'storage', 'message', sessionId)
  let messageFiles: string[]
  try {
    messageFiles = await readdir(messageDir)
  } catch {
    return null
  }

  // Message-file JSON.parse stays host-side here (unlike the SQLite arm, where
  // core parses), because the message ids determine which part directories to
  // read: the parse is a precondition of the I/O, not a step after it.
  const messages: Array<{ id: string; data: FileMessageData }> = []
  for (const f of messageFiles) {
    if (!f.endsWith('.json')) continue
    const data = await readJson<FileMessageData>(join(messageDir, f))
    if (!data) continue
    messages.push({ id: data.id ?? f.replace(/\.json$/, ''), data })
  }

  // Part files are read eagerly for every message. The original read them lazily
  // only for messages that survived role and dedup checks; this is a strict
  // superset with identical output, changing only I/O volume.
  const partsRawByMessageId = new Map<string, string[]>()
  for (const { id } of messages) {
    const partDir = join(dataDir, 'storage', 'part', id)
    let files: string[]
    try {
      files = (await readdir(partDir)).sort()
    } catch {
      continue
    }
    const rawParts: string[] = []
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      try {
        rawParts.push(await readFile(join(partDir, f), 'utf8'))
      } catch {
        // skip unreadable part file
      }
    }
    partsRawByMessageId.set(id, rawParts)
  }

  return [{
    kind: 'file',
    sessionId,
    messages,
    partsRawByMessageId,
    metaTimeCreatedMs: meta.time?.created,
  }]
}
