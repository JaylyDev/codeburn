import { createHash } from 'crypto'
import { readdir, readFile, stat } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { homedir } from 'os'

import { decodeKimi, kimiToolNameMap } from '@codeburn/core/providers/kimi'
import type { KimiDecodedCall } from '@codeburn/core/providers/kimi'

import { extractBashCommands } from '../bash-utils.js'
import { readSessionFile } from '../fs-utils.js'
import { getShortModelName } from '../models.js'
import { createBridgedProvider } from './bridge.js'
import type { Provider, SessionSource, ParsedProviderCall } from './types.js'

type JsonObject = Record<string, unknown>

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null
}

function stringField(obj: JsonObject | null, key: string): string | undefined {
  const value = obj?.[key]
  return typeof value === 'string' ? value : undefined
}

function getShareDir(overrideDir?: string): string {
  return overrideDir ?? process.env['KIMI_SHARE_DIR'] ?? join(homedir(), '.kimi')
}

function md5(text: string): string {
  return createHash('md5').update(text, 'utf-8').digest('hex')
}

function projectNameFromPath(pathValue: string): string {
  const cleaned = pathValue.replace(/\/+$/, '')
  return basename(cleaned) || cleaned || 'kimi'
}

async function loadProjectNames(shareDir: string): Promise<Map<string, string>> {
  const projects = new Map<string, string>()
  const raw = await readFile(join(shareDir, 'kimi.json'), 'utf-8').catch(() => null)
  if (!raw) return projects

  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return projects
  }

  const workDirs = asObject(data)?.['work_dirs']
  if (!Array.isArray(workDirs)) return projects

  for (const entry of workDirs) {
    const obj = asObject(entry)
    const pathValue = stringField(obj, 'path')
    if (!pathValue) continue
    const hash = md5(pathValue)
    const project = projectNameFromPath(pathValue)
    projects.set(hash, project)

    const kaos = stringField(obj, 'kaos')
    if (kaos && kaos !== 'local') projects.set(`${kaos}_${hash}`, project)
  }

  return projects
}

function parseTomlString(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null
  if (value.startsWith('"')) {
    const match = value.match(/^"((?:[^"\\]|\\.)*)"/)
    if (!match) return null
    try {
      return JSON.parse(`"${match[1]}"`) as string
    } catch {
      return match[1] ?? null
    }
  }
  if (value.startsWith("'")) {
    const match = value.match(/^'([^']*)'/)
    return match?.[1] ?? null
  }
  const match = value.match(/^([^#\s]+)/)
  return match?.[1] ?? null
}

function parseDefaultModelKey(configToml: string): string | null {
  for (const line of configToml.split('\n')) {
    const match = line.match(/^\s*default_model\s*=\s*(.+)$/)
    if (!match) continue
    return parseTomlString(match[1]!)
  }
  return null
}

function parseModelSectionName(line: string): string | null {
  const match = line.trim().match(/^\[models\.(?:"([^"]+)"|'([^']+)'|([^\]]+))\]$/)
  if (!match) return null
  return (match[1] ?? match[2] ?? match[3] ?? '').trim() || null
}

function parseModelIdForKey(configToml: string, modelKey: string): string | null {
  let inSection = false
  for (const line of configToml.split('\n')) {
    const section = parseModelSectionName(line)
    if (section !== null) {
      inSection = section === modelKey
      continue
    }
    if (!inSection) continue
    if (/^\s*\[/.test(line)) {
      inSection = false
      continue
    }
    const match = line.match(/^\s*model\s*=\s*(.+)$/)
    if (!match) continue
    return parseTomlString(match[1]!)
  }
  return null
}

async function getConfiguredModel(shareDir: string): Promise<string> {
  const envModel = process.env['KIMI_MODEL_NAME']?.trim()
  if (envModel) return envModel

  const raw = await readFile(join(shareDir, 'config.toml'), 'utf-8').catch(() => null)
  if (!raw) return 'kimi-auto'

  const defaultModel = parseDefaultModelKey(raw)
  if (!defaultModel) return 'kimi-auto'

  return parseModelIdForKey(raw, defaultModel) ?? defaultModel
}

async function addWireSource(sources: SessionSource[], filePath: string, project: string): Promise<void> {
  const s = await stat(filePath).catch(() => null)
  if (!s?.isFile()) return
  sources.push({ path: filePath, project, provider: 'kimi' })
}

function toProviderCall(rich: KimiDecodedCall): ParsedProviderCall {
  return {
    provider: 'kimi',
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
    bashCommands: [...new Set(rich.rawBashCommands.flatMap(c => extractBashCommands(c)))],
    timestamp: rich.timestamp,
    speed: rich.speed,
    deduplicationKey: rich.deduplicationKey,
    userMessage: rich.userMessage,
    sessionId: rich.sessionId,
  }
}

export function createKimiProvider(overrideDir?: string): Provider {
  const shareDir = getShareDir(overrideDir)

  return createBridgedProvider<KimiDecodedCall>({
    name: 'kimi',
    displayName: 'Kimi',

    modelDisplayName(model: string): string {
      return getShortModelName(model)
    },

    toolDisplayName(rawTool: string): string {
      return kimiToolNameMap[rawTool] ?? rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      const sources: SessionSource[] = []
      const sessionsRoot = join(shareDir, 'sessions')
      const projectNames = await loadProjectNames(shareDir)
      const workDirs = await readdir(sessionsRoot, { withFileTypes: true }).catch(() => [])

      for (const workDir of workDirs) {
        if (!workDir.isDirectory()) continue

        const project = projectNames.get(workDir.name) ?? workDir.name
        const workDirPath = join(sessionsRoot, workDir.name)
        const sessionDirs = await readdir(workDirPath, { withFileTypes: true }).catch(() => [])

        for (const sessionDir of sessionDirs) {
          if (!sessionDir.isDirectory()) continue

          const sessionPath = join(workDirPath, sessionDir.name)
          await addWireSource(sources, join(sessionPath, 'wire.jsonl'), project)

          const subagentsPath = join(sessionPath, 'subagents')
          const subagents = await readdir(subagentsPath, { withFileTypes: true }).catch(() => [])
          for (const subagent of subagents) {
            if (!subagent.isDirectory()) continue
            await addWireSource(sources, join(subagentsPath, subagent.name, 'wire.jsonl'), project)
          }
        }
      }

      return sources
    },

    async readRecords(source: SessionSource): Promise<unknown[] | null> {
      const [configuredModel, raw] = await Promise.all([
        getConfiguredModel(shareDir),
        readSessionFile(source.path),
      ])
      if (raw === null) return null
      return [{
        lines: raw.split('\n').filter(l => l.trim()),
        configuredModel,
        sessionName: basename(dirname(source.path)),
      }]
    },

    decode: decodeKimi,
    toProviderCall,
  })
}

export const kimi = createKimiProvider()
