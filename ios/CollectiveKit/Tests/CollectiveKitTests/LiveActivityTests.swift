import XCTest
@testable import CollectiveKit

final class LiveActivityTests: XCTestCase {
    func testForegroundStartsAndConcurrentLimit() {
        func start(enabled: Bool = true, authorized: Bool = true, foreground: Bool = true,
                   phase: RunActivityPhase = .working, existing: [String] = [], dismissed: Set<String> = []) -> Bool {
            ActivityStartPolicy.mayStart(enabled: enabled, authorized: authorized, foreground: foreground,
                phase: phase, runId: "run", existingRunIds: existing, dismissedRunIds: dismissed)
        }
        XCTAssertTrue(start())
        XCTAssertTrue(start(existing: ["one", "two"]))
        XCTAssertFalse(start(existing: ["one", "two", "three"]))
        XCTAssertFalse(start(existing: ["run"]))
        XCTAssertFalse(start(dismissed: ["run"]))
        XCTAssertFalse(start(enabled: false))
        XCTAssertFalse(start(authorized: false))
        XCTAssertFalse(start(foreground: false))
        for phase in [RunActivityPhase.completed, .cancelled, .failed] { XCTAssertFalse(start(phase: phase)) }
    }
    func testReconnectDoesNotRewindOrResurrectTerminalState() {
        let working = RunActivityContent(phase: .working, updatedAt: 20, revision: 5)
        XCTAssertFalse(working.accepts(.init(phase: .queued, updatedAt: 19, revision: 100)))
        XCTAssertFalse(working.accepts(.init(phase: .queued, updatedAt: 20, revision: 4)))
        XCTAssertTrue(working.accepts(.init(phase: .attention, updatedAt: 20, revision: 6)))
        let done = RunActivityContent(phase: .completed, updatedAt: 21)
        XCTAssertTrue(working.accepts(done))
        XCTAssertFalse(done.accepts(.init(phase: .working, updatedAt: 30)))
    }
    func testDeepLinkBoundToLoginAndExactTask() throws {
        let attrs = CollectiveRunAttributes(scope: "login", conversationId: "chat_123", botId: "bot", runId: "run", pet: "moss")
        let url = try XCTUnwrap(attrs.chatURL)
        let link = try XCTUnwrap(ActivityDeepLink(url: url, expectedScope: "login"))
        XCTAssertEqual(link.conversationId, "chat_123")
        XCTAssertEqual(link.botId, "bot")
        XCTAssertEqual(link.runId, "run")
        XCTAssertNil(ActivityDeepLink(url: url, expectedScope: "another-login"))
        for bad in [url.absoluteString + "&run=other", url.absoluteString + "#bad", url.absoluteString.replacingOccurrences(of: "chat_123", with: "..%2Fadmin"),
                    url.absoluteString.replacingOccurrences(of: "collectiveui", with: "https"), url.absoluteString.replacingOccurrences(of: "//activity", with: "//auth/callback")] {
            XCTAssertNil(ActivityDeepLink(url: try XCTUnwrap(URL(string: bad)), expectedScope: "login"))
        }
    }
    func testContentWireContractAndPrivacy() throws {
        let json = Data(#"{"phase":"attention","updatedAt":1791219600,"revision":7}"#.utf8)
        let state = try JSONDecoder().decode(RunActivityContent.self, from: json)
        XCTAssertEqual(state.phase, .attention)
        XCTAssertFalse(state.phase.isTerminal)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(state)) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["phase", "updatedAt", "revision"])
        XCTAssertThrowsError(try JSONDecoder().decode(RunActivityContent.self, from: Data(#"{"phase":"garbage"}"#.utf8)))
    }
    func testCustomPetFramesBoundedAndAllPosesDecodable() throws {
        var bytes = [UInt8](repeating: 0, count: ActivityPetPixels.byteCount)
        bytes[4] = 200; bytes[7] = 255
        bytes[64] = 0x10
        let base64 = Data(bytes).base64EncodedString()
        let pixels = try XCTUnwrap(ActivityPetPixels(base64: base64))
        XCTAssertEqual(pixels.rgba(x: 0, y: 0, pose: 0).0, 200)
        XCTAssertEqual(pixels.rgba(x: 0, y: 0, pose: 0).3, 255)
        XCTAssertEqual(pixels.rgba(x: 1, y: 0, pose: 0).3, 0)
        XCTAssertEqual(pixels.rgba(x: 100, y: 0, pose: 0).3, 0)
        XCTAssertNil(ActivityPetPixels(base64: "bad"))
        XCTAssertNil(ActivityPetPixels(base64: Data(bytes + [0]).base64EncodedString()))
        let attrs = CollectiveRunAttributes(scope: UUID().uuidString, conversationId: String(repeating: "c", count: 100),
            botId: String(repeating: "b", count: 100), runId: String(repeating: "r", count: 100), pet: "custom", petPixels: base64)
        XCTAssertLessThan(try JSONEncoder().encode(attrs).count + JSONEncoder().encode(RunActivityContent(phase: .working, updatedAt: 1791219600)).count, 3500)
    }
    func testStaticPosesAndTerminalStates() {
        XCTAssertEqual(RunActivityPhase.working.poseIndex, 1)
        XCTAssertEqual(RunActivityPhase.attention.poseIndex, 2)
        XCTAssertEqual(RunActivityPhase.failed.poseIndex, 3)
        XCTAssertEqual(RunActivityPhase.completed.poseIndex, 0)
        XCTAssertTrue(RunActivityPhase.cancelled.isTerminal)
        XCTAssertFalse(RunActivityPhase.reconnecting.isTerminal)
        XCTAssertEqual(RunActivityPhase.cancelled.label, "Stopped")
    }
}
