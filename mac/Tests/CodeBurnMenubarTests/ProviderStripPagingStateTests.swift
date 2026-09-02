import Testing
@testable import CodeBurnMenubar

@Suite("Provider strip paging")
struct ProviderStripPagingStateTests {
    @Test("paging changes the viewport without selecting a provider")
    func pagingDoesNotSelect() {
        var state = ProviderStripPagingState(
            filters: [.all, .claude, .cursor],
            selectedProvider: .all,
            viewportAnchor: .all
        )

        #expect(state.move(direction: 1) == .claude)
        #expect(state.viewportAnchor == .claude)
        #expect(state.selectedProvider == .all)

        #expect(state.move(direction: 1) == .cursor)
        #expect(state.viewportAnchor == .cursor)
        #expect(state.selectedProvider == .all)
        #expect(!state.canMoveForward)
    }

    @Test("paging clamps a missing anchor to the selected provider")
    func missingAnchorUsesSelection() {
        var state = ProviderStripPagingState(
            filters: [.all, .claude, .cursor],
            selectedProvider: .claude,
            viewportAnchor: .grok
        )

        #expect(state.viewportAnchor == .claude)
        #expect(state.move(direction: -1) == .all)
        #expect(state.selectedProvider == .claude)
    }

    @Test("an empty strip cannot page")
    func emptyStrip() {
        var state = ProviderStripPagingState(
            filters: [],
            selectedProvider: .all,
            viewportAnchor: nil
        )

        #expect(state.move(direction: 1) == nil)
        #expect(!state.canMoveBackward)
        #expect(!state.canMoveForward)
    }
}
