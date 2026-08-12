import Darwin
import Foundation
import Testing
@testable import CodeBurnMenubar

private let ignoredSIGPIPEHandlerBits = unsafeBitCast(SIG_IGN, to: UInt.self)
private let coldTimeoutNanoseconds: UInt64 = 10 * 60 * 1_000_000_000
private let warmTimeoutNanoseconds: UInt64 = 60 * 1_000_000_000

private func currentSIGPIPEHandlerBits() -> UInt {
    var action = sigaction()
    _ = sigaction(SIGPIPE, nil, &action)
    return unsafeBitCast(action.__sigaction_u.__sa_handler, to: UInt.self)
}

private actor TimeoutRecorder {
    private var values: [UInt64] = []

    func recordAndSleep(_ nanoseconds: UInt64) async throws {
        values.append(nanoseconds)
        // Cold timers stay pending until the fake child replies and the task
        // group cancels them. The warm timer returns immediately to exercise
        // the timeout path without a real one-minute wait.
        if nanoseconds == warmTimeoutNanoseconds { return }
        try await Task.sleep(nanoseconds: 5 * 1_000_000_000)
    }

    func recordAndWait(_ nanoseconds: UInt64) async throws {
        values.append(nanoseconds)
        // This recorder verifies timeout selection without firing the timeout.
        // The response must deterministically win, then cancel this sleeper.
        try await Task.sleep(nanoseconds: 5 * 1_000_000_000)
    }

    func snapshot() -> [UInt64] { values }
}

private final class QualityOfServiceRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [QualityOfService] = []

    func record(_ value: QualityOfService) {
        lock.lock()
        values.append(value)
        lock.unlock()
    }

    func snapshot() -> [QualityOfService] {
        lock.lock()
        defer { lock.unlock() }
        return values
    }
}

@Suite("ServeConnection", .serialized)
struct ServeConnectionTests {
    @Test("the resident child starts at user-initiated QoS")
    func residentChildUsesInteractiveQoS() async {
        let recorder = QualityOfServiceRecorder()
        let connection = ServeConnection { _, qualityOfService in
            recorder.record(qualityOfService)
            let child = Process()
            child.executableURL = URL(fileURLWithPath: "/bin/sh")
            child.arguments = ["-c", "while IFS= read -r line; do :; done"]
            child.qualityOfService = qualityOfService
            return child
        }

        await connection.ensureStarted()

        #expect(recorder.snapshot() == [.userInitiated])
        await connection.shutdown()
    }

    @Test("cancelling a hung request returns promptly")
    func cancellationUnblocksPendingContinuation() async throws {
        let dir = NSTemporaryDirectory() + "serve-connection-cancel-test-" + UUID().uuidString
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let requestMarker = dir + "/request-read"

        let connection = ServeConnection { _, qualityOfService in
            let child = Process()
            child.executableURL = URL(fileURLWithPath: "/bin/sh")
            child.arguments = ["-c", "IFS= read -r line; : > \"$1\"; sleep 1", "serve-fixture", requestMarker]
            child.qualityOfService = qualityOfService
            return child
        }

        let request = Task {
            try await connection.request(args: ["status", "--format", "menubar-json"])
        }
        for _ in 0..<200 where !FileManager.default.fileExists(atPath: requestMarker) {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        #expect(FileManager.default.fileExists(atPath: requestMarker))

        let clock = ContinuousClock()
        let started = clock.now
        request.cancel()
        do {
            _ = try await request.value
            #expect(Bool(false), "cancelled request unexpectedly succeeded")
        } catch {
            #expect(error is CancellationError)
        }
        let elapsed = started.duration(to: clock.now)
        #expect(elapsed < .milliseconds(500))
        await connection.shutdown()
    }

    @Test("a request queued during cancelled hydration completes on the same child")
    func cancellationKeepsQueuedRequestOnResidentChild() async throws {
        let dir = NSTemporaryDirectory() + "serve-connection-cancel-overlap-test-" + UUID().uuidString
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let pidsFile = dir + "/pids"
        let eventsFile = dir + "/events"
        let releaseMarker = dir + "/release-first"
        let recorder = TimeoutRecorder()

        let connection = ServeConnection(
            makeProcess: { _, qualityOfService in
                let child = Process()
                child.executableURL = URL(fileURLWithPath: "/bin/sh")
                child.arguments = ["-c", """
                    printf '%s\n' "$$" >> "$1"
                    IFS= read -r first
                    first_id=$(printf '%s' "$first" | sed -E 's/.*"id":([0-9]+).*/\\1/')
                    printf 'first-read\n' >> "$2"
                    while [ ! -f "$3" ]; do sleep 0.01; done
                    printf '{"id":%s,"ok":true,"output":"late-%s"}\n' "$first_id" "$first_id"
                    printf 'late-first\n' >> "$2"
                    IFS= read -r second
                    second_id=$(printf '%s' "$second" | sed -E 's/.*"id":([0-9]+).*/\\1/')
                    printf 'second-read\n' >> "$2"
                    printf '{"id":%s,"ok":true,"output":"live-%s"}\n' "$second_id" "$second_id"
                    printf 'second-replied\n' >> "$2"
                    """, "serve-fixture", pidsFile, eventsFile, releaseMarker]
                child.qualityOfService = qualityOfService
                return child
            },
            timeoutSleep: { nanoseconds in
                try await recorder.recordAndSleep(nanoseconds)
            }
        )

        let first = Task {
            try await connection.request(args: ["status", "--request", "first"])
        }
        for _ in 0..<200 {
            let events = (try? String(contentsOfFile: eventsFile, encoding: .utf8)) ?? ""
            if events.contains("first-read\n") { break }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        #expect(try String(contentsOfFile: eventsFile, encoding: .utf8) == "first-read\n")

        first.cancel()
        do {
            _ = try await first.value
            #expect(Bool(false), "cancelled request unexpectedly succeeded")
        } catch {
            #expect(error is CancellationError)
        }

        // Submit the next request while the child is still blocked hydrating
        // the cancelled first one. Two timeout selections prove both requests
        // reached send() before the fake is released to emit either response.
        let second = Task {
            try await connection.request(args: ["status", "--request", "second"])
        }
        for _ in 0..<200 {
            if await recorder.snapshot().count >= 2 { break }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        #expect(await recorder.snapshot().count == 2)
        #expect(try String(contentsOfFile: eventsFile, encoding: .utf8) == "first-read\n")

        _ = FileManager.default.createFile(atPath: releaseMarker, contents: Data())
        let secondPayload = try await second.value

        #expect(String(decoding: secondPayload, as: UTF8.self) == "live-2")
        let pids = try String(contentsOfFile: pidsFile, encoding: .utf8)
            .split(separator: "\n")
        #expect(pids.count == 1)
        let events = try String(contentsOfFile: eventsFile, encoding: .utf8)
            .split(separator: "\n")
        #expect(events == ["first-read", "late-first", "second-read", "second-replied"])
        await connection.shutdown()
    }

    @Test("external cancellations keep one child and safely discard late replies")
    func cancellationsKeepResidentChildAlive() async throws {
        let dir = NSTemporaryDirectory() + "serve-connection-cancel-reuse-test-" + UUID().uuidString
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let pidsFile = dir + "/pids"
        let requestsFile = dir + "/requests"
        let lateRepliesFile = dir + "/late-replies"

        let connection = ServeConnection { _, qualityOfService in
            let child = Process()
            child.executableURL = URL(fileURLWithPath: "/bin/sh")
            child.arguments = ["-c", """
                printf '%s\n' "$$" >> "$1"
                while IFS= read -r line; do
                  printf r >> "$2"
                  id=$(printf '%s' "$line" | sed -E 's/.*"id":([0-9]+).*/\\1/')
                  if [ "$id" -le 3 ]; then
                    sleep 0.05
                    printf '{"id":%s,"ok":true,"output":"late-%s"}\n' "$id" "$id"
                    printf l >> "$3"
                  else
                    printf '{"id":%s,"ok":true,"output":"live-%s"}\n' "$id" "$id"
                  fi
                done
                """, "serve-fixture", pidsFile, requestsFile, lateRepliesFile]
            child.qualityOfService = qualityOfService
            return child
        }

        for attempt in 0..<3 {
            let request = Task {
                try await connection.request(args: ["status", "--attempt", String(attempt)])
            }
            for _ in 0..<200 {
                let reads = (try? String(contentsOfFile: requestsFile, encoding: .utf8).count) ?? 0
                if reads >= attempt + 1 { break }
                try await Task.sleep(nanoseconds: 10_000_000)
            }
            request.cancel()
            do {
                _ = try await request.value
                #expect(Bool(false), "cancelled request unexpectedly succeeded")
            } catch {
                #expect(error is CancellationError)
            }

            // The fake child deliberately emits the now-orphaned response after
            // cancellation. It must be ignored without double-resuming anything,
            // and the same resident child must remain available for the next id.
            for _ in 0..<200 {
                let replies = (try? String(contentsOfFile: lateRepliesFile, encoding: .utf8).count) ?? 0
                if replies >= attempt + 1 { break }
                try await Task.sleep(nanoseconds: 10_000_000)
            }
            let replies = (try? String(contentsOfFile: lateRepliesFile, encoding: .utf8).count) ?? 0
            #expect(replies == attempt + 1)
        }

        let finalPayload = try await connection.request(args: ["status", "--attempt", "final"])
        #expect(String(decoding: finalPayload, as: UTF8.self) == "live-4")
        let pids = try String(contentsOfFile: pidsFile, encoding: .utf8)
            .split(separator: "\n")
        #expect(pids.count == 1)
        #expect(try String(contentsOfFile: requestsFile, encoding: .utf8) == "rrrr")
        #expect(try String(contentsOfFile: lateRepliesFile, encoding: .utf8) == "lll")
        await connection.shutdown()
    }

    @Test("late stdout from a replaced child cannot corrupt or warm its replacement")
    func staleGenerationStdoutIsDiscarded() async throws {
        let oldChild = Process()
        oldChild.executableURL = URL(fileURLWithPath: "/bin/sh")
        oldChild.arguments = ["-c", "IFS= read -r line; sleep 0.1; exit 1"]

        let newChild = Process()
        newChild.executableURL = URL(fileURLWithPath: "/bin/sh")
        newChild.arguments = ["-c", """
            while IFS= read -r line; do
              id=$(printf '%s' "$line" | sed -E 's/.*"id":([0-9]+).*/\\1/')
              printf '{"id":%s,"ok":true,"output":"new-%s"}\n' "$id" "$id"
            done
            """]

        var children = [oldChild, newChild]
        let recorder = TimeoutRecorder()
        let connection = ServeConnection(
            makeProcess: { _, qualityOfService in
                let child = children.removeFirst()
                child.qualityOfService = qualityOfService
                return child
            },
            timeoutSleep: { nanoseconds in
                try await recorder.recordAndSleep(nanoseconds)
            }
        )

        do {
            _ = try await connection.request(args: ["status", "--generation", "old"])
            #expect(Bool(false), "old child unexpectedly answered")
        } catch {
            #expect(error is ServeConnection.ServeRequestFailed)
        }

        await connection.ensureStarted()

        // Model both harmful trailing shapes after the replacement owns the
        // connection: a complete terminal would incorrectly select the warm
        // timeout, while a fragment would corrupt the replacement's first line.
        await connection.consume(
            Data("{\"id\":1,\"ok\":true,\"output\":\"late-old\"}\n".utf8),
            from: oldChild
        )
        await connection.consume(Data("{\"id\":1".utf8), from: oldChild)

        let payload = try await connection.request(args: ["status", "--generation", "new"])

        #expect(String(decoding: payload, as: UTF8.self) == "new-2")
        #expect(await recorder.snapshot() == [coldTimeoutNanoseconds, coldTimeoutNanoseconds])
        #expect(children.isEmpty)
        await connection.shutdown()
    }

    @Test("all concurrent cold requests get ten minutes, then warm requests get one minute")
    func coldAndWarmTimeoutSelection() async throws {
        let dir = NSTemporaryDirectory() + "serve-connection-timeout-test-" + UUID().uuidString
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let releaseMarker = dir + "/release-cold-responses"
        let recorder = TimeoutRecorder()

        let connection = ServeConnection(
            makeProcess: { _, qualityOfService in
                let child = Process()
                child.executableURL = URL(fileURLWithPath: "/bin/sh")
                child.arguments = ["-c", """
                    IFS= read -r first
                    IFS= read -r second
                    while [ ! -f "$1" ]; do sleep 0.01; done
                    for line in "$first" "$second"; do
                      id=$(printf '%s' "$line" | sed -E 's/.*"id":([0-9]+).*/\\1/')
                      printf '{"id":%s,"ok":true,"output":"served"}\\n' "$id"
                    done
                    IFS= read -r third
                    sleep 2
                    """, "serve-fixture", releaseMarker]
                child.qualityOfService = qualityOfService
                return child
            },
            timeoutSleep: { nanoseconds in
                try await recorder.recordAndSleep(nanoseconds)
            }
        )

        let first = Task { try await connection.request(args: ["status", "--request", "one"]) }
        let second = Task { try await connection.request(args: ["status", "--request", "two"]) }
        for _ in 0..<200 {
            if await recorder.snapshot().count >= 2 { break }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        let coldSelections = await recorder.snapshot()
        #expect(coldSelections.count == 2)
        #expect(coldSelections.allSatisfy { $0 == coldTimeoutNanoseconds })

        _ = FileManager.default.createFile(atPath: releaseMarker, contents: Data())
        let firstPayload = try await first.value
        let secondPayload = try await second.value
        #expect(String(decoding: firstPayload, as: UTF8.self) == "served")
        #expect(String(decoding: secondPayload, as: UTF8.self) == "served")

        do {
            _ = try await connection.request(args: ["status", "--request", "three"])
            #expect(Bool(false), "warm request unexpectedly escaped its timeout")
        } catch {
            #expect(error is ServeConnection.ServeRequestFailed)
        }
        let allSelections = await recorder.snapshot()
        #expect(allSelections == [
            coldTimeoutNanoseconds,
            coldTimeoutNanoseconds,
            warmTimeoutNanoseconds,
        ])
        await connection.shutdown()
    }

    @Test("a failed terminal response does not mark the resident child warm")
    func failedTerminalResponseKeepsColdTimeout() async throws {
        let recorder = TimeoutRecorder()
        let connection = ServeConnection(
            makeProcess: { _, qualityOfService in
                let child = Process()
                child.executableURL = URL(fileURLWithPath: "/bin/sh")
                child.arguments = ["-c", """
                    count=0
                    while IFS= read -r line; do
                      count=$((count + 1))
                      id=$(printf '%s' "$line" | sed -E 's/.*"id":([0-9]+).*/\\1/')
                      if [ "$count" -eq 1 ]; then
                        printf '{"id":%s,"ok":false,"error":"cold failure"}\\n' "$id"
                      else
                        printf '{"id":%s,"ok":true,"output":"served-%s"}\\n' "$id" "$count"
                      fi
                    done
                    """]
                child.qualityOfService = qualityOfService
                return child
            },
            timeoutSleep: { nanoseconds in
                try await recorder.recordAndWait(nanoseconds)
            }
        )

        do {
            _ = try await connection.request(args: ["status", "--request", "failed"])
            #expect(Bool(false), "failed response unexpectedly succeeded")
        } catch {
            #expect(error is ServeConnection.ServeRequestFailed)
        }

        let second = try await connection.request(args: ["status", "--request", "cold-success"])
        let third = try await connection.request(args: ["status", "--request", "warm-success"])

        #expect(String(decoding: second, as: UTF8.self) == "served-2")
        #expect(String(decoding: third, as: UTF8.self) == "served-3")
        #expect(await recorder.snapshot() == [
            coldTimeoutNanoseconds,
            coldTimeoutNanoseconds,
            warmTimeoutNanoseconds,
        ])
        await connection.shutdown()
    }

    @Test("the first real request is the only cold-start query")
    func firstRequestIsTheWarmup() async throws {
        let dir = NSTemporaryDirectory() + "serve-connection-test-" + UUID().uuidString
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let requestLog = dir + "/requests.log"

        let connection = ServeConnection { _, qualityOfService in
            let child = Process()
            child.executableURL = URL(fileURLWithPath: "/bin/sh")
            child.arguments = ["-c", """
                while IFS= read -r line; do
                  printf 'request\\n' >> "$1"
                  id=$(printf '%s' "$line" | sed -E 's/.*\"id\":([0-9]+).*/\\1/')
                  printf '{\"id\":%s,\"progress\":\"scanning\"}\\n' "$id"
                  printf '{\"id\":%s,\"ok\":true,\"output\":\"served\"}\\n' "$id"
                  # Emit READY after the terminal response. The client must
                  # register and complete the first real request without it.
                  printf '{\"ready\":true,\"pid\":1}\\n'
                done
                """, "serve-fixture", requestLog]
            child.qualityOfService = qualityOfService
            return child
        }

        await connection.ensureStarted()
        let payload = try await connection.request(args: ["status", "--format", "menubar-json"])

        #expect(String(decoding: payload, as: UTF8.self) == "served")
        let requests = try String(contentsOfFile: requestLog, encoding: .utf8)
            .split(separator: "\n")
        #expect(requests.count == 1)
        await connection.shutdown()
    }

    @Test("a child that closes stdin fails the request without terminating the app")
    func closedChildStdinDoesNotRaiseSIGPIPE() async throws {
        let dir = NSTemporaryDirectory() + "serve-connection-sigpipe-test-" + UUID().uuidString
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let closedMarker = dir + "/stdin-closed"
        let sigpipeHandlerBefore = currentSIGPIPEHandlerBits()

        let connection = ServeConnection { _, qualityOfService in
            let child = Process()
            child.executableURL = URL(fileURLWithPath: "/bin/sh")
            child.arguments = ["-c", "exec 0<&-; : > \"$1\"; sleep 2", "serve-fixture", closedMarker]
            child.qualityOfService = qualityOfService
            return child
        }

        await connection.ensureStarted()
        #expect(currentSIGPIPEHandlerBits() == sigpipeHandlerBefore)
        #expect(currentSIGPIPEHandlerBits() != ignoredSIGPIPEHandlerBits)
        for _ in 0..<200 where !FileManager.default.fileExists(atPath: closedMarker) {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        #expect(FileManager.default.fileExists(atPath: closedMarker))

        var requestFailed = false
        do {
            _ = try await connection.request(args: ["status", "--format", "menubar-json"])
        } catch {
            requestFailed = true
        }
        #expect(requestFailed)
        await connection.shutdown()
    }
}
