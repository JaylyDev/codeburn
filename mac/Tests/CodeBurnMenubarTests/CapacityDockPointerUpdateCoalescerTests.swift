import CoreGraphics
import Testing
@testable import CodeBurnMenubar

@Suite("Capacity Dock pointer update coalescer")
struct CapacityDockPointerUpdateCoalescerTests {
    @Test("A burst schedules once and drains its latest point")
    func burstCoalescesToLatestPoint() {
        var coalescer = CapacityDockPointerUpdateCoalescer()
        let first = CGPoint(x: 10, y: 20)
        let second = CGPoint(x: 11, y: 21)
        let latest = CGPoint(x: 12, y: 22)

        #expect(coalescer.enqueue(first) == .scheduleDrain)
        #expect(coalescer.enqueue(second) == .coalesced)
        #expect(coalescer.enqueue(latest) == .coalesced)
        #expect(coalescer.drain() == latest)
        #expect(coalescer.drain() == nil)
    }

    @Test("A poll duplicate of a monitor point is suppressed across a drain")
    func duplicatePointIsSuppressed() {
        var coalescer = CapacityDockPointerUpdateCoalescer()
        let point = CGPoint(x: 40, y: 80)

        #expect(coalescer.enqueue(point) == .scheduleDrain)
        #expect(coalescer.enqueue(point) == .duplicate)
        #expect(coalescer.drain() == point)
        #expect(coalescer.enqueue(point) == .duplicate)
        #expect(coalescer.drain() == nil)
    }

    @Test("Reset cancels pending work and forgets duplicate history")
    func resetStopsPendingUpdate() {
        var coalescer = CapacityDockPointerUpdateCoalescer()
        let point = CGPoint(x: 5, y: 9)

        #expect(coalescer.enqueue(point) == .scheduleDrain)
        coalescer.reset()
        #expect(coalescer.drain() == nil)
        #expect(coalescer.enqueue(point) == .scheduleDrain)
        #expect(coalescer.drain() == point)
    }

    @Test("A new point schedules another drain after the prior drain")
    func reschedulesAfterDrain() {
        var coalescer = CapacityDockPointerUpdateCoalescer()
        let first = CGPoint(x: 1, y: 2)
        let second = CGPoint(x: 2, y: 3)

        #expect(coalescer.enqueue(first) == .scheduleDrain)
        #expect(coalescer.drain() == first)
        #expect(coalescer.enqueue(second) == .scheduleDrain)
        #expect(coalescer.drain() == second)
    }
}

@Suite("Capacity Dock pointer monitoring session")
struct CapacityDockPointerMonitoringSessionTests {
    @Test("A click flushes an older movement before its queued drain")
    func clickFlushInvalidatesQueuedDrain() {
        var session = CapacityDockPointerMonitoringSession()
        let insidePoint = CGPoint(x: 40, y: 80)
        let outsideClick = CGPoint(x: 400, y: 800)
        let generation = session.start()

        #expect(session.enqueue(insidePoint, generation: generation) == .scheduleDrain)
        #expect(session.flush(with: outsideClick, generation: generation) == outsideClick)
        #expect(session.drain(generation: generation) == nil)
        #expect(session.enqueue(outsideClick, generation: generation) == .duplicate)
    }

    @Test("Stop invalidates queued callbacks and drains across restart")
    func staleWorkCannotCrossRestart() {
        var session = CapacityDockPointerMonitoringSession()
        let point = CGPoint(x: 40, y: 80)
        let stalePoint = CGPoint(x: 41, y: 81)
        let firstGeneration = session.start()

        #expect(session.enqueue(point, generation: firstGeneration) == .scheduleDrain)
        session.stop()
        #expect(session.enqueue(stalePoint, generation: firstGeneration) == nil)
        #expect(session.drain(generation: firstGeneration) == nil)

        let restartedGeneration = session.start()
        #expect(restartedGeneration != firstGeneration)
        #expect(session.enqueue(point, generation: restartedGeneration) == .scheduleDrain)

        // A drain queued by the stopped generation must not consume the
        // restarted session's current stationary point.
        #expect(session.drain(generation: firstGeneration) == nil)
        #expect(session.drain(generation: restartedGeneration) == point)
    }

    @Test("Stopped generations reject click and key callback tokens")
    func lifecycleTokenInvalidation() {
        var session = CapacityDockPointerMonitoringSession()
        let generation = session.start()
        #expect(session.isCurrent(generation))

        session.stop()
        #expect(!session.isCurrent(generation))
    }
}
