import type { DateRange } from '../types.js'
import type { Provider, SessionSource, SessionParser, ParsedProviderCall } from './types.js'
import { decodeVercelGateway } from '@codeburn/core/providers/vercel-gateway'
import type { VercelGatewayDecodedCall, VercelGatewayReportRow } from '@codeburn/core/providers/vercel-gateway'
import { fetchWithTimeout } from '../fetch-utils.js'

const REPORT_URL = 'https://ai-gateway.vercel.sh/v1/report'

export function getVercelGatewayApiKey(): string | null {
  const key = process.env['AI_GATEWAY_API_KEY'] ?? process.env['VERCEL_OIDC_TOKEN']
  return key?.trim() ? key.trim() : null
}

function formatUtcDate(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export async function fetchVercelGatewayReport(
  dateRange: DateRange,
): Promise<VercelGatewayReportRow[]> {
  const key = getVercelGatewayApiKey()
  if (!key) return []

  const params = new URLSearchParams({
    start_date: formatUtcDate(dateRange.start),
    end_date: formatUtcDate(dateRange.end),
    date_part: 'day',
    group_by: 'model',
  })

  try {
    const res = await fetchWithTimeout(`${REPORT_URL}?${params}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
      },
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      process.stderr.write(
        `codeburn: Vercel AI Gateway report failed (HTTP ${res.status}). ` +
          'Requires AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN (Pro/Enterprise for /v1/report). ' +
          `${detail.slice(0, 200)}\n`,
      )
      return []
    }

    const body = (await res.json()) as { results?: VercelGatewayReportRow[] }
    return body.results ?? []
  } catch (err) {
    process.stderr.write(
      `codeburn: Vercel AI Gateway report unreachable (${err instanceof Error ? err.message : String(err)}).\n`,
    )
    return []
  }
}

// Map one rich core call into the host's ParsedProviderCall. Unlike the
// token-priced providers this one carries the gateway's own dollar figure, so
// `costUSD` passes through verbatim and no `costBasis` key is emitted — that is
// what makes parser.ts leave the value alone instead of repricing it.
function toProviderCall(rich: VercelGatewayDecodedCall, project: string): ParsedProviderCall {
  return {
    provider: 'vercel-gateway',
    model: rich.model,
    inputTokens: rich.inputTokens,
    outputTokens: rich.outputTokens,
    cacheCreationInputTokens: rich.cacheCreationInputTokens,
    cacheReadInputTokens: rich.cacheReadInputTokens,
    cachedInputTokens: rich.cachedInputTokens,
    reasoningTokens: rich.reasoningTokens,
    webSearchRequests: rich.webSearchRequests,
    costUSD: rich.costUSD,
    tools: [],
    bashCommands: [],
    timestamp: rich.timestamp,
    speed: rich.speed,
    deduplicationKey: rich.deduplicationKey,
    userMessage: '',
    sessionId: rich.sessionId,
    project,
  }
}

// Bespoke adapter rather than createBridgedProvider: the records come from an
// authenticated HTTP report scoped to the scan's date range, which the bridge's
// readRecords never receives. Fetching, auth, the stderr warnings, and the
// no-date-range gate stay here; core owns only the row -> call decode.
function createParser(
  source: SessionSource,
  seenKeys: Set<string>,
  dateRange?: DateRange,
): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      if (!dateRange) return

      const rows = await fetchVercelGatewayReport(dateRange)
      const { calls } = decodeVercelGateway({ records: rows, seenKeys })
      for (const rich of calls) {
        yield toProviderCall(rich, source.project)
      }
    },
  }
}

export const vercelGateway: Provider = {
  name: 'vercel-gateway',
  displayName: 'Vercel AI Gateway',
  network: true,

  modelDisplayName(model: string): string {
    const slash = model.indexOf('/')
    return slash >= 0 ? model.slice(slash + 1) : model
  },

  toolDisplayName(rawTool: string): string {
    return rawTool
  },

  async discoverSessions(): Promise<SessionSource[]> {
    if (!getVercelGatewayApiKey()) return []

    return [{
      path: 'vercel-ai-gateway:report',
      project: 'Vercel AI Gateway',
      provider: 'vercel-gateway',
    }]
  },

  createSessionParser(
    source: SessionSource,
    seenKeys: Set<string>,
    dateRange?: DateRange,
  ): SessionParser {
    return createParser(source, seenKeys, dateRange)
  },
}
