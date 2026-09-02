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

    @Test("legacy payloads show only providers with period spend")
    func legacyProviderCostFallback() {
        let keys = ProviderVisibility.activeKeys(
            providerDetails: [],
            legacyProviders: ["codex": 3.25, "hermes agent": 0]
        )

        #expect(keys == ["codex"])
    }

    @Test("provider details without hasUsage stay visible")
    func absentHasUsageDefaultsToVisible() throws {
        func decode(_ json: String) throws -> ProviderDetail {
            try JSONDecoder().decode(ProviderDetail.self, from: Data(json.utf8))
        }
        // Every RELEASED CLI omits hasUsage. Deriving it from cost there hid
        // every subscription-backed provider whose period spend is $0.
        let noHasUsage = try decode(#"{"id":"hermes","label":"Hermes Agent","cost":0}"#)
        let noHasUsageWithCalls = try decode(#"{"id":"hermes","label":"Hermes Agent","cost":0,"calls":0}"#)
        let explicitlyIdle = try decode(#"{"id":"hermes","label":"Hermes Agent","cost":0,"calls":0,"hasUsage":false}"#)
        let explicitlyActive = try decode(#"{"id":"codex","label":"Codex","cost":0,"calls":0,"hasUsage":true}"#)

        #expect(noHasUsage.hasUsage)
        #expect(noHasUsageWithCalls.hasUsage)
        // The strict signal still applies wherever the CLI actually emits it.
        #expect(!explicitlyIdle.hasUsage)
        #expect(explicitlyActive.hasUsage)

        let keys = ProviderVisibility.activeKeys(
            providerDetails: [noHasUsage, explicitlyIdle],
            legacyProviders: [:]
        )
        #expect(keys.contains("hermes"))
    }
}
