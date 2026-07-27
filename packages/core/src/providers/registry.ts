// Machine-readable inventory of the provider subpaths this package exports.
//
// Consumers (the CodeBurn CLI, the menubar, Prost, anything else) previously
// had to hard-code a provider list or scrape `package.json`. Both drift. This
// registry is the single declared source, and provider-registry.test.ts fails
// if it and the exports map ever disagree in either direction.

/** What a consumer can know about one provider subpath without importing it. */
export interface ProviderDescriptor {
  /** Stable provider id. Matches the last segment of `exportPath`. */
  readonly id: string
  /** The package subpath that exports this provider's decoder and adapter. */
  readonly exportPath: `./providers/${string}`
  /**
   * Whether the decoder threads de-duplication state across batches — it
   * accepts a caller-owned `seenKeys` set (and, for some providers, a `state`
   * object) so an incremental scan does not re-emit calls it already reported.
   *
   * Derived from the decoder's actual signature, not declared by hand.
   */
  readonly supportsIncrementalState: boolean
}

// NOTE ON A DELIBERATE OMISSION.
//
// An earlier draft of this registry carried an `inputKinds` field
// ('jsonl' | 'json' | 'rows' | 'bytes' | 'report'). It is not here because the
// value could not be established for all 34 providers without per-provider
// investigation of the host's discovery layer, and a registry that guesses is
// worse than one that stays silent — a consumer would route real data on it.
// Add it per provider, backed by evidence, rather than in one sweep.

const PROVIDERS: readonly ProviderDescriptor[] = Object.freeze([
  { id: 'antigravity', exportPath: './providers/antigravity', supportsIncrementalState: true },
  { id: 'claude', exportPath: './providers/claude', supportsIncrementalState: false },
  { id: 'codebuff', exportPath: './providers/codebuff', supportsIncrementalState: true },
  { id: 'codewhale', exportPath: './providers/codewhale', supportsIncrementalState: true },
  { id: 'codex', exportPath: './providers/codex', supportsIncrementalState: true },
  { id: 'copilot', exportPath: './providers/copilot', supportsIncrementalState: true },
  { id: 'crush', exportPath: './providers/crush', supportsIncrementalState: true },
  { id: 'cursor', exportPath: './providers/cursor', supportsIncrementalState: true },
  { id: 'cursor-agent', exportPath: './providers/cursor-agent', supportsIncrementalState: true },
  { id: 'devin', exportPath: './providers/devin', supportsIncrementalState: true },
  { id: 'droid', exportPath: './providers/droid', supportsIncrementalState: true },
  { id: 'forge', exportPath: './providers/forge', supportsIncrementalState: true },
  { id: 'gemini', exportPath: './providers/gemini', supportsIncrementalState: true },
  { id: 'goose', exportPath: './providers/goose', supportsIncrementalState: true },
  { id: 'grok', exportPath: './providers/grok', supportsIncrementalState: true },
  { id: 'hermes', exportPath: './providers/hermes', supportsIncrementalState: true },
  { id: 'kimi', exportPath: './providers/kimi', supportsIncrementalState: true },
  { id: 'kimicode', exportPath: './providers/kimicode', supportsIncrementalState: true },
  { id: 'kiro', exportPath: './providers/kiro', supportsIncrementalState: true },
  { id: 'lingtai-tui', exportPath: './providers/lingtai-tui', supportsIncrementalState: true },
  { id: 'mistral-vibe', exportPath: './providers/mistral-vibe', supportsIncrementalState: true },
  { id: 'mux', exportPath: './providers/mux', supportsIncrementalState: true },
  { id: 'open-design', exportPath: './providers/open-design', supportsIncrementalState: true },
  { id: 'openclaw', exportPath: './providers/openclaw', supportsIncrementalState: true },
  { id: 'opencode-session', exportPath: './providers/opencode-session', supportsIncrementalState: true },
  { id: 'pi', exportPath: './providers/pi', supportsIncrementalState: true },
  { id: 'quickdesk', exportPath: './providers/quickdesk', supportsIncrementalState: true },
  { id: 'qwen', exportPath: './providers/qwen', supportsIncrementalState: true },
  { id: 'vercel-gateway', exportPath: './providers/vercel-gateway', supportsIncrementalState: true },
  { id: 'vscode-cline', exportPath: './providers/vscode-cline', supportsIncrementalState: true },
  { id: 'warp', exportPath: './providers/warp', supportsIncrementalState: true },
  { id: 'zcode', exportPath: './providers/zcode', supportsIncrementalState: true },
  { id: 'zed', exportPath: './providers/zed', supportsIncrementalState: true },
  { id: 'zerostack', exportPath: './providers/zerostack', supportsIncrementalState: true },
].map((p) => Object.freeze(p)) as ProviderDescriptor[])

/**
 * Every provider subpath this package exports. Frozen; the returned array and
 * its entries cannot be mutated by a consumer.
 */
export function supportedProviders(): readonly ProviderDescriptor[] {
  return PROVIDERS
}

/** Look up one provider by id, or `undefined` if this build does not ship it. */
export function findProvider(id: string): ProviderDescriptor | undefined {
  return PROVIDERS.find((p) => p.id === id)
}
