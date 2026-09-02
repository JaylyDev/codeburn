/// Shape of the JSON returned by `codeburn status --format menubar-json`. Kept in sync with
/// `src/menubar-json.ts` (CLI) and `mac/Sources/CodeBurnMenubar/Data/MenubarPayload.swift`
/// (macOS app). Any field change there must land here too or the frontend silently drops it.
export type MenubarPayload = {
  generated: string
  current: {
    label: string
    cost: number
    calls: number
    sessions: number
    oneShotRate: number | null
    inputTokens: number
    outputTokens: number
    cacheHitPercent: number
    topActivities: Activity[]
    topModels: Model[]
    /// Counterfactual spend avoided by routing calls to a local model, from the
    /// mappings `codeburn model-savings` keeps. Absent on older CLI payloads.
    localModelSavings?: LocalModelSavings
    providers: Record<string, number>
    providerDetails?: Array<{
      id: string
      label: string
      cost: number
      calls?: number
      hasUsage?: boolean
    }>
  }
  optimize: {
    findingCount: number
    savingsUSD: number
    topFindings: Array<{ title: string; impact: 'high' | 'medium' | 'low'; savingsUSD: number }>
  }
  history: { daily: DailyEntry[] }
}

export type Activity = {
  name: string
  cost: number
  turns: number
  oneShotRate: number | null
}

export type Model = {
  name: string
  cost: number
  /// What this model would have cost at its paid baseline. Zero for every paid model.
  savingsUSD?: number
  calls: number
}

export type LocalModelSavings = {
  totalUSD: number
  calls: number
}

export type DailyModel = {
  name: string
  cost: number
  calls: number
  inputTokens: number
  outputTokens: number
}

export type DailyEntry = {
  date: string
  cost: number
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  topModels?: DailyModel[]
}
