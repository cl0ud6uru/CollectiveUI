import Foundation

public enum ChatScrollReason: Sendable {
    case initial, sent, content, layout
}

/// Content and viewport changes follow the reader only until they scroll away.
public struct ChatScrollPolicy: Equatable, Sendable {
    public private(set) var followsLatest = true
    public private(set) var userIsScrolling = false
    public var nearBottomDistance: Double

    public init(nearBottomDistance: Double = 80) {
        self.nearBottomDistance = nearBottomDistance
    }

    public mutating func observe(distanceFromBottom: Double, userIsScrolling: Bool) {
        self.userIsScrolling = userIsScrolling
        if userIsScrolling {
            // Pause immediately: a chunk must not cancel the native drag before geometry
            // has moved far enough to cross the near-bottom threshold.
            followsLatest = false
            return
        }
        // New chunks can move the bottom before the view follows them. That layout change
        // must not be mistaken for the reader deliberately leaving the latest message.
        if !followsLatest {
            followsLatest = distanceFromBottom <= nearBottomDistance
        }
    }

    public mutating func shouldScroll(for reason: ChatScrollReason) -> Bool {
        if reason == .initial || reason == .sent { jumpToLatest() }
        return followsLatest && !userIsScrolling
    }

    public mutating func jumpToLatest() {
        followsLatest = true
        userIsScrolling = false
    }
}
