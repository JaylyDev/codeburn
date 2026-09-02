import Foundation

struct ProviderStripPagingState: Sendable, Equatable {
    let filters: [ProviderFilter]
    let selectedProvider: ProviderFilter
    private(set) var viewportAnchor: ProviderFilter?

    init(
        filters: [ProviderFilter],
        selectedProvider: ProviderFilter,
        viewportAnchor: ProviderFilter?
    ) {
        self.filters = filters
        self.selectedProvider = selectedProvider
        if let viewportAnchor, filters.contains(viewportAnchor) {
            self.viewportAnchor = viewportAnchor
        } else if filters.contains(selectedProvider) {
            self.viewportAnchor = selectedProvider
        } else {
            self.viewportAnchor = filters.first
        }
    }

    var canMoveBackward: Bool { anchorIndex > 0 }
    var canMoveForward: Bool { anchorIndex >= 0 && anchorIndex < filters.count - 1 }

    @discardableResult
    mutating func move(direction: Int) -> ProviderFilter? {
        guard !filters.isEmpty, direction != 0 else { return viewportAnchor }
        let targetIndex = min(max(anchorIndex + (direction < 0 ? -1 : 1), 0), filters.count - 1)
        viewportAnchor = filters[targetIndex]
        return viewportAnchor
    }

    private var anchorIndex: Int {
        guard let viewportAnchor else { return -1 }
        return filters.firstIndex(of: viewportAnchor) ?? -1
    }
}
