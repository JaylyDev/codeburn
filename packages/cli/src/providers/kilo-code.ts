import { join } from 'path'
import { homedir } from 'os'

import { decodeVscodeCline } from '@codeburn/core/providers/vscode-cline'
import { decodeOpenCodeSession } from '@codeburn/core/providers/opencode-session'
import type { VscodeClineDecodedCall } from '@codeburn/core/providers/vscode-cline'
import type { OpenCodeSessionDecodedCall } from '@codeburn/core/providers/opencode-session'

import { discoverSqliteSessions, readSqliteSessionRecords, type SqliteProviderConfig } from './sqlite-session-parser.js'
import { discoverClineTasks, readClineRecords, toClineProviderCall } from './vscode-cline-parser.js'
import { toOpenCodeProviderCall } from './opencode.js'
import { createBridgedProvider } from './bridge.js'
import type { Provider, SessionSource, ParsedProviderCall } from './types.js'

const EXTENSION_ID = 'kilocode.kilo-code'
const PROVIDER_NAME = 'kilo-code'

function getSqliteConfig(): SqliteProviderConfig {
  const base = process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share')
  return {
    providerName: PROVIDER_NAME,
    displayName: 'KiloCode',
    dbDir: join(base, 'kilo'),
    dbFilePrefix: 'kilo',
  }
}

type KiloRich =
  | { arm: 'cline'; call: VscodeClineDecodedCall }
  | { arm: 'sqlite'; call: OpenCodeSessionDecodedCall }

export function createKiloCodeProvider(overrideDir?: string | string[]): Provider {
  const sqliteConfig = getSqliteConfig()

  // Provider-instance-scoped handoff for the verbose-stderr counts and session
  // id on the SQLite arm. readRecords and decode are called synchronously in
  // sequence inside one parse() generator, so this is safe.
  let lastSqliteCounts: { messageCount: number; partCount: number } | undefined
  let lastSessionId: string | undefined

  return createBridgedProvider<KiloRich>({
    name: PROVIDER_NAME,
    displayName: 'KiloCode',

    modelDisplayName(model: string): string {
      return model
    },

    toolDisplayName(rawTool: string): string {
      return rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      const [oldSessions, dbSessions] = await Promise.all([
        discoverClineTasks(EXTENSION_ID, PROVIDER_NAME, 'KiloCode', overrideDir),
        discoverSqliteSessions(sqliteConfig),
      ])
      return [...oldSessions, ...dbSessions]
    },

    async readRecords(source) {
      if (source.path.includes('.db:')) {
        const result = await readSqliteSessionRecords(source, sqliteConfig)
        if (result === null) return null
        const envelope = result.records[0] as { sessionId: string }
        lastSessionId = envelope.sessionId
        lastSqliteCounts = { messageCount: result.messageCount, partCount: result.partCount }
        return result.records
      }
      return readClineRecords(source)
    },

    decode(input) {
      const envelope = input.records[0] as { kind: string; sessionId?: string } | undefined
      if (!envelope) return { calls: [] }

      if (envelope.kind === 'cline-task') {
        const { calls } = decodeVscodeCline({
          records: input.records,
          context: input.context,
          seenKeys: input.seenKeys,
        })
        return { calls: calls.map(call => ({ arm: 'cline' as const, call })) }
      }

      if (envelope.kind === 'sqlite') {
        const { calls, diagnostics } = decodeOpenCodeSession({
          records: input.records,
          context: input.context,
          seenKeys: input.seenKeys,
        })
        // Preserve the pre-migration CODEBURN_VERBOSE notice for the SQLite arm.
        if (calls.length === 0 && lastSqliteCounts && lastSqliteCounts.messageCount > 0
            && process.env['CODEBURN_VERBOSE'] === '1' && lastSessionId) {
          const parseFailCount = diagnostics.filter(d => d.code === 'malformed-json').length
          const roleSkipCount = diagnostics.filter(d => d.code === 'unknown-shape').length
          process.stderr.write(
            `codeburn: KiloCode session ${lastSessionId} has ${lastSqliteCounts.messageCount} messages ` +
            `(${parseFailCount} unparseable, ${roleSkipCount} non-user/assistant roles) ` +
            `but yielded 0 calls. Parts: ${lastSqliteCounts.partCount}.\n`
          )
        }
        return { calls: calls.map(call => ({ arm: 'sqlite' as const, call })) }
      }

      return { calls: [] }
    },

    toProviderCall(rich) {
      if (rich.arm === 'cline') return toClineProviderCall(rich.call)
      return toOpenCodeProviderCall(rich.call)
    },
  })
}

export const kiloCode = createKiloCodeProvider()
