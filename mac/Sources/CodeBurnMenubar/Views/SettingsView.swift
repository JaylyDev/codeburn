import AppKit
import SwiftUI

/// System Settings–style window: a fixed-width sidebar (search, General/About,
/// per-provider rows) drives the detail pane. New providers plug in by adding
/// one entry to `providers`; each pane owns its own Form content and this
/// top-level view only hosts the shell.
struct SettingsView: View {
    @Environment(AppStore.self) private var store
    @State private var searchText = ""

    /// One entry per provider pane. `id` doubles as the deep-link tag, so the
    /// sidebar, the detail switch, and `store.settingsTab` all speak the same
    /// strings.
    struct ProviderPane: Identifiable {
        let id: String
        let name: String
        let icon: String
        let isConnected: Bool
    }

    private static let mainPaneIDs: Set<String> = ["general", "about"]

    private var providers: [ProviderPane] {
        [
            ProviderPane(id: "claude", name: "Claude", icon: "claude",
                         isConnected: store.subscriptionLoadState == .loaded),
            ProviderPane(id: "codex", name: "Codex", icon: "openai",
                         isConnected: store.codexLoadState == .loaded),
            ProviderPane(id: "kimi", name: "Kimi Code", icon: "kimi",
                         isConnected: store.kimiLoadState == .loaded),
            ProviderPane(id: "devin", name: "Devin", icon: "devin",
                         isConnected: CLIDevinConfig.loadAcuUsdRate() != nil),
            ProviderPane(id: "gemini", name: "Gemini", icon: "googlegemini",
                         isConnected: store.geminiLoadState == .loaded),
            ProviderPane(id: "copilot", name: "Copilot", icon: "githubcopilot",
                         isConnected: store.copilotLoadState == .loaded),
            ProviderPane(id: "antigravity", name: "Antigravity", icon: "antigravity",
                         isConnected: store.antigravityLoadState == .loaded),
        ]
    }

    // Search narrows the provider list only; General/About stay put.
    private var filteredProviders: [ProviderPane] {
        let query = searchText.trimmingCharacters(in: .whitespaces)
        guard !query.isEmpty else { return providers }
        return providers.filter { $0.name.localizedCaseInsensitiveContains(query) }
    }

    /// Deep links can name a pane that no longer exists; those fall back to
    /// General instead of leaving the sidebar without a selection.
    private var selection: Binding<String> {
        Binding(
            get: {
                let tab = store.settingsTab
                return Self.mainPaneIDs.contains(tab) || providers.contains { $0.id == tab } ? tab : "general"
            },
            set: { store.settingsTab = $0 }
        )
    }

    private static let windowWidth: CGFloat = 880
    private static let windowHeight: CGFloat = 620
    private static let sidebarWidth: CGFloat = 260

    var body: some View {
        HStack(spacing: 0) {
            // Layout modeled on CodexBar (MIT, steipete/CodexBar): a fixed-width
            // sidebar (search, General/About, per-provider rows) over an
            // edge-to-edge sidebar material, hairline divider, then the detail pane.
            sidebar
                .frame(width: Self.sidebarWidth)
                .background {
                    SettingsSidebarMaterial()
                        .ignoresSafeArea()
                }

            Divider()
                .ignoresSafeArea()

            detailView
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .frame(minWidth: Self.windowWidth, maxWidth: .infinity, minHeight: Self.windowHeight, maxHeight: .infinity)
        .background {
            SettingsWindowStyleAccessor(title: currentPaneTitle)
                .allowsHitTesting(false)
        }
    }

    private var sidebar: some View {
        VStack(spacing: 0) {
            SettingsSidebarSearchField(searchText: $searchText)
                .padding(.horizontal, 8)
                .padding(.top, 16)
                .padding(.bottom, 8)

            List(selection: selection) {
                Section {
                    SettingsSidebarPaneRow(pane: "general", title: "General", systemImage: "gearshape.fill", color: .gray)
                    SettingsSidebarAboutRow()
                }
                Section {
                    ForEach(filteredProviders) { provider in
                        SettingsSidebarProviderRow(provider: provider)
                            .tag(provider.id)
                    }
                } header: {
                    HStack(spacing: 4) {
                        Text("Providers")
                        Spacer()
                        Text("\(providers.filter(\.isConnected).count) on")
                            .foregroundStyle(.tertiary)
                            .monospacedDigit()
                            .padding(.trailing, 10)
                    }
                }
            }
            .listStyle(.sidebar)
            .scrollContentBackground(.hidden)
        }
        .padding(.horizontal, 8)
    }

    private var currentPaneTitle: String {
        switch selection.wrappedValue {
        case "general": return "General"
        case "about": return "About"
        default:
            return providers.first { $0.id == selection.wrappedValue }?.name ?? "Settings"
        }
    }

    @ViewBuilder
    private var detailView: some View {
        switch selection.wrappedValue {
        case "claude": ClaudeSettingsTab()
        case "codex": CodexSettingsTab()
        case "kimi": KimiSettingsTab()
        case "devin": DevinSettingsTab()
        case "gemini": GeminiSettingsTab()
        case "copilot": CopilotSettingsTab()
        case "antigravity": AntigravitySettingsTab()
        case "about": AboutSettingsTab()
        default: GeneralSettingsTab()
        }
    }
}

// MARK: - Sidebar support

/// PNG decode is too expensive to redo on every body evaluation, so loaded
/// template images are kept for the life of the process.
@MainActor
private enum ProviderIconCache {
    private static var images: [String: NSImage] = [:]

    /// Loads one of the bundled 512px black-glyph PNGs (Resources/ProviderIcons)
    /// as a template NSImage so `foregroundStyle` fully controls the color.
    static func image(named name: String) -> NSImage? {
        if let cached = images[name] { return cached }
        // SwiftPM keeps the folder hierarchy for .process'd directories, but
        // tolerate a flattened layout too so the lookup survives a rule change.
        for subdirectory in ["Resources/ProviderIcons", "ProviderIcons", nil] {
            if let url = Bundle.module.url(forResource: name, withExtension: "png", subdirectory: subdirectory),
               let image = NSImage(contentsOf: url) {
                image.isTemplate = true
                images[name] = image
                return image
            }
        }
        return nil
    }
}

/// Colored rounded-square symbol used for app panes in the settings sidebar,
/// mirroring the System Settings sidebar style.
private struct SettingsIconChip: View {
    static let side: CGFloat = 20

    let systemImage: String
    let color: Color

    var body: some View {
        Image(systemName: systemImage)
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: Self.side, height: Self.side)
            .background(
                RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .fill(LinearGradient(
                        colors: [color.opacity(0.85), color],
                        startPoint: .top,
                        endPoint: .bottom)))
            .accessibilityHidden(true)
    }
}

private struct SettingsSidebarPaneRow: View {
    let pane: String
    let title: String
    let systemImage: String
    let color: Color

    var body: some View {
        HStack(spacing: 8) {
            SettingsIconChip(systemImage: systemImage, color: color)
            Text(title)
        }
        .tag(pane)
    }
}

private struct SettingsSidebarAboutRow: View {
    var body: some View {
        HStack(spacing: 8) {
            // Bare brand mark, no chip container — the binary flame reads
            // better at this size than the boxed app icon.
            Group {
                if let flame = ProviderIconCache.image(named: "flame-solid") {
                    Image(nsImage: flame)
                        .resizable()
                        .scaledToFit()
                } else {
                    SettingsIconChip(systemImage: "info.circle.fill", color: .gray)
                }
            }
            .frame(width: SettingsIconChip.side, height: SettingsIconChip.side)
            .accessibilityHidden(true)
            Text("About")
        }
        .tag("about")
    }
}

private struct SettingsSidebarProviderRow: View {
    let provider: SettingsView.ProviderPane

    var body: some View {
        HStack(spacing: 8) {
            SettingsSidebarBrandIcon(icon: provider.icon, isConnected: provider.isConnected)

            Text(provider.name)
                .foregroundStyle(provider.isConnected ? .primary : .secondary)

            Spacer(minLength: 4)

            if provider.isConnected {
                Circle()
                    .fill(.green)
                    .frame(width: 6, height: 6)
                    .accessibilityHidden(true)
            }
        }
        .opacity(provider.isConnected ? 1 : 0.62)
    }
}

private struct SettingsSidebarBrandIcon: View {
    let icon: String
    let isConnected: Bool

    var body: some View {
        Group {
            if let image = ProviderIconCache.image(named: icon) {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFit()
            } else {
                Image(systemName: "circle.dotted")
                    .resizable()
                    .scaledToFit()
            }
        }
        .frame(width: 16, height: 16)
        .foregroundStyle(isConnected ? .primary : .secondary)
        .accessibilityHidden(true)
    }
}

private struct SettingsSidebarSearchField: View {
    @Binding var searchText: String

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)

            TextField("Search providers", text: $searchText)
                .textFieldStyle(.plain)

            if !searchText.isEmpty {
                Button {
                    searchText = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.secondary)
                        .accessibilityLabel("Clear")
                }
                .buttonStyle(.plain)
            }
        }
        .font(.callout)
        .padding(.horizontal, 7)
        .padding(.vertical, 4)
        .background(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(Color(nsColor: .textBackgroundColor).opacity(0.6)))
        .overlay(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .stroke(Color(nsColor: .separatorColor).opacity(0.6), lineWidth: 1))
    }
}

/// Edge-to-edge sidebar material so the sidebar runs up behind the transparent
/// titlebar, matching System Settings.
private struct SettingsSidebarMaterial: NSViewRepresentable {
    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        configure(view)
        return view
    }

    func updateNSView(_ nsView: NSVisualEffectView, context: Context) {
        configure(nsView)
    }

    private func configure(_ view: NSVisualEffectView) {
        view.material = .sidebar
        view.blendingMode = .behindWindow
        view.state = .followsWindowActiveState
    }
}

/// Applies the System Settings window chrome (transparent, separator-less
/// titlebar over full-size content) to whichever window hosts this view.
/// Needed because the SwiftUI Settings scene exposes no styling hooks.
private struct SettingsWindowStyleAccessor: NSViewRepresentable {
    let title: String

    func makeNSView(context: Context) -> SettingsWindowStyleView {
        SettingsWindowStyleView()
    }

    func updateNSView(_ nsView: SettingsWindowStyleView, context: Context) {
        nsView.paneTitle = title
        nsView.applyStyle()
    }
}

private final class SettingsWindowStyleView: NSView {
    var paneTitle = "Settings"

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        applyStyle()
    }

    private var didPlaceWindow = false

    func applyStyle() {
        guard let window else { return }
        // Full-size content lets the sidebar material extend behind the
        // titlebar so the edge-to-edge sidebar reaches the top of the window.
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .visible
        window.titlebarSeparatorStyle = .none
        window.styleMask.insert(.fullSizeContentView)
        window.styleMask.insert(.resizable)
        // Match System Settings: the window is named after the visible pane.
        window.title = paneTitle
        window.collectionBehavior.insert(.fullScreenPrimary)
        // The frameAutosave may restore a position saved when the window was
        // smaller, leaving the grown window hanging off the screen edge —
        // recenter once whenever it does not fit fully on its screen.
        if !didPlaceWindow {
            didPlaceWindow = true
            if let screen = window.screen ?? NSScreen.main,
               !screen.visibleFrame.contains(window.frame) {
                window.center()
            }
        }
    }
}

// MARK: - General

private struct GeneralSettingsTab: View {
    @Environment(AppStore.self) private var store

    // "Custom…" budget entry state, one per metric (cost in dollars, tokens in
    // millions). When custom is active the picker shows "Custom…" and a field
    // appears for an exact amount.
    @State private var costCustom = false
    @State private var tokenCustom = false
    @State private var costText = ""
    @State private var tokenText = ""

    // AppStorage (not a computed Binding over UsageRefreshCadence.current):
    // a plain UserDefaults write does not invalidate the view, so the picker
    // label would never reflect the selection even though the value landed.
    @AppStorage(UsageRefreshCadence.defaultsKey)
    private var usageRefreshSeconds: Int = UsageRefreshCadence.default.rawValue

    // Stored as the raw string so an unrecognised value (older build, manual
    // `defaults write`) parses back to .terminal instead of failing to decode.
    @AppStorage(PreferredTerminal.defaultsKey)
    private var preferredTerminalRaw: String = PreferredTerminal.default.rawValue

    private let costPresets: Set<Double> = [25, 50, 100, 200, 500]
    private let tokenPresets: Set<Double> = [1_000_000, 5_000_000, 10_000_000, 25_000_000, 50_000_000, 100_000_000]

    private func applyCostBudget() {
        store.dailyBudget = max(0, Double(costText.trimmingCharacters(in: .whitespaces)) ?? 0)
    }

    private func applyTokenBudget() {
        let millions = Double(tokenText.trimmingCharacters(in: .whitespaces)) ?? 0
        store.dailyTokenBudget = max(0, millions * 1_000_000)
    }

    private func trimNumber(_ v: Double) -> String {
        v == v.rounded() ? String(Int(v)) : String(v)
    }

    // Help text under the budget picker. When "Custom…" is selected but no amount
    // has been entered, the budget is effectively 0 (off); call that out so the
    // alert does not look armed when it isn't.
    private var alertHelpText: String {
        let customEmpty = store.isTokenMetric
            ? (tokenCustom && store.dailyTokenBudget == 0)
            : (costCustom && store.dailyBudget == 0)
        if customEmpty { return "Enter an amount above, or the alert stays off." }
        return "Flame icon turns yellow when today's \(store.isTokenMetric ? "tokens" : "cost") pass the daily budget."
    }

    var body: some View {
        Form {
            Section("Display") {
                Picker("Currency", selection: Binding(
                    get: { store.currency },
                    set: { applyCurrency(code: $0) }
                )) {
                    ForEach(SupportedCurrency.allCases) { currency in
                        Text("\(currency.rawValue) · \(currency.displayName)").tag(currency.rawValue)
                    }
                }
                Picker("Metric", selection: Binding(
                    get: { store.displayMetric },
                    set: { store.displayMetric = $0 }
                )) {
                    Text("Cost ($)").tag(DisplayMetric.cost)
                    Text("Tokens (↑↓)").tag(DisplayMetric.tokens)
                    Text("Total Tokens").tag(DisplayMetric.totalTokens)
                    Text("Credits (Codex)").tag(DisplayMetric.credits)
                    Text("Icon Only").tag(DisplayMetric.iconOnly)
                }
                Picker("Period", selection: Binding(
                    get: { store.menubarPeriod },
                    set: { store.setMenubarPeriod($0) }
                )) {
                    ForEach(Period.menubarMetricCases) { period in
                        Text(period.menubarMetricLabel).tag(period)
                    }
                }
                .pickerStyle(.menu)
                Picker("Scope", selection: Binding(
                    get: { store.menubarScope },
                    set: { store.setMenubarScope($0) }
                )) {
                    ForEach(MenubarScope.allCases) { scope in
                        Text(scope.rawValue).tag(scope)
                    }
                }
                .pickerStyle(.menu)
                Picker("Accent", selection: Binding(
                    get: { store.accentPreset },
                    set: { store.accentPreset = $0 }
                )) {
                    ForEach(AccentPreset.allCases) { preset in
                        Text(preset.rawValue).tag(preset)
                    }
                }
            }

            Section("Usage Refresh") {
                Picker("Update every", selection: Binding(
                    get: { UsageRefreshCadence(rawValue: usageRefreshSeconds) ?? .default },
                    set: { usageRefreshSeconds = $0.rawValue }
                )) {
                    ForEach(UsageRefreshCadence.allCases) { cadence in
                        Text(cadence.label).tag(cadence)
                    }
                }
                .pickerStyle(.menu)
                Text("How often the menubar figure re-reads your local session data. Auto refreshes every 30 seconds while you're plugged in and backs off on battery; Manual only refreshes when you open the popover or click Refresh Now.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }

            Section("Terminal") {
                Picker("Open commands in", selection: Binding(
                    get: { PreferredTerminal(rawValue: preferredTerminalRaw) ?? .default },
                    set: { preferredTerminalRaw = $0.rawValue }
                )) {
                    ForEach(PreferredTerminal.allCases) { terminal in
                        Text(terminal.isInstalled ? terminal.label : "\(terminal.label) (not installed)")
                            .tag(terminal)
                    }
                }
                .pickerStyle(.menu)
                Text("Where Full Report and Optimize open. If the chosen app isn't installed CodeBurn falls back to Terminal; if that's missing too the command runs in the background. Only terminals that can script a command into a live window are listed.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }

            Section("Alerts") {
                // The budget tracks whatever the menubar metric shows: dollars for
                // the Cost metric, tokens for the Tokens / Total Tokens metrics.
                // "Custom…" reveals a field for an exact amount.
                if store.isTokenMetric {
                    Picker("Daily budget", selection: Binding(
                        get: { tokenCustom ? -1.0 : store.dailyTokenBudget },
                        set: { sel in
                            if sel < 0 {
                                tokenCustom = true
                                tokenText = store.dailyTokenBudget > 0 ? trimNumber(store.dailyTokenBudget / 1_000_000) : ""
                            } else {
                                tokenCustom = false
                                store.dailyTokenBudget = sel
                            }
                        }
                    )) {
                        Text("Off").tag(0.0)
                        Text("1M").tag(1_000_000.0)
                        Text("5M").tag(5_000_000.0)
                        Text("10M").tag(10_000_000.0)
                        Text("25M").tag(25_000_000.0)
                        Text("50M").tag(50_000_000.0)
                        Text("100M").tag(100_000_000.0)
                        Text("Custom…").tag(-1.0)
                    }
                    if tokenCustom {
                        HStack {
                            TextField("Amount", text: $tokenText)
                                .multilineTextAlignment(.trailing)
                                .onSubmit { applyTokenBudget() }
                                .onChange(of: tokenText) { _, _ in applyTokenBudget() }
                            Text("M tokens").foregroundStyle(.secondary)
                        }
                    }
                } else {
                    Picker("Daily budget", selection: Binding(
                        get: { costCustom ? -1.0 : store.dailyBudget },
                        set: { sel in
                            if sel < 0 {
                                costCustom = true
                                costText = store.dailyBudget > 0 ? trimNumber(store.dailyBudget) : ""
                            } else {
                                costCustom = false
                                store.dailyBudget = sel
                            }
                        }
                    )) {
                        Text("Off").tag(0.0)
                        Text("$25").tag(25.0)
                        Text("$50").tag(50.0)
                        Text("$100").tag(100.0)
                        Text("$200").tag(200.0)
                        Text("$500").tag(500.0)
                        Text("Custom…").tag(-1.0)
                    }
                    if costCustom {
                        HStack {
                            Text("$").foregroundStyle(.secondary)
                            TextField("Amount", text: $costText)
                                .multilineTextAlignment(.trailing)
                                .onSubmit { applyCostBudget() }
                                .onChange(of: costText) { _, _ in applyCostBudget() }
                        }
                    }
                }
                Text(alertHelpText)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
            .onAppear {
                costCustom = store.dailyBudget > 0 && !costPresets.contains(store.dailyBudget)
                if costCustom { costText = trimNumber(store.dailyBudget) }
                tokenCustom = store.dailyTokenBudget > 0 && !tokenPresets.contains(store.dailyTokenBudget)
                if tokenCustom { tokenText = trimNumber(store.dailyTokenBudget / 1_000_000) }
            }
        }
        .formStyle(.grouped)
        .padding()
    }

    private func applyCurrency(code: String) {
        let symbol = CurrencyState.symbolForCode(code)
        Task {
            let cached = await FXRateCache.shared.cachedRate(for: code)
            if let cached {
                store.currency = code
                CurrencyState.shared.apply(code: code, rate: cached, symbol: symbol)
            }
            let fresh = await FXRateCache.shared.rate(for: code)
            store.currency = code
            CurrencyState.shared.apply(code: code, rate: fresh ?? cached, symbol: symbol)
        }
        CLICurrencyConfig.persist(code: code)
    }
}

// MARK: - Claude

private struct ClaudeSettingsTab: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        Form {
            Section("Connection") {
                ClaudeConnectionRow()
            }
            Section {
                ClaudeConfigDirsSection()
            } header: {
                Text("Config Directories")
            } footer: {
                Text("Aggregate usage across multiple Claude config directories (e.g. work and personal accounts). Leave empty to track just the default `~/.claude`. The `CLAUDE_CONFIG_DIRS` environment variable, if set, overrides this list.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
            Section("Quota Refresh") {
                Picker("Update every", selection: Binding(
                    get: { SubscriptionRefreshCadence.current },
                    set: { SubscriptionRefreshCadence.current = $0 }
                )) {
                    ForEach(SubscriptionRefreshCadence.allCases) { cadence in
                        Text(cadence.label).tag(cadence)
                    }
                }
                .pickerStyle(.menu)
                Text("Anthropic rate-limits this endpoint per account. 2 minutes is plenty for the 5-hour and weekly windows; pick Manual if you only want updates on demand.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                Button("Refresh Now") {
                    if let delegate = NSApp.delegate as? AppDelegate {
                        delegate.refreshSubscriptionNow()
                    } else {
                        Task { await store.refreshSubscription() }
                    }
                }
            }
        }
        .formStyle(.grouped)
        .padding()
    }
}

private struct ClaudeConnectionRow: View {
    @Environment(AppStore.self) private var store
    @State private var showDisconnectConfirm = false

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: stateIcon)
                .font(.system(size: 18))
                .foregroundStyle(stateTint)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(stateTitle)
                    .font(.system(size: 12, weight: .semibold))
                Text(stateDetail)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer()
            actionButton
        }
        .padding(.vertical, 4)
    }

    private var stateIcon: String {
        switch store.subscriptionLoadState {
        case .loaded: return "checkmark.circle.fill"
        case .terminalFailure: return "exclamationmark.triangle.fill"
        case .transientFailure: return "clock.arrow.circlepath"
        case .bootstrapping, .loading: return "ellipsis.circle"
        case .notBootstrapped, .dormant, .noCredentials: return "link.circle"
        case .failed: return "xmark.circle"
        }
    }

    private var stateTint: Color {
        switch store.subscriptionLoadState {
        case .loaded: return .green
        case .terminalFailure, .failed: return .red
        case .transientFailure: return .orange
        default: return .secondary
        }
    }

    private var stateTitle: String {
        switch store.subscriptionLoadState {
        case .loaded: return "Connected"
        case let .terminalFailure(reason): return reason ?? "Reconnect required"
        case .transientFailure: return "Backing off"
        case .bootstrapping: return "Connecting…"
        case .loading: return "Refreshing…"
        case .dormant: return "Ready"
        case .notBootstrapped, .noCredentials: return "Not connected"
        case .failed: return "Couldn't load plan data"
        }
    }

    private var stateDetail: String {
        switch store.subscriptionLoadState {
        case .loaded:
            if let tier = store.subscription?.tier.displayName {
                return "Plan: \(tier)"
            }
            return "Live quota tracked from Anthropic."
        case .terminalFailure: return "Open Claude Code in your terminal and type `/login`, then click Reconnect."
        case .transientFailure: return store.subscriptionError ?? "Anthropic rate-limited; auto-retrying."
        case .bootstrapping: return "macOS may ask permission to read your credentials."
        case .loading: return "Background refresh in progress."
        case .dormant: return "Tap Load Quota to fetch live usage from Anthropic."
        case .notBootstrapped, .noCredentials: return "Click Connect to read your Claude Code credentials and start tracking quota."
        case .failed: return store.subscriptionError ?? ""
        }
    }

    @ViewBuilder
    private var actionButton: some View {
        switch store.subscriptionLoadState {
        case .loaded, .transientFailure, .loading:
            Button("Disconnect") { showDisconnectConfirm = true }
                .confirmationDialog(
                    "Disconnect Claude?",
                    isPresented: $showDisconnectConfirm
                ) {
                    Button("Disconnect", role: .destructive) {
                        store.disconnectSubscription()
                    }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("CodeBurn will stop tracking quota and delete its local copy of your Claude credentials. Your Claude Code keychain entry is untouched. Claude Code keeps working.")
                }
        case .terminalFailure, .noCredentials, .failed:
            Button("Reconnect") { Task { await store.bootstrapSubscription() } }
                .buttonStyle(.borderedProminent)
        case .dormant:
            Button("Load Quota") { Task { await store.activateClaudeFromDormant() } }
                .buttonStyle(.borderedProminent)
        case .notBootstrapped:
            Button("Connect") { Task { await store.bootstrapSubscription() } }
                .buttonStyle(.borderedProminent)
        case .bootstrapping:
            ProgressView().controlSize(.small)
        }
    }
}

// MARK: - Claude config directories

private struct ClaudeConfigDirsSection: View {
    @Environment(AppStore.self) private var store
    @State private var dirs: [String] = CLIClaudeConfig.load()

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if dirs.isEmpty {
                Text("No extra directories. Tracking the default `~/.claude`.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            } else {
                ForEach(Array(dirs.enumerated()), id: \.offset) { index, dir in
                    HStack(spacing: 8) {
                        Image(systemName: "folder")
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                        Text(dir)
                            .font(.system(size: 12))
                            .truncationMode(.middle)
                            .lineLimit(1)
                            .help(dir)
                        Spacer()
                        Button {
                            remove(at: index)
                        } label: {
                            Image(systemName: "minus.circle.fill")
                                .foregroundStyle(.secondary)
                        }
                        .buttonStyle(.plain)
                        .help("Remove")
                    }
                }
            }

            Button {
                addDirectory()
            } label: {
                Label("Add Directory…", systemImage: "plus")
            }
            .controlSize(.small)
        }
        .padding(.vertical, 2)
    }

    private func addDirectory() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = true
        panel.prompt = "Add"
        panel.message = "Choose one or more Claude config directories (each containing a `projects` folder)."
        guard panel.runModal() == .OK else { return }

        let added = panel.urls.map { $0.path }
        var next = dirs
        for path in added where !next.contains(path) {
            next.append(path)
        }
        apply(next)
    }

    private func remove(at index: Int) {
        guard dirs.indices.contains(index) else { return }
        var next = dirs
        next.remove(at: index)
        apply(next)
    }

    /// Persists the new list and kicks a forced refresh so the dashboard
    /// reflects the changed aggregation immediately.
    private func apply(_ next: [String]) {
        dirs = next
        CLIClaudeConfig.persist(dirs: next)
        Task { await store.refresh(includeOptimize: false, force: true, showLoading: true) }
    }
}

// MARK: - Codex

private struct CodexSettingsTab: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        Form {
            Section("Connection") {
                CodexConnectionRow()
            }
            Section {
                Text("Codex live-quota tracking reads `~/.codex/auth.json` once on Connect, then keeps a CodeBurn-owned copy in your login Keychain instead of a world-readable file, so subsequent quota fetches don't re-read the original. The item is reachable by programs running as you, the same as any login-Keychain entry. Only ChatGPT-mode auth (Plus / Pro / Team / Business / Edu / Enterprise) is supported. API-key users are billed per request and have a different reporting surface. Credit-metered workspaces report no rate-limit windows, so their monthly credit allowance is shown instead.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            } header: {
                Text("How it works")
            }
        }
        .formStyle(.grouped)
        .padding()
    }
}

private struct CodexConnectionRow: View {
    @Environment(AppStore.self) private var store
    @State private var showDisconnectConfirm = false

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: stateIcon)
                .font(.system(size: 18))
                .foregroundStyle(stateTint)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(stateTitle)
                    .font(.system(size: 12, weight: .semibold))
                Text(stateDetail)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer()
            actionButton
        }
        .padding(.vertical, 4)
    }

    private var stateIcon: String {
        switch store.codexLoadState {
        case .loaded: return "checkmark.circle.fill"
        case .terminalFailure: return "exclamationmark.triangle.fill"
        case .transientFailure: return "clock.arrow.circlepath"
        case .bootstrapping, .loading: return "ellipsis.circle"
        case .notBootstrapped, .dormant, .noCredentials: return "link.circle"
        case .failed: return "xmark.circle"
        }
    }

    private var stateTint: Color {
        switch store.codexLoadState {
        case .loaded: return .green
        case .terminalFailure, .failed: return .red
        case .transientFailure: return .orange
        default: return .secondary
        }
    }

    private var stateTitle: String {
        switch store.codexLoadState {
        case .loaded: return "Connected"
        case let .terminalFailure(reason): return reason ?? "Reconnect required"
        case .transientFailure: return "Backing off"
        case .bootstrapping: return "Connecting…"
        case .loading: return "Refreshing…"
        case .dormant: return "Ready"
        case .notBootstrapped, .noCredentials: return "Not connected"
        case .failed: return "Couldn't load Codex quota"
        }
    }

    private var stateDetail: String {
        switch store.codexLoadState {
        case .loaded:
            if let plan = store.codexUsage?.plan.displayName {
                return "Plan: \(plan)"
            }
            return "Live quota tracked from chatgpt.com."
        case .terminalFailure:
            // Be specific about the cause: the message we already surface in
            // codexError will say "API-key mode" if that's the situation, so
            // the generic "run codex login" hint covers both cases.
            if let err = store.codexError, err.lowercased().contains("api-key") {
                return "Codex is in API-key mode. Run `codex login` and choose a ChatGPT plan to enable quota tracking."
            }
            return "Run `codex login` in your terminal to sign in again, then click Reconnect."
        case .transientFailure: return store.codexError ?? "ChatGPT rate-limited; auto-retrying."
        case .bootstrapping: return "Reading ~/.codex/auth.json."
        case .loading: return "Background refresh in progress."
        case .dormant: return "Tap Load Quota to fetch live usage from chatgpt.com."
        case .notBootstrapped, .noCredentials:
            return "Click Connect to read your Codex CLI credentials. If Connect fails, run `codex login` in your terminal first to create ~/.codex/auth.json."
        case .failed: return store.codexError ?? ""
        }
    }

    @ViewBuilder
    private var actionButton: some View {
        switch store.codexLoadState {
        case .loaded, .transientFailure, .loading:
            Button("Disconnect") { showDisconnectConfirm = true }
                .confirmationDialog(
                    "Disconnect Codex?",
                    isPresented: $showDisconnectConfirm
                ) {
                    Button("Disconnect", role: .destructive) {
                        store.disconnectCodex()
                    }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("CodeBurn will stop tracking quota and delete its local copy of your Codex credentials. Your ~/.codex/auth.json is untouched. Codex CLI keeps working.")
                }
        case .terminalFailure, .noCredentials, .failed:
            Button("Reconnect") { Task { await store.bootstrapCodex() } }
                .buttonStyle(.borderedProminent)
        case .dormant:
            Button("Load Quota") { Task { await store.activateCodexFromDormant() } }
                .buttonStyle(.borderedProminent)
        case .notBootstrapped:
            Button("Connect") { Task { await store.bootstrapCodex() } }
                .buttonStyle(.borderedProminent)
        case .bootstrapping:
            ProgressView().controlSize(.small)
        }
    }
}

// MARK: - Kimi Code

private struct KimiSettingsTab: View {
    var body: some View {
        Form {
            Section("Connection") {
                KimiConnectionRow()
            }
            Section {
                Text("Kimi Code live-quota tracking reads `~/.kimi-code/credentials/kimi-code.json` directly. Nothing is copied or stored. Access tokens are short-lived (~15 minutes) and only the Kimi CLI refreshes them, so if the connection shows as expired, run the Kimi CLI once and click Reconnect.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            } header: {
                Text("How it works")
            }
        }
        .formStyle(.grouped)
        .padding()
    }
}

private struct KimiConnectionRow: View {
    @Environment(AppStore.self) private var store
    @State private var showDisconnectConfirm = false

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: stateIcon)
                .font(.system(size: 18))
                .foregroundStyle(stateTint)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(stateTitle)
                    .font(.system(size: 12, weight: .semibold))
                Text(stateDetail)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer()
            actionButton
        }
        .padding(.vertical, 4)
    }

    private var stateIcon: String {
        switch store.kimiLoadState {
        case .loaded: return "checkmark.circle.fill"
        case .terminalFailure: return "exclamationmark.triangle.fill"
        case .transientFailure: return "clock.arrow.circlepath"
        case .bootstrapping, .loading: return "ellipsis.circle"
        case .notBootstrapped, .dormant, .noCredentials: return "link.circle"
        case .failed: return "xmark.circle"
        }
    }

    private var stateTint: Color {
        switch store.kimiLoadState {
        case .loaded: return .green
        case .terminalFailure, .failed: return .red
        case .transientFailure: return .orange
        default: return .secondary
        }
    }

    private var stateTitle: String {
        switch store.kimiLoadState {
        case .loaded: return "Connected"
        case let .terminalFailure(reason): return reason ?? "Login refresh required"
        case .transientFailure: return "Backing off"
        case .bootstrapping: return "Connecting…"
        case .loading: return "Refreshing…"
        case .dormant: return "Ready"
        case .notBootstrapped, .noCredentials: return "Not connected"
        case .failed: return "Couldn't load Kimi quota"
        }
    }

    private var stateDetail: String {
        switch store.kimiLoadState {
        case .loaded:
            return "Live quota tracked from api.kimi.com."
        case .terminalFailure:
            return "Run the Kimi CLI once to refresh your login, then click Reconnect."
        case .transientFailure: return store.kimiError ?? "Kimi rate-limited; auto-retrying."
        case .bootstrapping: return "Reading ~/.kimi-code credentials."
        case .loading: return "Background refresh in progress."
        case .dormant: return "Tap Load Quota to fetch live usage from api.kimi.com."
        case .notBootstrapped, .noCredentials:
            return "Sign in with the Kimi CLI first, then click Connect."
        case .failed: return store.kimiError ?? ""
        }
    }

    @ViewBuilder
    private var actionButton: some View {
        switch store.kimiLoadState {
        case .loaded, .transientFailure, .loading:
            Button("Disconnect") { showDisconnectConfirm = true }
                .confirmationDialog(
                    "Disconnect Kimi Code?",
                    isPresented: $showDisconnectConfirm
                ) {
                    Button("Disconnect", role: .destructive) {
                        store.disconnectKimi()
                    }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("CodeBurn will stop tracking Kimi Code quota. Your ~/.kimi-code credentials are untouched. The Kimi CLI keeps working.")
                }
        case .terminalFailure, .noCredentials, .failed:
            Button("Reconnect") { Task { await store.bootstrapKimi() } }
                .buttonStyle(.borderedProminent)
        case .dormant:
            Button("Load Quota") { Task { await store.bootstrapKimi() } }
                .buttonStyle(.borderedProminent)
        case .notBootstrapped:
            Button("Connect") { Task { await store.bootstrapKimi() } }
                .buttonStyle(.borderedProminent)
        case .bootstrapping:
            ProgressView().controlSize(.small)
        }
    }
}

// MARK: - Gemini

private struct GeminiSettingsTab: View {
    var body: some View {
        Form {
            Section("Connection") {
                GeminiConnectionRow()
            }
            Section {
                Text("Gemini live-quota tracking reads `~/.gemini/oauth_creds.json` read-only. Nothing is copied or stored, and tokens stay in memory. If the connection shows as expired, run the Gemini CLI once to refresh your login, then click Reconnect.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            } header: {
                Text("How it works")
            }
        }
        .formStyle(.grouped)
        .padding()
    }
}

private struct GeminiConnectionRow: View {
    @Environment(AppStore.self) private var store
    @State private var showDisconnectConfirm = false

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: stateIcon)
                .font(.system(size: 18))
                .foregroundStyle(stateTint)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(stateTitle)
                    .font(.system(size: 12, weight: .semibold))
                Text(stateDetail)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer()
            actionButton
        }
        .padding(.vertical, 4)
    }

    private var stateIcon: String {
        switch store.geminiLoadState {
        case .loaded: return "checkmark.circle.fill"
        case .terminalFailure: return "exclamationmark.triangle.fill"
        case .transientFailure: return "clock.arrow.circlepath"
        case .bootstrapping, .loading: return "ellipsis.circle"
        case .notBootstrapped, .dormant, .noCredentials: return "link.circle"
        case .failed: return "xmark.circle"
        }
    }

    private var stateTint: Color {
        switch store.geminiLoadState {
        case .loaded: return .green
        case .terminalFailure, .failed: return .red
        case .transientFailure: return .orange
        default: return .secondary
        }
    }

    private var stateTitle: String {
        switch store.geminiLoadState {
        case .loaded: return "Connected"
        case let .terminalFailure(reason): return reason ?? "Login refresh required"
        case .transientFailure: return "Backing off"
        case .bootstrapping: return "Connecting…"
        case .loading: return "Refreshing…"
        case .dormant: return "Ready"
        case .notBootstrapped, .noCredentials: return "Not connected"
        case .failed: return "Couldn't load Gemini quota"
        }
    }

    private var stateDetail: String {
        switch store.geminiLoadState {
        case .loaded:
            if let plan = store.geminiUsage?.plan {
                return "Plan: \(plan)"
            }
            return "Live quota tracked from Google Code Assist."
        case .terminalFailure:
            return "Run the Gemini CLI once to refresh your login, then click Reconnect."
        case .transientFailure: return store.geminiError ?? "Gemini rate-limited; auto-retrying."
        case .bootstrapping: return "Reading ~/.gemini credentials."
        case .loading: return "Background refresh in progress."
        case .dormant: return "Tap Load Quota to fetch live usage from Google Code Assist."
        case .notBootstrapped, .noCredentials:
            return "Sign in with the Gemini CLI first, then click Connect."
        case .failed: return store.geminiError ?? ""
        }
    }

    @ViewBuilder
    private var actionButton: some View {
        switch store.geminiLoadState {
        case .loaded, .transientFailure, .loading:
            Button("Disconnect") { showDisconnectConfirm = true }
                .confirmationDialog(
                    "Disconnect Gemini?",
                    isPresented: $showDisconnectConfirm
                ) {
                    Button("Disconnect", role: .destructive) {
                        store.disconnectGemini()
                    }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("CodeBurn will stop tracking Gemini quota. Your ~/.gemini credentials are untouched. The Gemini CLI keeps working.")
                }
        case .terminalFailure, .noCredentials, .failed:
            Button("Reconnect") { Task { await store.bootstrapGemini() } }
                .buttonStyle(.borderedProminent)
        case .dormant:
            Button("Load Quota") { Task { await store.bootstrapGemini() } }
                .buttonStyle(.borderedProminent)
        case .notBootstrapped:
            Button("Connect") { Task { await store.bootstrapGemini() } }
                .buttonStyle(.borderedProminent)
        case .bootstrapping:
            ProgressView().controlSize(.small)
        }
    }
}

// MARK: - Copilot

private struct CopilotSettingsTab: View {
    var body: some View {
        Form {
            Section("Connection") {
                CopilotConnectionRow()
            }
            Section {
                Text("Copilot live-quota tracking reads the GitHub Copilot editor sign-in token from `~/.config/github-copilot` read-only. Nothing is copied or stored. Sign in via an editor's Copilot plugin (VS Code, Xcode, etc.) first; if the connection shows as expired, sign in there again, then click Reconnect.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            } header: {
                Text("How it works")
            }
        }
        .formStyle(.grouped)
        .padding()
    }
}

private struct CopilotConnectionRow: View {
    @Environment(AppStore.self) private var store
    @State private var showDisconnectConfirm = false

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: stateIcon)
                .font(.system(size: 18))
                .foregroundStyle(stateTint)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(stateTitle)
                    .font(.system(size: 12, weight: .semibold))
                Text(stateDetail)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer()
            actionButton
        }
        .padding(.vertical, 4)
    }

    private var stateIcon: String {
        switch store.copilotLoadState {
        case .loaded: return "checkmark.circle.fill"
        case .terminalFailure: return "exclamationmark.triangle.fill"
        case .transientFailure: return "clock.arrow.circlepath"
        case .bootstrapping, .loading: return "ellipsis.circle"
        case .notBootstrapped, .dormant, .noCredentials: return "link.circle"
        case .failed: return "xmark.circle"
        }
    }

    private var stateTint: Color {
        switch store.copilotLoadState {
        case .loaded: return .green
        case .terminalFailure, .failed: return .red
        case .transientFailure: return .orange
        default: return .secondary
        }
    }

    private var stateTitle: String {
        switch store.copilotLoadState {
        case .loaded: return "Connected"
        case let .terminalFailure(reason): return reason ?? "Login refresh required"
        case .transientFailure: return "Backing off"
        case .bootstrapping: return "Connecting…"
        case .loading: return "Refreshing…"
        case .dormant: return "Ready"
        case .notBootstrapped, .noCredentials: return "Not connected"
        case .failed: return "Couldn't load Copilot quota"
        }
    }

    private var stateDetail: String {
        switch store.copilotLoadState {
        case .loaded:
            if let plan = store.copilotUsage?.plan {
                return "Plan: \(plan)"
            }
            return "Live quota tracked from api.github.com."
        case .terminalFailure:
            return "Sign in via an editor's Copilot plugin to refresh your login, then click Reconnect."
        case .transientFailure: return store.copilotError ?? "GitHub rate-limited; auto-retrying."
        case .bootstrapping: return "Reading ~/.config/github-copilot credentials."
        case .loading: return "Background refresh in progress."
        case .dormant: return "Tap Load Quota to fetch live usage from api.github.com."
        case .notBootstrapped, .noCredentials:
            return "Sign in via an editor's Copilot plugin first, then click Connect."
        case .failed: return store.copilotError ?? ""
        }
    }

    @ViewBuilder
    private var actionButton: some View {
        switch store.copilotLoadState {
        case .loaded, .transientFailure, .loading:
            Button("Disconnect") { showDisconnectConfirm = true }
                .confirmationDialog(
                    "Disconnect Copilot?",
                    isPresented: $showDisconnectConfirm
                ) {
                    Button("Disconnect", role: .destructive) {
                        store.disconnectCopilot()
                    }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("CodeBurn will stop tracking Copilot quota. Your ~/.config/github-copilot credentials are untouched. Your editor's Copilot plugin keeps working.")
                }
        case .terminalFailure, .noCredentials, .failed:
            Button("Reconnect") { Task { await store.bootstrapCopilot() } }
                .buttonStyle(.borderedProminent)
        case .dormant:
            Button("Load Quota") { Task { await store.bootstrapCopilot() } }
                .buttonStyle(.borderedProminent)
        case .notBootstrapped:
            Button("Connect") { Task { await store.bootstrapCopilot() } }
                .buttonStyle(.borderedProminent)
        case .bootstrapping:
            ProgressView().controlSize(.small)
        }
    }
}

// MARK: - Antigravity

private struct AntigravitySettingsTab: View {
    var body: some View {
        Form {
            Section("Connection") {
                AntigravityConnectionRow()
            }
            Section {
                Text("Antigravity live-quota tracking talks to the Antigravity app's local language server on 127.0.0.1 only. Nothing leaves the machine and no credential files are read. If it shows as disconnected, start the Antigravity app, then click Reconnect.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            } header: {
                Text("How it works")
            }
        }
        .formStyle(.grouped)
        .padding()
    }
}

private struct AntigravityConnectionRow: View {
    @Environment(AppStore.self) private var store
    @State private var showDisconnectConfirm = false

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: stateIcon)
                .font(.system(size: 18))
                .foregroundStyle(stateTint)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(stateTitle)
                    .font(.system(size: 12, weight: .semibold))
                Text(stateDetail)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer()
            actionButton
        }
        .padding(.vertical, 4)
    }

    private var stateIcon: String {
        switch store.antigravityLoadState {
        case .loaded: return "checkmark.circle.fill"
        case .terminalFailure: return "exclamationmark.triangle.fill"
        case .transientFailure: return "clock.arrow.circlepath"
        case .bootstrapping, .loading: return "ellipsis.circle"
        case .notBootstrapped, .dormant, .noCredentials: return "link.circle"
        case .failed: return "xmark.circle"
        }
    }

    private var stateTint: Color {
        switch store.antigravityLoadState {
        case .loaded: return .green
        case .terminalFailure, .failed: return .red
        case .transientFailure: return .orange
        default: return .secondary
        }
    }

    private var stateTitle: String {
        switch store.antigravityLoadState {
        case .loaded: return "Connected"
        case let .terminalFailure(reason): return reason ?? "Reconnect required"
        case .transientFailure: return "Backing off"
        case .bootstrapping: return "Connecting…"
        case .loading: return "Refreshing…"
        case .dormant: return "Ready"
        case .notBootstrapped, .noCredentials: return "Not connected"
        case .failed: return "Couldn't load Antigravity quota"
        }
    }

    private var stateDetail: String {
        switch store.antigravityLoadState {
        case .loaded:
            if let plan = store.antigravityUsage?.plan {
                return "Plan: \(plan)"
            }
            return "Live quota tracked from the local Antigravity server."
        case .terminalFailure:
            return "Start the Antigravity app, then click Reconnect."
        case .transientFailure: return store.antigravityError ?? "Local probe failed; auto-retrying."
        case .bootstrapping: return "Probing the local Antigravity language server."
        case .loading: return "Background refresh in progress."
        case .dormant: return "Tap Load Quota to probe the local Antigravity server."
        case .notBootstrapped:
            return "Start the Antigravity app first, then click Connect."
        case .noCredentials:
            return "No local Antigravity server found. Start the Antigravity app, then click Reconnect."
        case .failed: return store.antigravityError ?? ""
        }
    }

    @ViewBuilder
    private var actionButton: some View {
        switch store.antigravityLoadState {
        case .loaded, .transientFailure, .loading:
            Button("Disconnect") { showDisconnectConfirm = true }
                .confirmationDialog(
                    "Disconnect Antigravity?",
                    isPresented: $showDisconnectConfirm
                ) {
                    Button("Disconnect", role: .destructive) {
                        store.disconnectAntigravity()
                    }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("CodeBurn will stop tracking Antigravity quota. Nothing is read from or written to disk. The Antigravity app keeps working.")
                }
        case .terminalFailure, .noCredentials, .failed:
            Button("Reconnect") { Task { await store.bootstrapAntigravity() } }
                .buttonStyle(.borderedProminent)
        case .dormant:
            Button("Load Quota") { Task { await store.bootstrapAntigravity() } }
                .buttonStyle(.borderedProminent)
        case .notBootstrapped:
            Button("Connect") { Task { await store.bootstrapAntigravity() } }
                .buttonStyle(.borderedProminent)
        case .bootstrapping:
            ProgressView().controlSize(.small)
        }
    }
}

// MARK: - Devin

private struct DevinSettingsTab: View {
    @State private var rateText: String = ""
    @State private var statusText: String = ""

    private var parsedRate: Double? {
        let trimmed = rateText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let value = Double(trimmed), value.isFinite, value > 0 else { return nil }
        return value
    }

    var body: some View {
        Form {
            Section("ACU Conversion") {
                HStack(alignment: .center, spacing: 10) {
                    Text("USD per ACU")
                    Spacer()
                    TextField("", text: $rateText)
                        .textFieldStyle(.roundedBorder)
                        .multilineTextAlignment(.trailing)
                        .frame(width: 96)
                        .accessibilityLabel("USD per ACU")
                    Text("USD")
                        .foregroundStyle(.secondary)
                        .frame(width: 36, alignment: .leading)
                }

                Button("Save") {
                    saveRate()
                }
                .buttonStyle(.borderedProminent)
                .disabled(parsedRate == nil)

                if !statusText.isEmpty {
                    Text(statusText)
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                }
            }

            Section {
                Text("CodeBurn reads Devin ACU usage from local transcripts only after this rate is configured, then multiplies each step by the rate before reporting cost.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            } header: {
                Text("How it works")
            }
        }
        .formStyle(.grouped)
        .padding()
        .onAppear {
            if let rate = CLIDevinConfig.loadAcuUsdRate() {
                rateText = Self.format(rate)
            }
        }
    }

    private func saveRate() {
        guard let rate = parsedRate else { return }
        CLIDevinConfig.persistAcuUsdRate(rate)
        rateText = Self.format(rate)
        statusText = "Saved. Refresh CodeBurn to recalculate Devin cost."
    }

    private static func format(_ value: Double) -> String {
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.numberStyle = .decimal
        formatter.minimumFractionDigits = 0
        formatter.maximumFractionDigits = 6
        return formatter.string(from: NSNumber(value: value)) ?? String(value)
    }
}

// MARK: - About

private struct AboutSettingsTab: View {
    @Environment(UpdateChecker.self) private var updateChecker

    private var versionString: String {
        let version = AppVersion.normalizedBundleShortVersion
        let build = AppVersion.normalizedBundleBuildVersion
        return build == version ? version : "\(version) (\(build))"
    }

    var body: some View {
        Form {
            Section {
                hero
                    .frame(maxWidth: .infinity)
                    .listRowBackground(Color.clear)
            }

            Section {
                LabeledContent("Version \(versionString)") {
                    Button("Check for Updates") {
                        Task { await updateChecker.check() }
                    }
                }
                if let error = updateChecker.updateError {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                } else if updateChecker.updateAvailable, let latest = updateChecker.latestVersion {
                    Text("\(AppVersion.display(latest)) is available. Choose Check for Updates in the CodeBurn menu to install it.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            } header: {
                Text("Updates")
            }

            Section {
                AboutLinkRow(
                    icon: "chevron.left.slash.chevron.right",
                    title: "GitHub",
                    url: "https://github.com/getagentseal/codeburn")
                AboutLinkRow(
                    icon: "globe",
                    title: "Website",
                    url: "https://codeburn.app")
                AboutLinkRow(
                    icon: "exclamationmark.bubble",
                    title: "Issues",
                    url: "https://github.com/getagentseal/codeburn/issues")
            } header: {
                Text("Links")
            } footer: {
                Text("© 2026 Resham Joshi (iamtoruk) · AgentSeal. MIT License.")
                    .frame(maxWidth: .infinity)
                    .multilineTextAlignment(.center)
            }
        }
        .formStyle(.grouped)
        .scrollContentBackground(.hidden)
    }

    private var hero: some View {
        VStack(spacing: 10) {
            if let flame = AboutFlameImage.load() {
                Image(nsImage: flame)
                    .resizable()
                    .scaledToFit()
                    .frame(width: 72, height: 72)
            } else if let icon = NSApplication.shared.applicationIconImage {
                Image(nsImage: icon)
                    .resizable()
                    .frame(width: 64, height: 64)
                    .cornerRadius(12)
            }

            VStack(spacing: 2) {
                Text("CodeBurn")
                    .font(.title3).fontWeight(.semibold)
                Text("Version \(versionString)")
                    .foregroundStyle(.secondary)
                Text("Your AI Bill, Itemized")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 6)
    }
}

private struct AboutLinkRow: View {
    let icon: String
    let title: String
    let url: String
    @State private var hovering = false

    var body: some View {
        Button {
            if let url = URL(string: self.url) { NSWorkspace.shared.open(url) }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: icon)
                    .frame(width: 18)
                    .foregroundStyle(.secondary)
                Text(title)
                    .foregroundStyle(.primary)
                Spacer()
                Image(systemName: "arrow.up.right")
                    .font(.caption)
                    .foregroundStyle(hovering ? Color.accentColor : Color.secondary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
    }
}

/// The full-color binary-flame brand mark shown in the About hero. Loaded
/// directly (not via ProviderIconCache) because it must keep its colors —
/// the cache marks everything as a template image.
@MainActor
enum AboutFlameImage {
    private static var cached: NSImage?

    static func load() -> NSImage? {
        if let cached { return cached }
        for subdirectory in ["Resources/ProviderIcons", "ProviderIcons", nil] {
            if let url = Bundle.module.url(forResource: "about-flame", withExtension: "png", subdirectory: subdirectory),
               let image = NSImage(contentsOf: url) {
                cached = image
                return image
            }
        }
        return nil
    }
}

