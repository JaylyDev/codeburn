import { readdir, readFile, stat } from 'fs/promises'
import { basename, delimiter, dirname, join, resolve } from 'path'
import { homedir } from 'os'

import { decodeLingTaiTui } from '@codeburn/core/providers/lingtai-tui'
import type { DecodeContext } from '@codeburn/core'
import type { LingTaiTuiDecodedCall, LingTaiAgentManifest } from '@codeburn/core/providers/lingtai-tui'

import { readSessionLines } from '../fs-utils.js'
import { getShortModelName } from '../models.js'
import { createBridgedProvider } from './bridge.js'
import type { ParsedProviderCall, Provider, SessionSource } from './types.js'

type JsonObject = Record<string, unknown>

type LingTaiProviderOptions = {
  lingtaiHomeOverride?: string
  defaultHomeOverride?: string
  globalDirOverride?: string
  cwdOverride?: string
}

type LingTaiHome = {
  path: string
  projectPrefix?: string
}

// Host-derived scalars the pure core decode needs, packed with the ledger lines.
type LingTaiMeta = {
  agentId: string
  fallbackModel: string
  fallbackEndpoint: string
  projectPath: string
  project: string
}
type LingTaiPacked = { meta: LingTaiMeta; records: unknown[] }

function normalizeOptions(options?: string | LingTaiProviderOptions): LingTaiProviderOptions {
  return typeof options === 'string'
    ? { lingtaiHomeOverride: options }
    : options ?? {}
}

function expandHome(raw: string): string {
  if (raw === '~') return homedir()
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return join(homedir(), raw.slice(2))
  return raw
}

function splitPathList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(delimiter)
    .map(p => p.trim())
    .filter(Boolean)
}

async function existingDir(path: string): Promise<string | null> {
  const resolved = resolve(expandHome(path))
  const s = await stat(resolved).catch(() => null)
  return s?.isDirectory() ? resolved : null
}

function getDefaultLingTaiHome(options: LingTaiProviderOptions): string {
  return options.defaultHomeOverride ?? join(homedir(), '.lingtai')
}

function getLingTaiGlobalDir(options: LingTaiProviderOptions): string {
  return options.globalDirOverride
    ?? process.env['LINGTAI_TUI_GLOBAL_DIR']
    ?? join(homedir(), '.lingtai-tui')
}

function projectPrefixFromHome(lingtaiHome: string, defaultLingTaiHome: string): string | undefined {
  const defaultHome = resolve(expandHome(defaultLingTaiHome))
  const resolved = resolve(lingtaiHome)
  if (resolved === defaultHome) return undefined

  const projectName = basename(dirname(resolved))
  return projectName && projectName !== '.' ? sanitizeProject(projectName) : undefined
}

async function readRegisteredProjectPaths(globalDir: string): Promise<string[]> {
  const projects: string[] = []

  const registryRaw = await readFile(join(globalDir, 'registry.jsonl'), 'utf-8').catch(() => '')
  for (const line of registryRaw.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const obj = asObject(JSON.parse(line))
      const path = stringField(obj, 'path')
      if (path) projects.push(path)
    } catch {
      // Ignore corrupt registry rows; LingTai treats this as append-only state.
    }
  }

  const briefDir = join(globalDir, 'brief', 'projects')
  const entries = await readdir(briefDir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const meta = await readJson<JsonObject>(join(briefDir, entry.name, 'meta.json'))
    const path = stringField(meta, 'project_path')
    if (path) projects.push(path)
  }

  return projects
}

function cwdLingTaiHomes(cwd: string): string[] {
  const homes: string[] = []
  let current = resolve(cwd)
  for (;;) {
    homes.push(join(current, '.lingtai'))
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return homes
}

async function getLingTaiHomes(options: LingTaiProviderOptions): Promise<LingTaiHome[]> {
  const explicit = splitPathList(options.lingtaiHomeOverride ?? process.env['LINGTAI_HOME'] ?? process.env['LINGTAI_TUI_HOME'])
  const defaultHome = getDefaultLingTaiHome(options)
  const candidates = explicit.length
    ? explicit
    : [
        defaultHome,
        ...(await readRegisteredProjectPaths(getLingTaiGlobalDir(options))).map(project => join(project, '.lingtai')),
        ...cwdLingTaiHomes(options.cwdOverride ?? process.cwd()),
      ]

  const seen = new Set<string>()
  const homes: LingTaiHome[] = []
  for (const candidate of candidates) {
    const path = await existingDir(candidate)
    if (!path || seen.has(path)) continue
    seen.add(path)
    homes.push({ path, projectPrefix: explicit.length ? undefined : projectPrefixFromHome(path, defaultHome) })
  }

  return homes
}

function sanitizeProject(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return 'lingtai'
  return trimmed.replace(/^[/\\]+/, '').replace(/[:/\\]/g, '-')
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null
}

function stringField(obj: JsonObject | null, key: string): string | undefined {
  const value = obj?.[key]
  return typeof value === 'string' && value.trim() ? value : undefined
}

async function readJson<T>(path: string): Promise<T | null> {
  const raw = await readFile(path, 'utf-8').catch(() => null)
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

async function readAgentManifest(agentDir: string): Promise<LingTaiAgentManifest | null> {
  const obj = asObject(await readJson<unknown>(join(agentDir, '.agent.json')))
  if (!obj) return null
  // .agent.json is untrusted: a planted file can be valid JSON with wrong-typed
  // fields (e.g. `agent_name: {}`). Reading it as a raw cast let a non-string
  // field reach sanitizeProject().trim() and throw — and because
  // discoverAllSessions loops providers without a try/catch, that one file took
  // down usage discovery for EVERY provider. Normalize to string-or-undefined
  // here so no downstream string op ever sees a non-string.
  const llm = asObject(obj['llm'])
  return {
    agent_id: stringField(obj, 'agent_id'),
    agent_name: stringField(obj, 'agent_name'),
    address: stringField(obj, 'address'),
    nickname: stringField(obj, 'nickname') ?? null,
    llm: llm
      ? { model: stringField(llm, 'model'), base_url: stringField(llm, 'base_url') }
      : undefined,
  }
}

function agentDirFromLedgerPath(ledgerPath: string): string {
  return dirname(dirname(ledgerPath))
}

function projectFromManifest(manifest: LingTaiAgentManifest | null, fallback: string, prefix?: string): string {
  const name = sanitizeProject(
    manifest?.nickname
      ?? manifest?.agent_name
      ?? manifest?.address
      ?? fallback,
  )
  return prefix ? `${prefix}-${name}` : name
}

async function discoverLedgersInHome(home: LingTaiHome): Promise<SessionSource[]> {
  const entries = await readdir(home.path, { withFileTypes: true }).catch(() => [])
  const sources: SessionSource[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    const agentDir = join(home.path, entry.name)
    const ledgerPath = join(agentDir, 'logs', 'token_ledger.jsonl')
    const s = await stat(ledgerPath).catch(() => null)
    if (!s?.isFile()) continue

    const manifest = await readAgentManifest(agentDir)
    sources.push({
      path: ledgerPath,
      project: projectFromManifest(manifest, entry.name, home.projectPrefix),
      provider: 'lingtai-tui',
    })
  }

  return sources
}

async function discoverLedgers(homes: LingTaiHome[]): Promise<SessionSource[]> {
  const sources: SessionSource[] = []
  const seen = new Set<string>()

  for (const home of homes) {
    for (const source of await discoverLedgersInHome(home)) {
      if (seen.has(source.path)) continue
      seen.add(source.path)
      sources.push(source)
    }
  }

  return sources
}

// Map one rich, cost-free decoder call into the host's ParsedProviderCall.
// LingTai ledgers carry synthetic activity (no shell commands), so bashCommands
// is the decoder's empty raw list.
function toProviderCall(rich: LingTaiTuiDecodedCall): ParsedProviderCall {
  return {
    provider: 'lingtai-tui',
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
    bashCommands: rich.rawBashCommands,
    subagentTypes: rich.subagentTypes,
    timestamp: rich.timestamp,
    speed: rich.speed,
    deduplicationKey: rich.deduplicationKey,
    turnId: rich.turnId,
    userMessage: rich.userMessage,
    sessionId: rich.sessionId,
    projectPath: rich.projectPath,
    ...(rich.project !== undefined ? { project: rich.project } : {}),
  }
}

function decode(input: { records: unknown[]; context: DecodeContext; seenKeys: Set<string> }): { calls: LingTaiTuiDecodedCall[] } {
  const packed = input.records[0] as LingTaiPacked | undefined
  if (!packed) return { calls: [] }
  return decodeLingTaiTui({ records: packed.records, context: input.context, ...packed.meta, seenKeys: input.seenKeys })
}

export function createLingTaiTuiProvider(options?: string | LingTaiProviderOptions): Provider {
  const providerOptions = normalizeOptions(options)

  return createBridgedProvider<LingTaiTuiDecodedCall>({
    name: 'lingtai-tui',
    displayName: 'LingTai TUI',

    modelDisplayName(model: string): string {
      return getShortModelName(model)
    },

    toolDisplayName(rawTool: string): string {
      return rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      return discoverLedgers(await getLingTaiHomes(providerOptions))
    },

    // I/O adapter: read the agent manifest (for model/endpoint/agent-id/project
    // fallbacks) and the ledger JSONL lines, packing them for the pure decoder.
    async readRecords(source: SessionSource): Promise<unknown[] | null> {
      const agentDir = agentDirFromLedgerPath(source.path)
      const manifest = await readAgentManifest(agentDir)
      const meta: LingTaiMeta = {
        agentId: manifest?.agent_id ?? basename(agentDir),
        fallbackModel: manifest?.llm?.model ?? 'unknown',
        fallbackEndpoint: manifest?.llm?.base_url ?? '',
        projectPath: agentDir,
        project: source.project || projectFromManifest(manifest, basename(agentDir)),
      }
      const lines: string[] = []
      for await (const line of readSessionLines(source.path)) lines.push(line)
      const packed: LingTaiPacked = { meta, records: lines }
      return [packed]
    },

    decode,
    toProviderCall,
  })
}

export const lingtaiTui = createLingTaiTuiProvider()
