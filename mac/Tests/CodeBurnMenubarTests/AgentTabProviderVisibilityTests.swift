import Foundation
import Testing
@testable import CodeBurnMenubar

@Suite("Agent tab provider visibility")
struct AgentTabProviderVisibilityTests {
    @Test("zero-cost providers with usage remain active while idle providers stay hidden")
    func zeroCostProvidersWithUsageRemainActive() {
        let details = [
            ProviderDetail(id: "pi", label: "Pi", cost: 54.5, calls: 5, hasUsage: true),
            ProviderDetail(id: "hermes", label: "Hermes Agent", cost: 0, calls: 0, hasUsage: true),
            ProviderDetail(id: "claude", label: "Claude", cost: 0, calls: 0, hasUsage: false),
        ]

        let keys = ProviderVisibility.activeKeys(
            providerDetails: details,
            legacyProviders: ["pi": 54.5, "hermes agent": 0, "claude": 0]
        )

        #expect(keys.contains("hermes"))
        #expect(keys.contains("hermes agent"))
        #expect(!keys.contains("claude"))
    }

    @Test("legacy payloads keep detected providers visible when activity is unknowable")
    func legacyDetectedProviderFallback() {
        let keys = ProviderVisibility.activeKeys(
            providerDetails: [],
            legacyProviders: ["codex": 3.25, "hermes agent": 0]
        )

        #expect(keys == ["codex", "hermes agent"])
    }

    @Test("legacy provider details without activity fields fail open, while calls remain authoritative")
    func legacyProviderDetailDecoding() throws {
        let noSignal = try JSONDecoder().decode(
            ProviderDetail.self,
            from: Data(#"{"id":"hermes","label":"Hermes Agent","cost":0}"#.utf8)
        )
        let explicitIdleCalls = try JSONDecoder().decode(
            ProviderDetail.self,
            from: Data(#"{"id":"hermes","label":"Hermes Agent","cost":0,"calls":0}"#.utf8)
        )

        #expect(noSignal.hasUsage)
        #expect(!explicitIdleCalls.hasUsage)
    }
}
