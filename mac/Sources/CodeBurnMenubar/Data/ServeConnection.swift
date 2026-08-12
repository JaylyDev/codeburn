import Darwin
import Foundation

/// A resident `codeburn serve --stdio` child, held so payload fetches skip the
/// per-spawn cost (node boot + a 100MB+ session-cache parse on large corpora,
/// seconds per fetch at the CLI level). Requests are JSON lines `{id, args}`;
/// replies are `{id, ok, output}`. Mirrors the desktop app's client contract:
///
/// - Only `status` payload queries route here; anything else spawns as before.
/// - The first real status request is also the warm-up. It may be written
///   before the child announces READY; the pipe buffers it until serve reads
///   stdin, avoiding a second one-shot process that parses the same cache.
/// - Any failure falls back to the spawn path for that call; three child
///   deaths disable serve for this app run.
/// - The child's stdin closing (app quit, even SIGKILL) ends the server loop
///   on the CLI side, so no orphan survives the menubar.
actor ServeConnection {
    static let shared = ServeConnection()

    typealias ProcessFactory = ([String], QualityOfService) -> Process
    typealias TimeoutSleep = @Sendable (UInt64) async throws -> Void

    private var process: Process?
    private var stdinHandle: FileHandle?
    private var nextId = 1
    private var pending: [Int: CheckedContinuation<Data, Error>] = [:]
    private var deaths = 0
    private var buffer = Data()
    private var receivedTerminalResponse = false
    private let makeProcess: ProcessFactory
    private let timeoutSleep: TimeoutSleep

    private static let maxDeaths = 3
    private static let coldRequestTimeoutNanoseconds: UInt64 = 10 * 60 * 1_000_000_000
    private static let warmRequestTimeoutNanoseconds: UInt64 = 60 * 1_000_000_000

    struct ServeUnavailable: Error {}
    struct ServeRequestFailed: Error { let message: String }

    init(
        makeProcess: @escaping ProcessFactory = CodeburnCLI.makeProcess,
        timeoutSleep: @escaping TimeoutSleep = { nanoseconds in
            try await Task<Never, Never>.sleep(nanoseconds: nanoseconds)
        }
    ) {
        self.makeProcess = makeProcess
        self.timeoutSleep = timeoutSleep
    }

    static func isEligible(_ subcommand: [String]) -> Bool {
        subcommand.first == "status"
    }

    /// Kick the child off (idempotent). Called from app startup and again by
    /// the first request in case the startup task has not run yet.
    func ensureStarted() {
        guard process == nil, deaths < Self.maxDeaths else { return }
        // This single resident serves both background and user-visible status
        // requests. Its cold hydration replaces the old interactive one-shot,
        // so keep the child at the same user-initiated QoS as visible fetches.
        let child = makeProcess(["serve", "--stdio"], .userInitiated)
        let stdinPipe = Pipe()
        let stdinWriter = stdinPipe.fileHandleForWriting
        // Suppress SIGPIPE only for this connection's write end. A process-wide
        // SIG_IGN leaks into unrelated libraries and children; F_SETNOSIGPIPE
        // keeps a closed child stdin on the normal throwable EPIPE path.
        guard Darwin.fcntl(stdinWriter.fileDescriptor, F_SETNOSIGPIPE, 1) == 0 else {
            deaths = Self.maxDeaths
            return
        }
        let stdoutPipe = Pipe()
        child.standardInput = stdinPipe
        child.standardOutput = stdoutPipe
        child.standardError = FileHandle.nullDevice
        stdoutPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            Task { await self?.consume(data, from: child) }
        }
        child.terminationHandler = { [weak self] terminatedChild in
            stdoutPipe.fileHandleForReading.readabilityHandler = nil
            Task { await self?.childDied(terminatedChild) }
        }
        do {
            try child.run()
        } catch {
            deaths = Self.maxDeaths // spawn path can't produce the binary either better than makeProcess did
            return
        }
        process = child
        stdinHandle = stdinWriter
    }

    /// Send the first real payload through the resident child. A request does
    /// not need to wait for the READY frame: stdin is safe to write as soon as
    /// Process.run() succeeds, and serve serializes it after initialization.
    func request(args: [String]) async throws -> Data {
        try Task.checkCancellation()
        ensureStarted()
        guard process != nil else { throw ServeUnavailable() }
        let response = try await send(args: args)
        try Task.checkCancellation()
        return response
    }

    func shutdown() {
        deaths = Self.maxDeaths
        process?.terminate()
        failAllPending()
        process = nil
        stdinHandle = nil
        receivedTerminalResponse = false
    }

    // MARK: - internals

    private func send(args: [String]) async throws -> Data {
        guard let stdinHandle, let child = process else { throw ServeUnavailable() }
        let id = nextId
        nextId += 1
        let request: [String: Any] = ["id": id, "args": args]
        let line = try JSONSerialization.data(withJSONObject: request)
        // Every request admitted before the first terminal response is a cold
        // request, including concurrent startup fetches. Once any terminal
        // frame arrives the resident child is hydrated and later requests use
        // the ordinary one-minute guard.
        let timeoutNanoseconds = receivedTerminalResponse
            ? Self.warmRequestTimeoutNanoseconds
            : Self.coldRequestTimeoutNanoseconds
        let sleep = timeoutSleep
        return try await withThrowingTaskGroup(of: Data.self) { group in
            group.addTask {
                try await self.registerAndWrite(
                    id: id,
                    line: line,
                    stdinHandle: stdinHandle,
                    child: child
                )
            }
            group.addTask {
                try await sleep(timeoutNanoseconds)
                // A hung request would block the serialized queue behind it:
                // kill the child so everything falls back to spawns.
                await self.cancelPendingRequest(
                    id: id,
                    child: child,
                    error: ServeRequestFailed(message: "serve timeout"),
                    countsAsDeath: true
                )
                throw ServeRequestFailed(message: "serve timeout")
            }
            let result = try await group.next()!
            group.cancelAll()
            return result
        }
    }

    private func registerAndWrite(
        id: Int,
        line: Data,
        stdinHandle: FileHandle,
        child: Process
    ) async throws -> Data {
        try Task.checkCancellation()
        return try await withTaskCancellationHandler {
            let response = try await withCheckedThrowingContinuation { continuation in
                // Register synchronously on the actor before writing. A tiny fake
                // server (and occasionally a hot real child) can answer faster
                // than a separately scheduled registration Task would run.
                pending[id] = continuation
                do {
                    try stdinHandle.write(contentsOf: line + Data("\n".utf8))
                } catch {
                    pending.removeValue(forKey: id)
                    continuation.resume(throwing: ServeRequestFailed(message: "stdin write failed"))
                }
            }
            try Task.checkCancellation()
            return response
        } onCancel: {
            Task {
                await self.cancelPendingRequest(
                    id: id,
                    child: child,
                    error: CancellationError(),
                    countsAsDeath: false
                )
            }
        }
    }

    private func cancelPendingRequest(
        id: Int,
        child: Process,
        error: Error,
        countsAsDeath: Bool
    ) {
        guard let continuation = pending.removeValue(forKey: id) else { return }
        continuation.resume(throwing: error)
        // Caller cancellation abandons only this response. The serialized serve
        // child may still be doing the expensive first hydration, and killing it
        // here lets tab switches and UI watchdogs restart that work indefinitely.
        // A real request timeout still kills the exact child that owns the hung
        // request; its termination callback consumes the death budget normally.
        guard countsAsDeath, process === child, child.isRunning else { return }
        child.terminate()
    }

    // Internal so the generation guard can be exercised deterministically by
    // tests without relying on Foundation callback scheduling at process exit.
    func consume(_ data: Data, from child: Process) {
        // A readability callback can already have queued its actor Task when the
        // old process exits. If a replacement starts first, those late bytes must
        // not repopulate the shared line buffer or mark the new child as warm.
        guard process === child else { return }
        buffer.append(data)
        while let newline = buffer.firstIndex(of: UInt8(ascii: "\n")) {
            let lineData = buffer.subdata(in: buffer.startIndex..<newline)
            buffer.removeSubrange(buffer.startIndex...newline)
            guard !lineData.isEmpty,
                  let object = try? JSONSerialization.jsonObject(with: lineData) as? [String: Any] else { continue }
            if object["ready"] as? Bool == true {
                continue
            }
            guard let id = object["id"] as? Int else { continue }
            // Desktop asks serve to stream cold-scan stderr as progress frames.
            // Menubar has no progress UI, but must leave the request pending
            // until the terminal response arrives if such a frame is emitted.
            if object["progress"] is String { continue }
            let succeeded = object["ok"] as? Bool == true
            // A refused/failed command can finish before any cache hydration.
            // Only a successful terminal proves the resident is warm. Keep
            // this before the waiter lookup so a successful orphan response
            // still records the child as warm without resuming anything.
            if succeeded { receivedTerminalResponse = true }
            guard let continuation = pending.removeValue(forKey: id) else { continue }
            if succeeded, let output = object["output"] as? String {
                continuation.resume(returning: Data(output.utf8))
            } else {
                let message = object["error"] as? String ?? "serve request failed"
                continuation.resume(throwing: ServeRequestFailed(message: message))
            }
        }
    }

    private func childDied(_ child: Process) {
        guard process === child else { return }
        process = nil
        stdinHandle = nil
        buffer.removeAll()
        receivedTerminalResponse = false
        deaths += 1
        failAllPending()
    }

    private func failAllPending() {
        for (_, continuation) in pending {
            continuation.resume(throwing: ServeRequestFailed(message: "serve exited"))
        }
        pending.removeAll()
    }
}
