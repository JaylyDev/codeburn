import Testing
@testable import CodeBurnMenubar

@Suite("Provider reconnect presentation")
struct ProviderReconnectPresentationTests {
    @Test("every quota provider gets provider-specific recovery copy", arguments: [
        ProviderFilter.claude,
        .codex,
        .kimiCode,
        .gemini,
        .copilot,
        .antigravity,
    ])
    func providerSpecificRecoveryCopy(_ provider: ProviderFilter) {
        let presentation = ProviderReconnectPresentation(provider: provider)

        #expect(presentation.title == "Reconnect \(provider.rawValue)")
        #expect(!presentation.defaultReason.isEmpty)
        #expect(!presentation.instruction.isEmpty)

        for other in ["Claude", "Codex", "Kimi", "Gemini", "Copilot", "Antigravity"]
            where other != provider.rawValue && !(provider == .kimiCode && other == "Kimi") {
            #expect(!presentation.title.contains(other))
            #expect(!presentation.instruction.contains(other))
        }
    }

    @Test("unsupported providers receive neutral recovery copy")
    func genericRecoveryCopy() {
        let presentation = ProviderReconnectPresentation(provider: .cursor)

        #expect(presentation.title == "Reconnect Cursor")
        #expect(presentation.defaultReason == "Cursor credentials need to be refreshed.")
        #expect(presentation.instruction == "Sign in to Cursor again, then retry.")
    }
}
