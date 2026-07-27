import { join } from 'path'
import { homedir } from 'os'

import { decodeOpenCodeSession } from '@codeburn/core/providers/opencode-session'
import type { OpenCodeSessionDecodedCall } from '@codeburn/core/providers/opencode-session'
import { getShortModelName } from '../models.js'
import { extractBashCommands } from '../bash-utils.js'
import { discoverSqliteSessions, readSqliteSessionRecords, type SqliteProviderConfig } from './sqlite-session-parser.js'
import { discoverOpenCodeFileSessions, readOpenCodeFileRecords } from './opencode-file-parser.js'
import { createBridgedProvider } from './bridge.js'
import type { Provider, ProbeRoot, SessionSource, ParsedProviderCall } from './types.js'

const toolNameMap: Record<string, string> = {
  bash: 'Bash',
  read: 'Read',
  edit: 'Edit',
  write: 'Write',
  glob: 'Glob',
  grep: 'Grep',
  task: 'Agent',
  fetch: 'WebFetch',
  search: 'WebSearch',
  todo: 'TodoWrite',
  skill: 'Skill',
  patch: 'Patch',
}

function getDataDir(dataDir?: string): string {
  // Test seam: createOpenCodeProvider(tmpDir) points at a base dir that still
  // gets the 'opencode' subdirectory appended, preserving existing fixtures
  // (tmpDir/opencode/opencode*.db and tmpDir/opencode/storage/...).
  if (dataDir) return join(dataDir, 'opencode')

  // Production override for OpenCode-compatible forks/renames (e.g. MiMoCode at
  // ~/.local/share/mimocode). This is the EXACT data directory — no 'opencode'
  // suffix — so a fork writing <dir>/<prefix>*.db or <dir>/storage/... is found
  // instead of silently yielding zero sessions. (issue #617)
  const override = process.env['OPENCODE_DATA_DIR']
  if (override) return override

  // Default: $XDG_DATA_HOME/opencode or ~/.local/share/opencode.
  const base = process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share')
  return join(base, 'opencode')
}

function getSqliteConfig(dataDir?: string): SqliteProviderConfig {
  return {
    providerName: 'opencode',
    displayName: 'OpenCode',
    dbDir: getDataDir(dataDir),
    // Truthy check (not `??`): an empty-string `OPENCODE_DB_PREFIX` must fall
    // back to 'opencode'. With `??`, '' survives as the prefix and
    // `discoverSqliteSessions` matches every '*.db' file (filename.startsWith('')
    // is always true), sweeping unrelated DBs into discovery. Aligns with
    // `OPENCODE_DATA_DIR`'s truthy handling above, and makes behavior identical
    // for unset vs empty — which matches the env fingerprint, since
    // `computeEnvFingerprint` collapses both to 'OPENCODE_DB_PREFIX='. (issue #617)
    dbFilePrefix: process.env['OPENCODE_DB_PREFIX'] || 'opencode',
  }
}

export function toOpenCodeProviderCall(rich: OpenCodeSessionDecodedCall): ParsedProviderCall {
  return {
    provider: rich.provider,
    model: rich.model,
    inputTokens: rich.inputTokens,
    outputTokens: rich.outputTokens,
    cacheCreationInputTokens: rich.cacheCreationInputTokens,
    cacheReadInputTokens: rich.cacheReadInputTokens,
    cachedInputTokens: rich.cachedInputTokens,
    reasoningTokens: rich.reasoningTokens,
    webSearchRequests: rich.webSearchRequests,
    costBasis: 'estimated',
    ...(rich.fallbackCostUSD !== undefined ? { fallbackCostUSD: rich.fallbackCostUSD } : {}),
    tools: rich.tools,
    bashCommands: rich.rawBashCommands.flatMap(c => extractBashCommands(c)),
    ...(rich.arm === 'session-level' ? {} : { skills: rich.skills, subagentTypes: rich.subagentTypes }),
    timestamp: rich.timestamp,
    speed: rich.speed,
    deduplicationKey: rich.deduplicationKey,
    userMessage: rich.userMessage,
    sessionId: rich.sessionId,
  }
}

export function createOpenCodeProvider(dataDir?: string): Provider {
  const sqliteConfig = getSqliteConfig(dataDir)
  const resolvedDataDir = getDataDir(dataDir)

  // Provider-instance-scoped handoff for the verbose-stderr counts and session
  // id. readRecords and decode are called synchronously in sequence inside one
  // parse() generator, so this is safe without ordering assumptions.
  let lastSqliteCounts: { messageCount: number; partCount: number } | undefined
  let lastSessionId: string | undefined

  return createBridgedProvider<OpenCodeSessionDecodedCall>({
    name: 'opencode',
    displayName: 'OpenCode',

    modelDisplayName(model: string): string {
      const stripped = model.replace(/^[^/]+\//, '')
      return getShortModelName(stripped)
    },

    toolDisplayName(rawTool: string): string {
      return toolNameMap[rawTool] ?? rawTool
    },

    // OpenCode migrated from file-based JSON (storage/session/*.json) to a
    // SQLite DB (opencode.db). After an in-place upgrade, legacy JSON files
    // remain on disk while all new data flows into the SQLite DB. Merge both
    // sources so migrated installs keep reporting legacy sessions AND pick up
    // current SQLite data. Dedup is handled per-message in createSessionParser
    // via seenKeys (keyed by `${provider}:${sessionId}:${messageId}`).
    // Both the legacy JSON store (storage/session/*.json) and the SQLite DB
    // (opencode*.db) live under this one data dir, resolved via OPENCODE_DATA_DIR
    // or XDG_DATA_HOME the same way discoverSessions does.
    async probeRoots(): Promise<ProbeRoot[]> {
      return [{ path: resolvedDataDir, label: 'data' }]
    },

    async discoverSessions(): Promise<SessionSource[]> {
      const fileSessions = await discoverOpenCodeFileSessions(resolvedDataDir, 'opencode')
      const sqliteSessions = await discoverSqliteSessions(sqliteConfig)
      return [...fileSessions, ...sqliteSessions]
    },

    async readRecords(source) {
      if (source.path.endsWith('.json')) {
        // Clear the SQLite handoff: the file arm has no verbose notice, and a
        // stale count from an earlier SQLite source would make decode() emit one
        // for a zero-yield file session.
        lastSqliteCounts = undefined
        lastSessionId = undefined
        return readOpenCodeFileRecords(source, resolvedDataDir)
      }
      const result = await readSqliteSessionRecords(source, sqliteConfig)
      if (result === null) return null
      const envelope = result.records[0] as { sessionId: string }
      lastSessionId = envelope.sessionId
      lastSqliteCounts = { messageCount: result.messageCount, partCount: result.partCount }
      return result.records
    },

    decode(input) {
      const { calls, diagnostics } = decodeOpenCodeSession(input)
      // The pre-migration decode printed one aggregate diagnostic per zero-yield
      // SQLite session under CODEBURN_VERBOSE. The bridge discards diagnostics, so
      // the notice is re-emitted here rather than silently dropped.
      if (calls.length === 0 && lastSqliteCounts && lastSqliteCounts.messageCount > 0
          && process.env['CODEBURN_VERBOSE'] === '1' && lastSessionId) {
        const parseFailCount = diagnostics.filter(d => d.code === 'malformed-json').length
        const roleSkipCount = diagnostics.filter(d => d.code === 'unknown-shape').length
        process.stderr.write(
          `codeburn: OpenCode session ${lastSessionId} has ${lastSqliteCounts.messageCount} messages ` +
          `(${parseFailCount} unparseable, ${roleSkipCount} non-user/assistant roles) ` +
          `but yielded 0 calls. Parts: ${lastSqliteCounts.partCount}.\n`
        )
      }
      return { calls }
    },

    toProviderCall: toOpenCodeProviderCall,
  })
}

export const opencode = createOpenCodeProvider()
