import Foundation
import Testing
@testable import CodeBurnMenubar

/// A fetch whose completion the test controls, so two real refresh tasks can be
/// held in flight at once. Every attempt records the provider it was issued for
/// and parks until the test releases it by index.
@MainActor
private final class ScriptedFetch {
    private var parked: [Int: CheckedContinuation<Void, Never>] = [:]
    private(set) var attempts: [(index: Int, provider: ProviderFilter)] = []
    private(set) var released: [Int] = []
    var payloadForProvider: (ProviderFilter) -> MenubarPayload = { _ in scriptedPayload(cost: 1) }

    func install() {
        DataClient.fetchHookForTesting = { [weak self] provider, _ in
            guard let self else { return scriptedPayload(cost: 0) }
            let index = await self.begin(provider)
            await self.park(index)
            return await self.payload(for: provider)
        }
    }

    func uninstall() {
        DataClient.fetchHookForTesting = nil
        for (_, continuation) in parked { continuation.resume() }
        parked.removeAll()
    }

    private func begin(_ provider: ProviderFilter) -> Int {
        let index = attempts.count
        attempts.append((index: index, provider: provider))
        return index
    }

    private func park(_ index: Int) async {
        await withCheckedContinuation { parked[index] = $0 }
    }

    private func payload(for provider: ProviderFilter) -> MenubarPayload {
        payloadForProvider(provider)
    }

    func isParked(_ index: Int) -> Bool { parked[index] != nil }

    func release(_ index: Int) {
        guard let continuation = parked.removeValue(forKey: index) else { return }
        released.append(index)
        continuation.resume()
    }

    func indices(for provider: ProviderFilter) -> [Int] {
        attempts.filter { $0.provider == provider }.map(\.index)
    }
}

private func scriptedPayload(cost: Double,
                             calls: Int = 1,
                             providers: [String: Double]? = nil,
                             providerDetails: [ProviderDetail] = []) -> MenubarPayload {
    MenubarPayload(
        generated: "test",
        current: CurrentBlock(
            label: "Today",
            cost: cost,
            calls: calls,
            sessions: 1,
            oneShotRate: nil,
            inputTokens: 1,
            outputTokens: 1,
            cacheHitPercent: 0,
            codexCredits: nil,
            topActivities: [],
            topModels: [],
            localModelSavings: LocalModelSavings(totalUSD: 0, calls: 0, byModel: [], byProvider: []),
            providers: providers ?? ["claude": cost],
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

/// Yield repeatedly until `condition` holds. The tasks under test suspend on
/// real continuations, so progress needs actual scheduler turns, not a sleep.
@MainActor
private func settle(until condition: () -> Bool, turns: Int = 500) async -> Bool {
    for _ in 0..<turns {
        if condition() { return true }
        await Task.yield()
    }
    return condition()
}

// Serialized: the DataClient fetch hook is process-global, so two of these
// running at once would each see the other's attempts.
@Suite("AppStore refresh concurrency", .serialized)
@MainActor
struct AppStoreRefreshConcurrencyTests {

    @Test("an interactive refresh joins an in-flight fetch instead of reporting failure")
    func interactiveRefreshJoinsInFlightFetch() async {
        let script = ScriptedFetch()
        script.install()
        defer { script.uninstall() }

        let store = AppStore()
        store.setCacheDateToTodayForTesting()

        let first = Task { await store.refresh(includeOptimize: false, force: true) }
        #expect(await settle(until: { script.attempts.count == 1 }))

        // Second interactive refresh on the same key. It used to return false
        // immediately, which is what made recoverFromStuckLoading() announce a
        // failed recovery while a perfectly healthy fetch was still running.
        var secondResult: Bool?
        let second = Task {
            let value = await store.refresh(includeOptimize: false, force: true)
            secondResult = value
            return value
        }
        #expect(await settle(until: { store.inFlightWaiterCountForTesting(period: .today, provider: .all) == 1 }))
        #expect(secondResult == nil)

        script.release(0)
        #expect(await first.value)
        #expect(await second.value)
    }
}
