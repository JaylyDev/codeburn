// Raw record + rich-decode types for the Vercel AI Gateway provider.
//
// The record type (`VercelGatewayReportRow`) describes one day×model aggregate
// returned by the `/v1/report` API. The decoded-call type is the rich, pre-
// pricing output: it carries the provider-reported `costUSD` verbatim (a measured
// dollar figure, not an estimate) but no free-text user content.

export type VercelGatewayReportRow = {
  day?: string
  model?: string
  total_cost?: number
  input_tokens?: number
  output_tokens?: number
  cached_input_tokens?: number
  cache_creation_input_tokens?: number
  reasoning_tokens?: number
  request_count?: number
}

// Rich decode of one Vercel Gateway aggregate row. Mirrors the host's
// ParsedProviderCall minus `costBasis` (the provider figure is measured, not
// estimated) and minus CLI-only fields (`project`, `tools`, `bashCommands`, and
// the host-held user prompt). No free text is captured: `day` is a calendar date
// and `model` is an API model identifier emitted under the identifier-exemption
// convention.
export type VercelGatewayDecodedCall = {
  provider: 'vercel-gateway'
  model: string
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  cachedInputTokens: number
  reasoningTokens: number
  webSearchRequests: number
  costUSD: number
  timestamp: string
  speed: 'standard'
  deduplicationKey: string
  sessionId: string
}
