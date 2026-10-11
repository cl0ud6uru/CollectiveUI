import XCTest
@testable import CollectiveKit

final class VoiceRequestPolicyTests: XCTestCase {
    private let policy = VoiceRequestPolicy(conversationId: "chatA")

    func testVoiceRequestsStayInMobileNamespace() throws {
        let url = try policy.validate(path: "/api/voice/turn?conversationId=chatA&messageId=reply", method: "GET", body: nil)
        XCTAssertEqual(url.path, "/api/mobile/v1/voice/turn")
        XCTAssertEqual(url.queryItems?.count, 2)
        XCTAssertNoThrow(try policy.validate(path: "/api/voice/session", method: "POST", body: .object(["chatId": .string("chatA"), "botId": .string("bot")])) )
    }

    func testRejectsOtherChatsOriginsAndMethods() {
        for path in ["https://evil.example/api/voice/turn?conversationId=chatA", "//evil.example/api/voice/session", "/api/voice/../chat", "/api/voice/%74urn?conversationId=chatA", "/api/voice/turn?conversationId=chatB", "/api/voice/avatar?conversationId=chatA&conversationId=chatB", "/api/voice/session#fragment", "/api/chat"] {
            XCTAssertThrowsError(try policy.validate(path: path, method: "GET", body: nil), path)
        }
        XCTAssertThrowsError(try policy.validate(path: "/api/voice/turn", method: "POST", body: .object(["conversationId": .string("chatB")])))
        XCTAssertThrowsError(try policy.validate(path: "/api/voice/session", method: "POST", body: .object(["chatId": .string("chatA"), "conversationId": .string("chatB")])))
        XCTAssertThrowsError(try policy.validate(path: "/api/voice/reaction", method: "GET", body: nil))
        XCTAssertThrowsError(try policy.validate(path: "/api/voice/session", method: "DELETE", body: nil))
    }

    func testRejectsOversizedBridgeBodies() {
        XCTAssertThrowsError(try policy.validate(path: "/api/voice/turn", method: "POST", body: .object(["conversationId": .string("chatA"), "text": .string(String(repeating: "x", count: 64001))])))
    }
}
