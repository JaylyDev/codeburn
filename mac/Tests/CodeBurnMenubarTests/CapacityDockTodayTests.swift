import Foundation
import Testing
@testable import CodeBurnMenubar

/// The glance card is scoped to ONE provider, so its Today row has to be too.
/// It used to render the machine-wide block, which printed every provider's
/// spend under whichever card the pointer happened to be on.
private func todayPayload(
    cost: Double,
    calls: Int,
    inputTokens: Int,
    outputTokens: Int,
    providerDetails: [ProviderDetail]
) -> MenubarPayload {
    MenubarPayload(
        generated: "test",
        current: CurrentBlock(
            label: "Today",
            cost: cost,
            calls: calls,
            sessions: 0,
            oneShotRate: nil,
            inputTokens: inputTokens,
            outputTokens: outputTokens,
            cacheHitPercent: 0,
            codexCredits: nil,
            topActivities: [],
            topModels: [],
            localModelSavings: LocalModelSavings(totalUSD: 0, calls: 0, byModel: [], byProvider: []),
            providers: [:],
            providerDetails: providerDetails,
            topProjects: [],
            modelEfficiency: [],
            topSessions: [],
            retryTax: RetryTax(totalUSD: 0, retries: 0, editTurns: 0, byModel: []),
            routingWaste: RoutingWaste(totalSavingsUSD: 0, baselineModel: "", baselineCostPerEdit: 0, byModel: []),
            tools: [],
            skills: [],
            subagents: [],
            mcpServers: []
        ),
        optimize: OptimizeBlock(findingCount: 0, savingsUSD: 0, topFindings: []),
        history: HistoryBlock(daily: []),
        combined: nil,
        claudeConfigs: nil
    )
}

@MainActor
private func store(_ payload: MenubarPayload) -> AppStore {
    let store = AppStore()
    store.setCachedPayloadForTesting(payload, period: .today, provider: .all, fetchedAt: Date())
    return store
}

@Suite("Capacity Dock Today row")
@MainActor
struct CapacityDockTodayTests {
    @Test("The row is the hovered provider's own figures, not the machine's")
    func rowIsSelectedByProviderID() {
        let store = store(todayPayload(
            cost: 278.94,
            calls: 1_542,
            inputTokens: 9_000_000,
            outputTokens: 400_000,
            providerDetails: [
                ProviderDetail(id: "claude", label: "Claude", cost: 190.10, calls: 900,
                               hasUsage: true, inputTokens: 6_000_000, outputTokens: 250_000, sessions: 12),
                ProviderDetail(id: "codex", label: "Codex", cost: 88.84, calls: 642,
                               hasUsage: true, inputTokens: 3_000_000, outputTokens: 150_000, sessions: 4),
            ]
        ))

        let claude = store.capacityDockToday(for: .claude)
        #expect(claude?.cost == 190.10)
        #expect(claude?.calls == 900)
        #expect(claude?.inputTokens == 6_000_000)
        #expect(claude?.outputTokens == 250_000)
        // The machine-wide block is still there; it just is not what the card shows.
        #expect(store.capacityDockToday?.cost == 278.94)
        #expect(store.capacityDockToday(for: .codex)?.cost == 88.84)
        #expect(store.capacityDockToday(for: .codex)?.calls == 642)
    }

    @Test("Kimi Code reads its CLI row rather than the CLI's separate kimi provider")
    func dockIDMapsToTheCLIProviderID() {
        #expect(CapacityDockProvider.kimiCode.payloadProviderID == "kimicode")
        #expect(CapacityDockProvider.claude.payloadProviderID == "claude")
        #expect(CapacityDockProvider.codex.payloadProviderID == "codex")
        let store = store(todayPayload(
            cost: 9, calls: 9, inputTokens: 9, outputTokens: 9,
            providerDetails: [
                ProviderDetail(id: "kimi", label: "Kimi", cost: 8, calls: 8, hasUsage: true),
                ProviderDetail(id: "kimicode", label: "Kimi Code", cost: 1, calls: 1, hasUsage: true),
            ]
        ))
        #expect(store.capacityDockToday(for: .kimiCode)?.cost == 1)
    }

    @Test("A CLI without per-provider tokens hides them instead of borrowing the global pair")
    func absentTokensDoNotFallBackToTheGlobalFigures() {
        // Exactly what 0.9.23 emits: cost and calls per provider, no tokens.
        let store = store(todayPayload(
            cost: 278.94,
            calls: 1_542,
            inputTokens: 9_000_000,
            outputTokens: 400_000,
            providerDetails: [
                ProviderDetail(id: "claude", label: "Claude", cost: 190.10, calls: 900, hasUsage: true),
            ]
        ))
        let claude = store.capacityDockToday(for: .claude)
        // Cost and calls are still provider-scoped; the tokens are simply absent.
        #expect(claude?.cost == 190.10)
        #expect(claude?.calls == 900)
        #expect(claude?.inputTokens == nil)
        #expect(claude?.outputTokens == nil)
    }

    @Test("A provider with no usage today reads as a real zero")
    func zeroStateForAnIdleProvider() {
        let store = store(todayPayload(
            cost: 190.10,
            calls: 900,
            inputTokens: 6_000_000,
            outputTokens: 250_000,
            providerDetails: [
                ProviderDetail(id: "claude", label: "Claude", cost: 190.10, calls: 900,
                               hasUsage: true, inputTokens: 6_000_000, outputTokens: 250_000, sessions: 12),
            ]
        ))
        let codex = store.capacityDockToday(for: .codex)
        #expect(codex?.cost == 0)
        #expect(codex?.calls == 0)
        #expect(codex?.hasUsage == false)
        #expect(codex?.inputTokens == nil)
    }

    @Test("A payload with no provider breakdown drops the section rather than guess")
    func noBreakdownHidesTheSection() {
        let store = store(todayPayload(
            cost: 278.94, calls: 1_542, inputTokens: 1, outputTokens: 1, providerDetails: []
        ))
        #expect(store.capacityDockToday != nil)
        #expect(store.capacityDockToday(for: .claude) == nil)
        // Which is what the panel reserves height from.
        #expect(
            CapacityDockMetrics.detailHeight(
                quota: nil, sessionCount: nil, hasToday: false, tailEdge: .right, scale: 1
            ) == CapacityDockMetrics.detailHeight(
                quota: nil, sessionCount: nil, hasToday: true, tailEdge: .right, scale: 1
            )
        )
    }

    @Test("The Today row reserves the same height with or without the token column")
    func todayHeightIsIndependentOfTokenPresence() {
        // The token lines drop out of a fixed frame, so nothing in the panel's
        // computed height may vary with them — a fractional or drifting panel
        // height re-runs the window layout at display cadence.
        #expect(
            CapacityDockGlance.todayHeight
                == CapacityDockGlance.sectionPadTop
                + CapacityDockGlance.captionLine
                + CapacityDockGlance.pillGap
                + CapacityDockGlance.todayContentHeight
                + CapacityDockGlance.sectionPadBottom
        )
        let quota = QuotaSummary(
            providerFilter: .all,
            connection: .connected,
            primary: nil,
            details: [QuotaSummary.Window(label: "5-hour", percent: 0.2, resetsAt: nil)],
            planLabel: nil,
            footerLines: []
        )
        func height(_ hasToday: Bool, scale: CGFloat) -> CGFloat {
            CapacityDockMetrics.detailHeight(
                quota: quota, sessionCount: 1, hasToday: hasToday, tailEdge: .right, scale: scale
            )
        }
        #expect(height(true, scale: 1) - height(false, scale: 1) == CapacityDockGlance.todayHeight)
        for scale in [0.9, 1.0, 1.15, 1.25, 1.4] {
            let h = height(true, scale: CGFloat(scale))
            #expect(h == h.rounded())
        }
    }

    @Test("Token and session fields decode as absent on a payload that omits them")
    func providerDetailTokensAreOptional() throws {
        let legacy = """
        {"id":"claude","label":"Claude","cost":190.1,"calls":900,"hasUsage":true}
        """
        let old = try JSONDecoder().decode(ProviderDetail.self, from: Data(legacy.utf8))
        #expect(old.cost == 190.1)
        #expect(old.inputTokens == nil)
        #expect(old.outputTokens == nil)
        #expect(old.sessions == nil)

        let current = """
        {"id":"claude","label":"Claude","cost":190.1,"calls":900,"hasUsage":true,
         "inputTokens":6000000,"outputTokens":250000,"sessions":12}
        """
        let new = try JSONDecoder().decode(ProviderDetail.self, from: Data(current.utf8))
        #expect(new.inputTokens == 6_000_000)
        #expect(new.outputTokens == 250_000)
        #expect(new.sessions == 12)
    }
}
