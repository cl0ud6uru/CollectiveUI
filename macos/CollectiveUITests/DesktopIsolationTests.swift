import XCTest
import CollectiveKit
@testable import CollectiveUI

@MainActor
final class DesktopIsolationTests: XCTestCase {
    func testOldChatCannotSendApproveResumeOrStopUsingNewSession() async {
        let suite = "DesktopIsolation.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let draftRoot = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: draftRoot) }
        let credentials = MemoryCredentials(["baseURL": "https://fixture.invalid", "token": "first-token"])
        let app = AppModel(credentials: credentials, defaults: defaults, draftRoot: draftRoot,
            session: FixtureProtocol.session(), launchDemo: false)
        let chat = ChatModel(app: app, conversationId: "conversation", newChatTarget: TargetOption(kind: "app", id: "model", name: "Fixture"))
        chat.composerText = "Draft for first account"
        XCTAssertTrue(chat.canSend)
        app.completeSignIn(token: "second-token")
        XCTAssertFalse(chat.canSend)
        XCTAssertFalse(chat.canAnswerApprovals)
        XCTAssertFalse(chat.canRegenerate)
        chat.composerText = "Stale window draft"
        chat.send()
        chat.resume()
        chat.stop()
        XCTAssertFalse(chat.isStreaming)
        XCTAssertTrue(app.conversationStates.state(for: "conversation").text.isEmpty)
    }

    func testSavedMacDraftUsesOwnerOnlyPermissionsAndRestoresInterruptedRequest() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let server = URL(string: "https://fixture.invalid")!
        let store = ConversationStateStore(server: server, token: "fixture", root: root)
        let state = store.state(for: "chat")
        state.text = "Next draft"
        state.pendingSubmission = PendingChatSubmission(messageId: "original-id", text: "Original request", attachments: [], body: .object(["message": .object(["id": .string("original-id")])]))
        state.requiresStatusCheck = true
        store.flush()
        let directory = try XCTUnwrap(FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil).first)
        let file = try XCTUnwrap(FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil).first)
        XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: directory.path)[.posixPermissions] as? NSNumber)?.intValue, 0o700)
        XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        let restored = ConversationStateStore(server: server, token: "fixture", root: root).state(for: "chat")
        XCTAssertEqual(restored.text, "Next draft")
        XCTAssertEqual(restored.pendingSubmission?.messageId, "original-id")
        XCTAssertTrue(restored.requiresStatusCheck)
        let data = try String(contentsOf: file, encoding: .utf8)
        XCTAssertFalse(data.contains("fixture"), "The bearer token is never saved in a draft")
    }

    func testUnsentNewChatCanBeFoundAndReopenedAfterRelaunch() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let server = URL(string: "https://fixture.invalid")!
        let store = ConversationStateStore(server: server, token: "fixture", root: root)
        let state = store.state(for: "never-sent")
        state.newChatTarget = TargetOption(kind: "app", id: "chosen-model", name: "Chosen Model")
        state.text = "Keep this multiline\ndraft"
        store.flush()
        let restored = ConversationStateStore(server: server, token: "fixture", root: root)
        XCTAssertEqual(restored.recoverableIDs, ["never-sent"])
        XCTAssertEqual(restored.state(for: "never-sent").newChatTarget?.id, "chosen-model")
        XCTAssertEqual(restored.state(for: "never-sent").text, "Keep this multiline\ndraft")
        XCTAssertTrue(ConversationStateStore(server: server, token: "other-session", root: root).recoverableIDs.isEmpty)
    }

    func testEstablishedConversationMarkerSurvivesRelaunch() {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let server = URL(string: "https://fixture.invalid")!
        let store = ConversationStateStore(server: server, token: "fixture", root: root)
        let state = store.state(for: "accepted")
        state.isEstablished = true
        state.text = "Next draft"
        store.flush()
        let restored = ConversationStateStore(server: server, token: "fixture", root: root).state(for: "accepted")
        XCTAssertTrue(restored.isEstablished)
        XCTAssertNil(restored.newChatTarget)
        XCTAssertEqual(restored.text, "Next draft")
    }
}
