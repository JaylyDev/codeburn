import Foundation

/// A resident `codeburn serve --stdio` child, held so payload fetches skip the
/// per-spawn cost (node boot + a 100MB+ session-cache parse on large corpora,
/// seconds per fetch at the CLI level). Requests are JSON lines `{id, args}`;
/// replies are `{id, ok, output}`. Mirrors the desktop app's client contract:
///
/// - Only `status` payload queries route here; anything else spawns as before.
/// - Requests route through serve only once the child is READY and WARM (one
///   completed query), so cold start behaves exactly as today.
/// - Any failure falls back to the spawn path for that call; three child
///   deaths disable serve for this app run.
/// - The child's stdin closing (app quit, even SIGKILL) ends the server loop
///   on the CLI side, so no orphan survives the menubar.
actor ServeConnection {
    static let shared = ServeConnection()

    private var process: Process?
    private var stdinHandle: FileHandle?
    private var nextId = 1
    private var pending: [Int: CheckedContinuation<Data, Error>] = [:]
    private var ready = false
    private var warm = false
    private var deaths = 0
    private var buffer = Data()

    private static let maxDeaths = 3
    private static let requestTimeoutSeconds: UInt64 = 60

    struct ServeUnavailable: Error {}
    struct ServeRequestFailed: Error { let message: String }

    static func isEligible(_ subcommand: [String]) -> Bool {
        subcommand.first == "status"
    }

    /// Kick the child off (idempotent). Called from app startup; fetches keep
    /// spawning until the warm-up completes.
    func ensureStarted() {
        guard process == nil, deaths < Self.maxDeaths else { return }
        let child = CodeburnCLI.makeProcess(subcommand: ["serve", "--stdio"], qualityOfService: .utility)
        let stdinPipe = Pipe()
        let stdoutPipe = Pipe()
        child.standardInput = stdinPipe
        child.standardOutput = stdoutPipe
        child.standardError = FileHandle.nullDevice
        stdoutPipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            Task { await ServeConnection.shared.consume(data) }
        }
        child.terminationHandler = { _ in
            stdoutPipe.fileHandleForReading.readabilityHandler = nil
            Task { await ServeConnection.shared.childDied() }
        }
        do {
            try child.run()
        } catch {
            deaths = Self.maxDeaths // spawn path can't produce the binary either better than makeProcess did
            return
        }
        process = child
        stdinHandle = stdinPipe.fileHandleForWriting
        Task {
            // Warm-up: one cheap query makes the child parse the session cache
            // once; every later payload answers from the warm in-memory copy.
            _ = try? await self.send(args: ["status", "--format", "menubar-json", "--period", "today", "--no-optimize"])
            await self.markWarm()
        }
    }

    /// The fast path `runCLI` consults: throws ServeUnavailable unless the
    /// child is warm, so callers can fall back to a spawn without waiting.
    func requestIfWarm(args: [String]) async throws -> Data {
        guard ready, warm, process != nil else { throw ServeUnavailable() }
        return try await send(args: args)
    }

    func shutdown() {
        deaths = Self.maxDeaths
        process?.terminate()
        failAllPending()
        process = nil
        stdinHandle = nil
    }

    // MARK: - internals

    private func markWarm() {
        if process != nil { warm = true }
    }

    private func send(args: [String]) async throws -> Data {
        guard let stdinHandle, let child = process else { throw ServeUnavailable() }
        let id = nextId
        nextId += 1
        let request: [String: Any] = ["id": id, "args": args]
        let line = try JSONSerialization.data(withJSONObject: request)
        return try await withThrowingTaskGroup(of: Data.self) { group in
            group.addTask {
                try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Data, Error>) in
                    Task { await self.registerPending(id: id, continuation: continuation) }
                    do {
                        try stdinHandle.write(contentsOf: line + Data("\n".utf8))
                    } catch {
                        Task { await self.rejectPending(id: id, error: ServeRequestFailed(message: "stdin write failed")) }
                    }
                }
            }
            group.addTask {
                try await Task.sleep(nanoseconds: Self.requestTimeoutSeconds * 1_000_000_000)
                // A hung request would block the serialized queue behind it:
                // kill the child so everything falls back to spawns.
                await self.rejectPending(id: id, error: ServeRequestFailed(message: "serve timeout"))
                child.terminate()
                throw ServeRequestFailed(message: "serve timeout")
            }
            let result = try await group.next()!
            group.cancelAll()
            return result
        }
    }

    private func registerPending(id: Int, continuation: CheckedContinuation<Data, Error>) {
        pending[id] = continuation
    }

    private func rejectPending(id: Int, error: Error) {
        if let continuation = pending.removeValue(forKey: id) {
            continuation.resume(throwing: error)
        }
    }

    private func consume(_ data: Data) {
        buffer.append(data)
        while let newline = buffer.firstIndex(of: UInt8(ascii: "\n")) {
            let lineData = buffer.subdata(in: buffer.startIndex..<newline)
            buffer.removeSubrange(buffer.startIndex...newline)
            guard !lineData.isEmpty,
                  let object = try? JSONSerialization.jsonObject(with: lineData) as? [String: Any] else { continue }
            if object["ready"] as? Bool == true {
                ready = true
                continue
            }
            guard let id = object["id"] as? Int, let continuation = pending.removeValue(forKey: id) else { continue }
            if object["ok"] as? Bool == true, let output = object["output"] as? String {
                continuation.resume(returning: Data(output.utf8))
            } else {
                let message = object["error"] as? String ?? "serve request failed"
                continuation.resume(throwing: ServeRequestFailed(message: message))
            }
        }
    }

    private func childDied() {
        process = nil
        stdinHandle = nil
        ready = false
        warm = false
        buffer.removeAll()
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
