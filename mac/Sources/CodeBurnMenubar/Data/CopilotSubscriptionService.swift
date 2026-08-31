import Foundation

/// Live quota snapshot for a GitHub Copilot plan. The API reports per-feature
/// quota snapshots ("Premium requests", "Chat") as percent REMAINING; windows
/// render percent USED, so `usedPercent` is the inverted value. `details`
/// keeps the endpoint's order (premium first), so `primary` is the premium
/// window when present and chat otherwise.
struct CopilotUsage: Sendable, Equatable {
    struct Window: Sendable, Equatable {
        let label: String
        let usedPercent: Double   // 0.0 ... 100.0
        /// The endpoint reports no reset times — always nil.
        let resetsAt: Date?
    }

    /// Premium-requests window first, then chat; either may be absent.
    let details: [Window]
    var primary: Window? { details.first }
    /// Plan label derived from copilot_plan (Free / Individual / Pro /
    /// Business / Enterprise / Educators, unknown tiers title-cased).
    let plan: String?
    let fetchedAt: Date
}

/// Live GitHub Copilot quota via the editor plugins' internal usage endpoint
/// (derived from observed GitHub Copilot client traffic):
///
/// - GET https://api.github.com/copilot_internal/user → plan + quota snapshots
///
/// This is an INTERNAL, UNDOCUMENTED API that may drift without notice; every
/// failure must degrade to the normal connection states and never crash the
/// panel.
///
/// Credential: any GitHub token already on the machine from a signed-in
/// Copilot client. Modern clients no longer write the legacy plugin files, so
/// discovery walks an ordered chain (see `readToken`). Read-only throughout;
/// nothing is copied or written, and there is no refresh path: an expired or
/// revoked token stays dead until the user signs in again with whichever
/// client owns it.
enum CopilotSubscriptionService {
    private static let usageURL = URL(string: "https://api.github.com/copilot_internal/user")!
    private static let usageBlockedUntilKey = "codeburn.copilot.usage.blockedUntil"
    /// Capacity Dock provider id, used for the pasted-token rung.
    static let providerID = "copilot"
    /// Generic-password service the GitHub Copilot CLI 1.0 writes its OAuth
    /// token under. The account name is not published, so lookups are
    /// service-only.
    static let copilotCLIKeychainService = "copilot-cli"
    /// Honoured in the same order the Copilot CLI honours them.
    static let environmentTokenNames = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]

    enum FetchError: Error, LocalizedError {
        case noCredentials
        /// 401 where re-reading the chain yielded the same (or no) token. An
        /// active client session rotates this token, so this is transient: the
        /// next refresh picks up the rotated one from whichever source holds it.
        case tokenRejected
        case rateLimited(retryAt: Date)
        case usageHTTPError(Int)
        case usageDecodeFailed
        case network(Error)

        var errorDescription: String? {
            switch self {
            case .noCredentials:
                return "No GitHub Copilot credentials found. Usage tracking still works. "
                    + "To show live quota, sign in with the Copilot CLI, run gh auth login, "
                    + "or paste a GitHub token in Settings."
            case .tokenRejected:
                return "GitHub rejected the Copilot token found on this Mac. It will be retried once you sign in again."
            case let .rateLimited(retryAt):
                let f = RelativeDateTimeFormatter()
                f.unitsStyle = .short
                return "GitHub rate-limited the Copilot quota endpoint. Retrying \(f.localizedString(for: retryAt, relativeTo: Date()))."
            case let .usageHTTPError(code):
                return "Copilot quota fetch failed (HTTP \(code)). Sign in to Copilot again, then Reconnect."
            case .usageDecodeFailed:
                return "Copilot quota response was malformed."
            case let .network(err):
                return "Network error: \(err.localizedDescription)"
            }
        }

        var isTerminal: Bool {
            switch self {
            case .noCredentials:
                return true
            case let .usageHTTPError(code):
                return (400..<500).contains(code)
            case .tokenRejected, .rateLimited, .usageDecodeFailed, .network:
                return false
            }
        }

        var rateLimitRetryAt: Date? {
            if case let .rateLimited(retryAt) = self { return retryAt }
            return nil
        }
    }

    // MARK: - Injectable seams (tests drive fixtures through these)

    struct Deps: Sendable {
        var fetch: @Sendable (URLRequest) async throws -> (Data, HTTPURLResponse)
        /// Read-only credential file load. Never writes.
        var readFile: @Sendable (URL) -> Data?
        var hostsURL: URL
        var appsURL: URL
        /// The Copilot CLI's config directory (~/.copilot).
        var copilotDirURL: URL
        /// Raw payload of the Copilot CLI's Keychain item. Uncached: the
        /// service owns the caching so tests can drive the probe directly.
        var keychainBlob: @Sendable () -> Data?
        var environment: @Sendable (String) -> String?
        /// `gh auth token`. Uncached, for the same reason as `keychainBlob`.
        var ghAuthToken: @Sendable () -> String?
        /// Token the user pasted into CodeBurn's own Copilot settings.
        var savedToken: @Sendable () -> String?
        var now: @Sendable () -> Date

        static let live = Deps(
            fetch: { request in
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let http = response as? HTTPURLResponse else {
                    throw FetchError.usageHTTPError(-1)
                }
                return (data, http)
            },
            readFile: { url in FileManager.default.contents(atPath: url.path) },
            hostsURL: URL(fileURLWithPath: NSHomeDirectory() + "/.config/github-copilot/hosts.json"),
            appsURL: URL(fileURLWithPath: NSHomeDirectory() + "/.config/github-copilot/apps.json"),
            copilotDirURL: URL(fileURLWithPath: NSHomeDirectory() + "/.copilot"),
            keychainBlob: { readCopilotCLIKeychain() },
            environment: { ProcessInfo.processInfo.environment[$0] },
            ghAuthToken: { runGhAuthToken() },
            savedToken: { savedCopilotToken() },
            now: { Date() }
        )
    }

    // MARK: - Credential discovery

    /// Cheap eligibility answer for the dock and the initial load state. It
    /// must never spawn a subprocess, so the two subprocess rungs are
    /// approximated: an existing ~/.copilot directory stands in for the
    /// Copilot CLI, and an installed `gh` binary stands in for a `gh` login.
    /// A false positive costs one probe inside `refresh`; a false negative
    /// would silently never try at all.
    static var hasCredential: Bool {
        let deps = Deps.live
        let manager = FileManager.default
        for url in [deps.hostsURL, deps.appsURL, deps.copilotDirURL]
        where manager.fileExists(atPath: url.path) {
            return true
        }
        if environmentTokenNames.contains(where: { nonEmpty(deps.environment($0)) != nil }) { return true }
        if CapacityDockProviderCredentialPresence.contains(providerID) { return true }
        return ghExecutableURL() != nil
    }

    /// Ordered, read-only credential chain; the first rung that yields a token
    /// wins and every rung tolerates absent or malformed data:
    ///
    /// 1. legacy editor-plugin files: `hosts.json` then `apps.json`
    /// 2. the Copilot CLI's Keychain item (service `copilot-cli`)
    /// 3. `~/.copilot/config.json` then `~/.copilot/settings.json`
    /// 4. `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`
    /// 5. `gh auth token`
    /// 6. a token pasted into CodeBurn's Copilot settings
    static func readToken(deps: Deps) -> String? {
        for url in [deps.hostsURL, deps.appsURL] {
            if let data = deps.readFile(url), let token = tokenFromMap(data) { return token }
        }
        if let token = cachedProbe("keychain", deps: deps, probe: {
            deps.keychainBlob().flatMap(tokenFromBlob)
        }) { return token }
        for name in ["config.json", "settings.json"] {
            if let data = deps.readFile(deps.copilotDirURL.appendingPathComponent(name)),
               let token = tokenFromBlob(data) { return token }
        }
        for name in environmentTokenNames {
            if let token = nonEmpty(deps.environment(name)) { return token }
        }
        if let token = cachedProbe("gh", deps: deps, probe: {
            nonEmpty(deps.ghAuthToken())
        }) { return token }
        return nonEmpty(deps.savedToken())
    }

    /// hosts.json keys by host — prefer github.com; apps.json has no
    /// canonical key, so its first entry wins. Both store the token as
    /// `oauth_token`.
    private static func tokenFromMap(_ data: Data) -> String? {
        guard let map = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        let preferred = map["github.com"] ?? map.values.first
        guard let token = (preferred as? [String: Any])?["oauth_token"] as? String, !token.isEmpty else { return nil }
        return token
    }

    /// GitHub access-token prefixes. `ghr_` (refresh) is deliberately absent:
    /// the usage endpoint rejects it.
    private static let tokenPrefixes = ["gho_", "ghu_", "ghp_", "ghs_", "github_pat_"]

    static func looksLikeGitHubToken(_ value: String) -> Bool {
        tokenPrefixes.contains { value.hasPrefix($0) && value.count > $0.count }
    }

    /// The Copilot CLI's Keychain payload and its ~/.copilot JSON are both
    /// undocumented: the Keychain value may be the bare token or a JSON
    /// envelope, and the JSON key holding the token has moved between
    /// releases. Rather than guess key names, take the first value carrying a
    /// GitHub access-token prefix.
    private static func tokenFromBlob(_ data: Data) -> String? {
        if let text = nonEmpty(String(data: data, encoding: .utf8)), looksLikeGitHubToken(text) {
            return text
        }
        guard let json = try? JSONSerialization.jsonObject(with: data) else { return nil }
        return firstGitHubToken(in: json)
    }

    /// Dictionary keys are visited in sorted order so the pick stays stable
    /// when more than one field qualifies.
    private static func firstGitHubToken(in value: Any) -> String? {
        switch value {
        case let text as String:
            return looksLikeGitHubToken(text) ? text : nil
        case let array as [Any]:
            return array.lazy.compactMap { firstGitHubToken(in: $0) }.first
        case let map as [String: Any]:
            return map.keys.sorted().lazy.compactMap { firstGitHubToken(in: map[$0] as Any) }.first
        default:
            return nil
        }
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
            return nil
        }
        return trimmed
    }

    // MARK: - Subprocess probes

    /// `security` and `gh` each cost a process spawn, and the panel re-checks
    /// eligibility and refreshes far more often than a login changes, so both
    /// answers are reused for this long.
    static let probeCacheTTL: TimeInterval = 5 * 60

    private final class ProbeCache: @unchecked Sendable {
        private let lock = NSLock()
        private var entries: [String: (value: String?, at: Date)] = [:]

        func value(_ key: String, now: Date, ttl: TimeInterval, probe: () -> String?) -> String? {
            lock.lock()
            defer { lock.unlock() }
            if let entry = entries[key], now.timeIntervalSince(entry.at) < ttl {
                return entry.value
            }
            let value = probe()
            entries[key] = (value, now)
            return value
        }

        func reset() {
            lock.lock()
            defer { lock.unlock() }
            entries.removeAll()
        }
    }

    private static let probeCache = ProbeCache()

    private static func cachedProbe(
        _ key: String,
        deps: Deps,
        probe: () -> String?
    ) -> String? {
        probeCache.value(key, now: deps.now(), ttl: probeCacheTTL, probe: probe)
    }

    /// Drops the cached `security` / `gh` answers so the next read re-probes.
    static func resetProbeCache() {
        probeCache.reset()
    }

    /// `Process` is not Sendable; the watchdog only calls `terminate()`, which
    /// is safe from another thread.
    private final class ProcessBox: @unchecked Sendable {
        let process: Process
        init(_ process: Process) { self.process = process }
    }

    /// Runs a short-lived command and returns trimmed stdout, or nil on any
    /// failure. stdin is /dev/null so a child can never block on a prompt, and
    /// the deadline guarantees the caller's refresh cannot wedge.
    private static func runCapturingStdout(
        _ executable: URL,
        _ arguments: [String],
        timeout: TimeInterval = 5
    ) -> String? {
        let process = Process()
        process.executableURL = executable
        process.arguments = arguments
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        process.standardInput = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            return nil
        }
        let box = ProcessBox(process)
        let watchdog = DispatchWorkItem {
            if box.process.isRunning { box.process.terminate() }
        }
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + timeout, execute: watchdog)
        let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)
        process.waitUntilExit()
        watchdog.cancel()
        guard process.terminationStatus == 0 else { return nil }
        return nonEmpty(output)
    }

    /// Reads through `/usr/bin/security` for the same reason
    /// `ClaudeCredentialStore` does: the Apple-signed binary sits in the item's
    /// `apple-tool:` partition, so a background read never raises the
    /// partition-list prompt. A locked keychain or a refused ACL yields nil,
    /// which is indistinguishable from "not signed in" and falls through.
    private static func readCopilotCLIKeychain() -> Data? {
        runCapturingStdout(
            URL(fileURLWithPath: "/usr/bin/security"),
            ["find-generic-password", "-s", copilotCLIKeychainService, "-w"]
        )?.data(using: .utf8)
    }

    /// `gh auth token` resolves keyring vs ~/.config/gh/hosts.yml itself, so we
    /// only have to find the binary. A missing `gh` is simply absent.
    private static func runGhAuthToken() -> String? {
        guard let gh = ghExecutableURL() else { return nil }
        return runCapturingStdout(gh, ["auth", "token"])
    }

    /// Spotlight-launched apps inherit a minimal PATH, so reuse the same PATH
    /// augmentation that finds the codeburn CLI (Homebrew included).
    private static func ghExecutableURL(
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> URL? {
        let path = CodeburnCLI.augmentedPath(
            environment["PATH"] ?? "",
            homeDirectory: NSHomeDirectory(),
            environment: environment
        )
        for directory in path.split(separator: ":", omittingEmptySubsequences: true) {
            let candidate = "\(directory)/gh"
            if FileManager.default.isExecutableFile(atPath: candidate) {
                return URL(fileURLWithPath: candidate)
            }
        }
        return nil
    }

    /// Gated on the non-secret presence index so the common "nothing pasted"
    /// case never touches Keychain at all.
    private static func savedCopilotToken() -> String? {
        guard CapacityDockProviderCredentialPresence.contains(providerID) else { return nil }
        return (try? CapacityDockProviderCredentialStore.load(for: providerID))?.sanitizedOverride.apiKey
    }

    // MARK: - Fetch

    static func refresh(deps: Deps = .live) async throws -> CopilotUsage {
        if let until = usageBlockedUntil(), until > deps.now() {
            throw FetchError.rateLimited(retryAt: until)
        }
        guard var token = readToken(deps: deps) else { throw FetchError.noCredentials }

        var (data, response) = try await send(request(token: token), deps: deps)
        if response.statusCode == 401 {
            // An active client session rotates this token; re-read once before
            // giving up so we don't report a failure the source already fixed.
            // The subprocess rungs are cached, so drop those answers first.
            resetProbeCache()
            guard let reread = readToken(deps: deps), reread != token else {
                throw FetchError.tokenRejected
            }
            token = reread
            (data, response) = try await send(request(token: token), deps: deps)
        }
        if response.statusCode == 429 {
            throw FetchError.rateLimited(retryAt: recordUsageRateLimit(
                retryAfterSeconds: parseRetryAfterHeader(response.value(forHTTPHeaderField: "Retry-After"))))
        }
        guard (200..<300).contains(response.statusCode) else {
            throw FetchError.usageHTTPError(response.statusCode)
        }
        return try decodeUsage(data: data, now: deps.now())
    }

    private static func request(token: String) -> URLRequest {
        var request = URLRequest(url: usageURL)
        request.httpMethod = "GET"
        request.timeoutInterval = 30
        // Headers mirror the VS Code Copilot Chat plugin.
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("vscode/1.96.2", forHTTPHeaderField: "Editor-Version")
        request.setValue("copilot-chat/0.26.7", forHTTPHeaderField: "Editor-Plugin-Version")
        request.setValue("GitHubCopilotChat/0.26.7", forHTTPHeaderField: "User-Agent")
        request.setValue("2025-04-01", forHTTPHeaderField: "X-Github-Api-Version")
        request.setValue("token \(token)", forHTTPHeaderField: "Authorization")
        return request
    }

    private static func send(_ request: URLRequest, deps: Deps) async throws -> (Data, HTTPURLResponse) {
        do {
            return try await deps.fetch(request)
        } catch let error as FetchError {
            throw error
        } catch {
            throw FetchError.network(error)
        }
    }

    // MARK: - Decode (internal so tests can drive fixtures)

    static func decodeUsage(data: Data, now: Date = Date()) throws -> CopilotUsage {
        let parsed: Any
        do {
            parsed = try JSONSerialization.jsonObject(with: data)
        } catch {
            // Never log the body — account data readable via `log stream`.
            throw FetchError.usageDecodeFailed
        }
        // Field names have shipped both camelCase and snake_case; read each
        // alias rather than trusting one spelling.
        let root = parsed as? [String: Any] ?? [:]
        let snapshots = (root["quota_snapshots"] ?? root["quotaSnapshots"]) as? [String: Any]
        let premium = window(label: "Premium requests",
                             snapshot: snapshots?["premium_interactions"] ?? snapshots?["premiumInteractions"])
        let chat = window(label: "Chat", snapshot: snapshots?["chat"])
        return CopilotUsage(
            details: [premium, chat].compactMap { $0 },
            plan: planLabel(root["copilot_plan"] ?? root["copilotPlan"]),
            fetchedAt: now
        )
    }

    private static func window(label: String, snapshot: Any?) -> CopilotUsage.Window? {
        guard let row = snapshot as? [String: Any],
              let remaining = fraction(row["percent_remaining"] ?? row["percentRemaining"]) else { return nil }
        // Round away float dust from the 1-remaining subtraction
        // (1-0.7 != 0.3), mirroring the desktop decoder's toFixed(6) before
        // scaling to 0..100.
        let used = ((1 - remaining) * 1_000_000).rounded() / 1_000_000 * 100
        return CopilotUsage.Window(label: label, usedPercent: used, resetsAt: nil)
    }

    /// Percent-remaining (0..100) as a clamped 0..1 fraction. Non-numeric
    /// values (and booleans, which bridge to NSNumber) yield nil.
    private static func fraction(_ value: Any?) -> Double? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let fraction = number.doubleValue / 100
        guard fraction.isFinite else { return nil }
        return min(1, max(0, fraction))
    }

    /// nil for missing/blank; known tiers get display names; unknown values
    /// are title-cased on _ and - boundaries (some_future_tier →
    /// "Some Future Tier").
    private static func planLabel(_ value: Any?) -> String? {
        guard let raw = (value as? String)?.trimmingCharacters(in: .whitespaces), !raw.isEmpty else { return nil }
        let lower = raw.lowercased()
        let known = [
            "free": "Free", "individual": "Individual", "pro": "Pro", "business": "Business",
            "enterprise": "Enterprise", "for_educators": "Educators", "for-educators": "Educators",
        ]
        if let label = known[lower] { return label }
        return lower
            .components(separatedBy: CharacterSet(charactersIn: "_-"))
            .filter { !$0.isEmpty }
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
    }

    // MARK: - 429 backoff

    private static func usageBlockedUntil() -> Date? {
        UserDefaults.standard.object(forKey: usageBlockedUntilKey) as? Date
    }

    private static func clearUsageBlock() {
        UserDefaults.standard.removeObject(forKey: usageBlockedUntilKey)
    }

    private static func parseRetryAfterHeader(_ value: String?) -> Int? {
        guard let value = value?.trimmingCharacters(in: .whitespaces), !value.isEmpty else { return nil }
        if let seconds = Int(value), seconds >= 0 { return seconds }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(secondsFromGMT: 0)
        f.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        if let date = f.date(from: value) {
            return max(0, Int(date.timeIntervalSinceNow))
        }
        return nil
    }

    private static func recordUsageRateLimit(retryAfterSeconds: Int?) -> Date {
        let seconds = max(retryAfterSeconds ?? 300, 60)
        let until = Date().addingTimeInterval(TimeInterval(seconds))
        UserDefaults.standard.set(until, forKey: usageBlockedUntilKey)
        return until
    }

    static func disconnect() {
        clearUsageBlock()
        resetProbeCache()
    }
}
