import CoreGraphics

/// Coalesces pointer samples from the event monitors and fallback poller into
/// one update per main-runloop turn. Repeated coordinates are ignored even
/// after a drain, so the poller does not replay the point a monitor delivered.
struct CapacityDockPointerUpdateCoalescer {
    enum EnqueueResult: Equatable {
        case scheduleDrain
        case coalesced
        case duplicate
    }

    private var latestPoint: CGPoint?
    private var pendingPoint: CGPoint?
    private var hasScheduledDrain = false

    mutating func enqueue(_ point: CGPoint) -> EnqueueResult {
        guard point != latestPoint else { return .duplicate }
        latestPoint = point
        pendingPoint = point

        guard !hasScheduledDrain else { return .coalesced }
        hasScheduledDrain = true
        return .scheduleDrain
    }

    mutating func drain() -> CGPoint? {
        guard hasScheduledDrain else { return nil }
        defer {
            pendingPoint = nil
            hasScheduledDrain = false
        }
        return pendingPoint
    }

    /// Makes an immediate interaction point authoritative and cancels the
    /// queued drain that held an older sample.
    mutating func flush(with point: CGPoint) -> CGPoint {
        latestPoint = point
        pendingPoint = nil
        hasScheduledDrain = false
        return point
    }

    mutating func reset() {
        latestPoint = nil
        pendingPoint = nil
        hasScheduledDrain = false
    }
}

/// Owns one generation of pointer monitoring so callbacks queued by a stopped
/// monitor cannot publish into a later session or drain that session's point.
struct CapacityDockPointerMonitoringSession {
    typealias Generation = UInt

    private var generation: Generation = 0
    private var coalescer = CapacityDockPointerUpdateCoalescer()

    mutating func start() -> Generation {
        generation &+= 1
        coalescer.reset()
        return generation
    }

    mutating func stop() {
        generation &+= 1
        coalescer.reset()
    }

    func isCurrent(_ candidate: Generation) -> Bool {
        candidate == generation
    }

    mutating func enqueue(
        _ point: CGPoint,
        generation candidate: Generation
    ) -> CapacityDockPointerUpdateCoalescer.EnqueueResult? {
        guard isCurrent(candidate) else { return nil }
        return coalescer.enqueue(point)
    }

    mutating func drain(generation candidate: Generation) -> CGPoint? {
        guard isCurrent(candidate) else { return nil }
        return coalescer.drain()
    }

    mutating func flush(
        with point: CGPoint,
        generation candidate: Generation
    ) -> CGPoint? {
        guard isCurrent(candidate) else { return nil }
        return coalescer.flush(with: point)
    }
}
