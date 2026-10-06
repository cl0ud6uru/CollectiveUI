import XCTest
@testable import CollectiveKit

final class ChatScrollPolicyTests: XCTestCase {
    func testStreamingFollowsUntilReaderScrollsAwayAndExplicitJumpResumes() {
        var policy = ChatScrollPolicy()
        policy.observe(distanceFromBottom: 500, userIsScrolling: false)
        XCTAssertTrue(policy.shouldScroll(for: .content), "A growing reply is not a reader gesture")
        policy.observe(distanceFromBottom: 500, userIsScrolling: true)
        XCTAssertFalse(policy.shouldScroll(for: .content))
        XCTAssertFalse(policy.shouldScroll(for: .layout), "Rotation and keyboard resize must preserve reading position")
        policy.jumpToLatest()
        XCTAssertTrue(policy.shouldScroll(for: .content))
    }

    func testScrollingBackNearBottomResumesFollowing() {
        var policy = ChatScrollPolicy(nearBottomDistance: 80)
        policy.observe(distanceFromBottom: 81, userIsScrolling: true)
        XCTAssertFalse(policy.followsLatest)
        policy.observe(distanceFromBottom: 80, userIsScrolling: false)
        XCTAssertTrue(policy.followsLatest)
    }

    func testInitialLoadAndOwnSendResumeFollowing() {
        for reason in [ChatScrollReason.initial, .sent] {
            var policy = ChatScrollPolicy()
            policy.observe(distanceFromBottom: 400, userIsScrolling: true)
            XCTAssertTrue(policy.shouldScroll(for: reason))
            XCTAssertTrue(policy.shouldScroll(for: .layout))
            XCTAssertTrue(policy.shouldScroll(for: .content))
        }
    }

    func testFirstDragAtBottomSuspendsChunksBeforeGeometryMoves() {
        var policy = ChatScrollPolicy()
        policy.observe(distanceFromBottom: 0, userIsScrolling: true)
        XCTAssertFalse(policy.shouldScroll(for: .content))
        XCTAssertFalse(policy.shouldScroll(for: .layout))
        policy.observe(distanceFromBottom: 400, userIsScrolling: false)
        XCTAssertFalse(policy.shouldScroll(for: .content))
        policy.observe(distanceFromBottom: 0, userIsScrolling: false)
        XCTAssertTrue(policy.shouldScroll(for: .content))
    }
}
