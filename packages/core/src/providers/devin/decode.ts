// @codeburn/core Devin decoder: pure decode over a host-supplied transcript JSON
// object plus the matching sessions.db row. The host reads the file, parses the
// JSON, queries the sqlite database, and hands the composite record straight
// through. This decoder is pure: no fs / env / clock / sqlite / pricing.
//
// Model DISPLAY names stay host-side: resolving one needs the CLI's model
// table (`getShortModelName`), so the decoder only resolves which RAW ids win
// the precedence chain and emits them; the host formats them.

import type { DecodeContext } from '../../contracts.js'
import type { RecordDiagnostic } from '../../diagnostics.js'
import type {
  ContentPart,
  ContentPartText,
  DevinAgentTrajectory,
  DevinDecodeRecord,
  DevinDecodedCall,
  DevinMetadata,
  DevinMetricsExtra,
  DevinSessionMetadata,
  DevinStep,
  DevinUsage,
  Metrics,
  ToolCall,
} from './types.js'

// Local copies of the host's safe number helpers (mirroring the claude decoder).
function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function safeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function getCommittedAcuCost(step: DevinStep): number {
  const acuCost = [
    step.metadata?.committed_acu_cost,
    step.extra?.committed_acu_cost,
  ].filter((cost) => isPositiveNumber(cost))

  return acuCost.shift() || 0
}

function hasAnyTokenField(
  metrics: Metrics<DevinMetricsExtra> | null | undefined,
): boolean {
  if (!metrics) return false
  return [
    metrics.prompt_tokens,
    metrics.completion_tokens,
    metrics.cached_tokens,
    metrics.extra?.cache_creation_input_tokens,
  ].some((value) => value != null)
}

function getMetricsFromStep(
  step: DevinStep,
): Metrics<DevinMetricsExtra> | null {
  // Prefer step.metrics (standard ATIF v1.7) only when it actually carries
  // token fields; a present-but-empty metrics object must not shadow the
  // legacy metadata.metrics location.
  if (hasAnyTokenField(step.metrics)) {
    return step.metrics ?? null
  }

  if (step.metadata) {
    return getDevinMetricsFromMetadata(step.metadata)
  }

  return step.metrics ?? null
}

function getDevinMetricsFromMetadata(
  metadata: DevinMetadata,
): Metrics<DevinMetricsExtra> {
  return {
    prompt_tokens: metadata.metrics?.input_tokens,
    completion_tokens: metadata.metrics?.output_tokens,
    cached_tokens: metadata.metrics?.cache_read_tokens,
    extra: {
      cache_creation_input_tokens: metadata.metrics?.cache_creation_tokens,
    },
  }
}

function getUsage(step: DevinStep): DevinUsage | null {
  const committedAcuCost = getCommittedAcuCost(step)
  const metrics = getMetricsFromStep(step)

  const hasAnyUsage = [
    committedAcuCost,
    metrics?.prompt_tokens,
    metrics?.completion_tokens,
    metrics?.extra?.cache_creation_input_tokens,
    metrics?.cached_tokens,
  ].some((x) => isPositiveNumber(x))

  if (!hasAnyUsage) return null

  return {
    committedAcuCost,
    inputTokens: safeNumber(metrics?.prompt_tokens),
    outputTokens: safeNumber(metrics?.completion_tokens),
    cacheCreationInputTokens: safeNumber(
      metrics?.extra?.cache_creation_input_tokens,
    ),
    cacheReadInputTokens: safeNumber(metrics?.cached_tokens),
  }
}

function projectNameFromPath(path: string): string {
  const normalized = path.trim().replace(/[/\\]+$/, '')
  return normalized.split(/[/\\]/).filter(Boolean).pop() ?? path
}

function getProjectName(
  project: string,
  session: DevinSessionMetadata | null,
): string {
  if (session?.workingDirectory)
    return projectNameFromPath(session.workingDirectory)
  if (session?.title) return session.title
  return project
}

function getProjectPath(
  session: DevinSessionMetadata | null,
): string | undefined {
  return session?.workingDirectory
}

function getTimestamp(
  step: DevinStep,
  session: DevinSessionMetadata | null,
): string {
  return [
    step.metadata?.created_at,
    session?.lastActivityAt,
    session?.createdAt,
  ]
    .filter(Boolean)
    .shift() ?? ''
}

function firstPresentString(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim()
    if (trimmed) return trimmed
  }
  return undefined
}

// Resolve which RAW model ids win Devin's precedence chains. Turning these into
// a display name needs the host's model table, so that step stays CLI-side.
function getModelIds(
  transcript: DevinAgentTrajectory,
  step: DevinStep,
  session: DevinSessionMetadata | null,
): { generationModel: string | undefined; modelName: string } {
  const generationModel = firstPresentString(
    step.metadata?.generation_model,
    step.extra?.generation_model,
  )
  const modelName = firstPresentString(
    step.model_name,
    transcript.agent?.model_name,
    session?.model,
  ) ?? 'devin'

  return { generationModel, modelName }
}

function getToolNames(step: DevinStep): string[] {
  return (step.tool_calls ?? []).map((call) => call.function_name)
}

function isTextContentPart(
  contentPart: ContentPart,
): contentPart is ContentPartText {
  return contentPart.type === 'text'
}

function normalizeContentPartMessage(contentPart: ContentPart) {
  if (isTextContentPart(contentPart)) {
    return contentPart.text
  } else {
    return contentPart.source.path
  }
}

function normalizeStepMessage(message: string | Array<ContentPart>): string {
  if (Array.isArray(message)) {
    return message.map((x) => normalizeContentPartMessage(x).trim()).join(' ')
  }
  return message.trim()
}

function getFirstUserMessageBeforeStep(
  steps: DevinStep[],
  index: number,
): string | null {
  for (let i = index - 1; i >= 0; i--) {
    const step = steps[i]
    if (!step?.metadata?.is_user_input) continue
    const message = step.message
      ? normalizeStepMessage(step.message)
      : undefined
    if (message) return message
  }
  return null
}

export type DevinDecodeInput = {
  records: unknown[]
  context: DecodeContext
  // Optional live dedup set the host mutates in place (its shared cross-file
  // seenKeys). Simple transcript providers never persist resume state, so there
  // is no serialized `seenKeys` fallback.
  seenKeys?: Set<string>
}

export type DevinDecodeResult = {
  calls: DevinDecodedCall[]
  diagnostics: RecordDiagnostic[]
}

/**
 * Decode one Devin transcript (host-supplied parsed JSON + sessions.db row)
 * into rich, cost-free calls. Dedup is keyed on `devin:<sessionId>:<step_id>`
 * against the live `seenKeys` set (host-owned).
 */
export function decodeDevin({ records, seenKeys: liveSeen }: DevinDecodeInput): DevinDecodeResult {
  const seen = liveSeen ?? new Set<string>()
  const calls: DevinDecodedCall[] = []
  const diagnostics: RecordDiagnostic[] = []

  const composite = records[0] as DevinDecodeRecord | undefined
  if (!composite || typeof composite !== 'object') return { calls, diagnostics }
  const transcript = composite.transcript
  const session = composite.session ?? null
  const sourceProject = composite.project ?? 'devin'
  const sessionId = composite.sessionId

  if (!transcript?.steps) return { calls, diagnostics }
  if (session?.hidden) return { calls, diagnostics }

  const project = getProjectName(sourceProject, session)
  const projectPath = getProjectPath(session)

  for (let index = 0; index < transcript.steps.length; index++) {
    const step = transcript.steps[index]
    if (step.metadata?.is_user_input) continue

    const usage = getUsage(step)
    if (!usage) continue

    const timestamp = getTimestamp(step, session)

    const deduplicationKey = `devin:${sessionId}:${step.step_id}`

    if (seen.has(deduplicationKey)) continue
    seen.add(deduplicationKey)

    const { generationModel, modelName } = getModelIds(transcript, step, session)
    const tools = getToolNames(step)
    const userMessage =
      getFirstUserMessageBeforeStep(transcript.steps, index) ?? ''

    calls.push({
      provider: 'devin',
      modelName,
      ...(generationModel !== undefined ? { generationModel } : {}),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      cachedInputTokens: usage.cacheReadInputTokens,
      reasoningTokens: 0,
      webSearchRequests: 0,
      tools,
      rawBashCommands: [],
      timestamp,
      speed: 'standard',
      deduplicationKey,
      userMessage,
      sessionId,
      project,
      ...(projectPath ? { projectPath } : {}),
      committedAcuCost: usage.committedAcuCost,
    })
  }

  return { calls, diagnostics }
}
