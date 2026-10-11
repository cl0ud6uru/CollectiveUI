import XCTest
import CollectiveKit
@testable import CollectiveUI

@MainActor
final class VoiceSessionTests: XCTestCase {
    func testApprovalReturnsToSameChatWithoutAcceptingTool() throws {
        let app = AppModel(credentials: MemoryCredentials(), draftRoot: nil, launchDemo: true, resetDemoDrafts: false)
        let chat = ChatModel(app: app, conversationId: "chat-voice", newChatTarget: TargetOption(kind: "bot", id: "bot", name: "Voice bot"))
        chat.startVoice()
        let voice = try XCTUnwrap(app.voice)
        voice.receive(["type": "approval"])
        XCTAssertFalse(voice.expanded)
        XCTAssertEqual(voice.conversationId, chat.conversationId)
        XCTAssertTrue(chat.approvalDecisions.isEmpty)
        XCTAssertNotNil(voice.notice)
    }

    func testInvalidLevelsAndEndedAudioCannotAnimateMeter() throws {
        let app = AppModel(credentials: MemoryCredentials(), draftRoot: nil, launchDemo: true, resetDemoDrafts: false)
        let chat = ChatModel(app: app, conversationId: "chat-voice", newChatTarget: TargetOption(kind: "bot", id: "bot", name: "Voice bot"))
        chat.startVoice()
        let voice = try XCTUnwrap(app.voice)
        voice.receive(["type": "level", "value": 0.9])
        XCTAssertEqual(voice.inputLevel.value, 0)
        voice.receive(["type": "status", "value": "connected"])
        voice.receive(["type": "level", "value": 2.0])
        XCTAssertEqual(voice.inputLevel.value, 1)
        voice.receive(["type": "level", "value": Double.nan])
        XCTAssertEqual(voice.inputLevel.value, 1)
        voice.receive(["type": "status", "value": "ended"])
        voice.receive(["type": "level", "value": 0.9])
        XCTAssertEqual(voice.inputLevel.value, 0)
    }

    func testUnsavedSpeechKeepsRetrySessionWhenDismissed() throws {
        let app = AppModel(credentials: MemoryCredentials(), draftRoot: nil, launchDemo: true, resetDemoDrafts: false)
        let chat = ChatModel(app: app, conversationId: "chat-voice", newChatTarget: TargetOption(kind: "bot", id: "bot", name: "Voice bot"))
        chat.startVoice()
        let voice = try XCTUnwrap(app.voice)
        voice.receive(["type": "status", "value": "ended"])
        voice.receive(["type": "saved", "unsaved": true])
        voice.dismiss()
        XCTAssertNotNil(app.voice)
        XCTAssertFalse(voice.expanded)
        voice.receive(["type": "saved", "unsaved": false])
        voice.dismiss()
        XCTAssertNil(app.voice)
    }
}
