import XCTest
import CollectiveKit
@testable import CollectiveUI

@MainActor
final class VoiceSessionTests: XCTestCase {
    private func chat(_ app: AppModel, id: String) -> ChatModel {
        ChatModel(app: app, conversationId: id, newChatTarget: TargetOption(kind: "bot", id: "bot", name: "Voice bot"))
    }

    func testSameConversationResumesItsActiveSession() throws {
        let app = AppModel(credentials: MemoryCredentials(), draftRoot: nil, launchDemo: true, resetDemoDrafts: false)
        let chat = chat(app, id: "chat-voice")
        chat.startVoice()
        let original = try XCTUnwrap(app.voice)
        original.expanded = false
        chat.startVoice()
        XCTAssertEqual(app.voice?.id, original.id)
        XCTAssertTrue(original.expanded)
    }

    func testFinishedSavedSessionStartsFreshEvenInTheSameConversation() throws {
        let app = AppModel(credentials: MemoryCredentials(), draftRoot: nil, launchDemo: true, resetDemoDrafts: false)
        let chat = chat(app, id: "chat-voice")
        chat.startVoice()
        let original = try XCTUnwrap(app.voice)
        original.receive(["type": "status", "value": "ended"])
        chat.startVoice()
        XCTAssertNotEqual(app.voice?.id, original.id)
        XCTAssertEqual(app.voice?.status, "connecting")
    }

    func testNewConversationKeepsUnsavedSessionAndDoesNotResumeIt() throws {
        let app = AppModel(credentials: MemoryCredentials(), draftRoot: nil, launchDemo: true, resetDemoDrafts: false)
        let originalChat = chat(app, id: "original")
        originalChat.startVoice()
        let original = try XCTUnwrap(app.voice)
        original.receive(["type": "status", "value": "ended"])
        original.receive(["type": "saved", "unsaved": true])
        original.expanded = false
        let next = chat(app, id: "new-chat")
        next.startVoice()
        XCTAssertEqual(app.voice?.id, original.id)
        XCTAssertFalse(original.expanded)
        XCTAssertNotNil(next.alertMessage)
    }

    func testNewConversationEndsPriorSessionBeforeCreatingItsOwnAndRepeatedTapsDoNotDuplicate() async throws {
        let app = AppModel(credentials: MemoryCredentials(), draftRoot: nil, launchDemo: true, resetDemoDrafts: false)
        let originalChat = chat(app, id: "original")
        originalChat.startVoice()
        let original = try XCTUnwrap(app.voice)
        let next = chat(app, id: "new-chat")
        next.startVoice(); next.startVoice()
        for _ in 0..<200 {
            if app.voice?.id != original.id { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertEqual(original.status, "ended")
        XCTAssertNotEqual(app.voice?.id, original.id)
        XCTAssertEqual(app.voice?.conversationId, "new-chat")
        let freshID = app.voice?.id
        next.startVoice()
        XCTAssertEqual(app.voice?.id, freshID)
    }

    func testLeavingChatDuringTransitionDoesNotStartNewCapture() async throws {
        let app = AppModel(credentials: MemoryCredentials(), draftRoot: nil, launchDemo: true, resetDemoDrafts: false)
        let originalChat = chat(app, id: "original")
        originalChat.startVoice()
        let original = try XCTUnwrap(app.voice)
        let next = chat(app, id: "new-chat")
        next.startVoice(); next.deactivate()
        for _ in 0..<200 {
            if original.status == "ended" { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertEqual(app.voice?.id, original.id)
        XCTAssertEqual(original.status, "ended")
    }

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
