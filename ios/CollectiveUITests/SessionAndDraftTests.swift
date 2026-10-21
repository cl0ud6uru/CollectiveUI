import XCTest
#if os(iOS)
import UIKit
#endif
import CollectiveKit
@testable import CollectiveUI

final class MemoryCredentials: CredentialStore {
    var values: [String: String]
    var operations: [String] = []
    var rejectsTokenRemoval = false
    var rejectedWrites: Set<String> = []
    init(_ values: [String: String] = [:]) { self.values = values }
    func set(_ value: String, for account: String) {
        operations.append("set:\(account)")
        if !rejectedWrites.contains(account) { values[account] = value }
    }
    func string(for account: String) -> String? { operations.append("read:\(account)"); return values[account] }
    func remove(_ account: String) {
        operations.append("remove:\(account)")
        if account == "token" && rejectsTokenRemoval { return }
        values.removeValue(forKey: account)
    }
}

@MainActor
final class SessionAndDraftTests: XCTestCase {
    private var root: URL!
    private var defaults: UserDefaults!
    private var suite: String!
    private let server = URL(string: "https://qa.example.invalid/portal")!
    private let target = TargetOption(kind: "app", id: "qa-model", name: "QA model")

    override func setUp() async throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        suite = "CollectiveUI.Tests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)!
    }

    override func tearDown() async throws {
        defaults.removePersistentDomain(forName: suite)
        try? FileManager.default.removeItem(at: root)
        FixtureProtocol.handler = { _ in .init() }
    }

    private func app(token: String = "fixture-a", server: URL? = nil) -> AppModel {
        let credentials = MemoryCredentials(["baseURL": (server ?? self.server).absoluteString, "token": token])
        return AppModel(credentials: credentials, defaults: defaults, draftRoot: root, launchDemo: false)
    }

    private var attachment: ComposerAttachment {
        ComposerAttachment(id: UUID(), filename: "fixture.png", mediaType: "image/png", progress: 1,
            uploaded: UploadedFile(id: "qa-file", url: "/api/files/qa-file", filename: "fixture.png", mediaType: "image/png", readable: true),
            previewData: Data([1, 2, 3]))
    }

    func testCurrentSessionRoleOverridesCachedAdministratorShell() async throws {
        FixtureProtocol.handler = { _ in .init(data: Data(#"{"user":{"id":"member","name":"Member","isAdmin":false},"deviceName":"QA"}"#.utf8)) }
        let model = AppModel(credentials: MemoryCredentials(["baseURL": server.absoluteString, "token": "fixture"]),
            defaults: defaults, draftRoot: root, session: FixtureProtocol.session(), launchDemo: false)
        model.shell = try JSONDecoder().decode(ShellResponse.self, from: Data(#"{"user":{"id":"member","name":"Member","isAdmin":true}}"#.utf8))
        await model.loadSessionInfo()
        XCTAssertTrue(model.settingsAccess.isValidated)
        XCTAssertFalse(model.settingsAccess.isAdmin)
        XCTAssertEqual(model.sessionInfo?.user?.isAdmin, false)
    }

    func testFailedSessionValidationDoesNotTrustCachedAdministrator() async {
        FixtureProtocol.handler = { _ in .init(status: 503) }
        let model = AppModel(credentials: MemoryCredentials(["baseURL": server.absoluteString, "token": "fixture"]),
            defaults: defaults, draftRoot: root, session: FixtureProtocol.session(), launchDemo: false)
        await model.loadSessionInfo()
        XCTAssertFalse(model.settingsAccess.isValidated)
        XCTAssertFalse(model.settingsAccess.isAdmin)
        XCTAssertFalse(model.settingsAccess.isValidating)
        XCTAssertTrue(model.settingsAccess.shouldDismissAdminDestinations)
        XCTAssertNil(model.sessionInfo)
    }

    func testForegroundAdministratorRevalidationPreservesExistingBrowserPolicy() async {
        let admin = Data(#"{"user":{"id":"admin","name":"Admin","isAdmin":true},"deviceName":"QA"}"#.utf8)
        FixtureProtocol.handler = { _ in .init(data: admin) }
        let model = AppModel(credentials: MemoryCredentials(["baseURL": server.absoluteString, "token": "fixture"]),
            defaults: defaults, draftRoot: root, session: FixtureProtocol.session(), launchDemo: false)
        await model.loadSessionInfo()
        XCTAssertTrue(model.settingsAccess.isAdmin)
        let requested = expectation(description: "Foreground session check started")
        FixtureProtocol.handler = { _ in
            requested.fulfill()
            return .init(data: admin, delay: 0.3)
        }
        let refresh = Task { await model.loadSessionInfo() }
        await fulfillment(of: [requested], timeout: 3)
        XCTAssertTrue(model.settingsAccess.isValidating)
        XCTAssertFalse(model.settingsAccess.isAdmin, "New admin opens remain fail-closed")
        XCTAssertFalse(model.settingsAccess.shouldDismissAdminDestinations, "Existing browser/path survives foreground validation")
        await refresh.value
        XCTAssertTrue(model.settingsAccess.isAdmin)
        XCTAssertFalse(model.settingsAccess.isValidating)
        XCTAssertFalse(model.settingsAccess.shouldDismissAdminDestinations)
    }

    func testLateResponsesCannotRepopulateAfterServerChange() async {
        let shellRequested = expectation(description: "Shell request started")
        let sessionRequested = expectation(description: "Session request started")
        FixtureProtocol.handler = { request in
            if request.url!.path.hasSuffix("/shell") {
                shellRequested.fulfill()
                return .init(data: Data(#"{"user":{"id":"admin","name":"Admin","isAdmin":true}}"#.utf8), delay: 0.3)
            }
            if request.httpMethod == "GET", request.url!.path.hasSuffix("/session") {
                sessionRequested.fulfill()
                return .init(data: Data(#"{"user":{"id":"admin","name":"Admin","isAdmin":true},"deviceName":"QA"}"#.utf8), delay: 0.3)
            }
            return .init()
        }
        let model = AppModel(credentials: MemoryCredentials(["baseURL": server.absoluteString, "token": "fixture"]),
            defaults: defaults, draftRoot: root, session: FixtureProtocol.session(), launchDemo: false)
        let shellTask = Task { await model.refreshShell() }
        let sessionTask = Task { await model.loadSessionInfo() }
        await fulfillment(of: [shellRequested, sessionRequested], timeout: 3)
        model.changeServer()
        await shellTask.value
        await sessionTask.value
        XCTAssertNil(model.shell)
        XCTAssertNil(model.sessionInfo)
        XCTAssertFalse(model.settingsAccess.isAdmin)
        XCTAssertEqual(model.phase, .setup)
    }

    private func botStatusModel() throws -> AppModel {
        let model = AppModel(credentials: MemoryCredentials(["baseURL": server.absoluteString, "token": "fixture"]),
            defaults: defaults, draftRoot: root, session: FixtureProtocol.session(), launchDemo: false)
        model.shell = try JSONDecoder().decode(ShellResponse.self, from: Data(#"{"bots":[{"kind":"bot","id":"research","name":"Researcher","status":"waiting"},{"kind":"bot","id":"writer","name":"Writer","status":"working"}]}"#.utf8))
        return model
    }

    func testBotSnapshotsReplaceWorkAndClearMissingOrUnauthorizedActivity() async throws {
        let model = try botStatusModel()
        FixtureProtocol.handler = { _ in .init(data: Data(#"{"research":"working","writer":null}"#.utf8)) }
        await model.refreshBotStatuses()
        XCTAssertEqual(model.shell?.bots.first?.status, "working")
        XCTAssertNil(model.shell?.bots.last?.status)
        FixtureProtocol.handler = { _ in .init(data: Data(#"{"writer":"waiting"}"#.utf8)) }
        await model.refreshBotStatuses()
        XCTAssertNil(model.shell?.bots.first?.status)
        XCTAssertEqual(model.shell?.bots.last?.status, "waiting")
        FixtureProtocol.handler = { _ in .init(status: 401) }
        await model.refreshBotStatuses()
        XCTAssertTrue(model.shell?.bots.allSatisfy { $0.status == nil } ?? true)
    }

    func testLateBotActivityCannotRepopulateAfterServerChange() async throws {
        let model = try botStatusModel()
        let requested = expectation(description: "Bot activity request started")
        FixtureProtocol.handler = { request in
            if request.url!.path.hasSuffix("/bot-statuses") {
                requested.fulfill()
                return .init(data: Data(#"{"research":"working"}"#.utf8), delay: 0.3)
            }
            return .init()
        }
        let task = Task { await model.refreshBotStatuses() }
        await fulfillment(of: [requested], timeout: 3)
        model.changeServer()
        await task.value
        XCTAssertNil(model.shell)
    }

    func testNewShellSupersedesPendingBotActivitySnapshot() async throws {
        let model = try botStatusModel()
        let requested = expectation(description: "Older activity request started")
        FixtureProtocol.handler = { request in
            if request.url!.path.hasSuffix("/bot-statuses") {
                requested.fulfill()
                return .init(data: Data(#"{"research":"working"}"#.utf8), delay: 0.3)
            }
            return .init(data: Data(#"{"bots":[{"kind":"bot","id":"research","name":"Researcher","status":null}]}"#.utf8))
        }
        let task = Task { await model.refreshBotStatuses() }
        await fulfillment(of: [requested], timeout: 3)
        await model.refreshShell()
        await task.value
        XCTAssertNil(model.shell?.bots.first?.status)
    }

    func testReconstructedChatRetainsIsolatedDraftAndAttachmentReferences() {
        let model = app()
        let queen = ChatModel(app: model, conversationId: "queen", newChatTarget: nil)
        queen.composerText = "First line\nSecond line"
        queen.attachments = [attachment]
        let hermes = ChatModel(app: model, conversationId: "hermes", newChatTarget: nil)
        XCTAssertEqual(hermes.composerText, "")
        hermes.composerText = "Hermes only"
        let reopened = ChatModel(app: model, conversationId: "queen", newChatTarget: nil)
        XCTAssertEqual(reopened.composerText, "First line\nSecond line")
        XCTAssertEqual(reopened.attachments, queen.attachments)
        queen.attachments[0].progress = 0.5
        XCTAssertEqual(reopened.attachments[0].progress, 0.5, "An upload completing in the old model updates the current draft")
    }

    func testNewChatRouteUsesConversationIdentityAndSuccessfulClearDoesNotLeak() {
        let model = app()
        let original = ChatModel(app: model, conversationId: "new-a", newChatTarget: target)
        original.composerText = "Only this conversation"
        XCTAssertEqual(ChatModel(app: model, conversationId: "new-a", newChatTarget: nil).composerText, original.composerText)
        XCTAssertEqual(ChatModel(app: model, conversationId: "new-b", newChatTarget: target).composerText, "")
        original.composerText = ""
        XCTAssertEqual(ChatModel(app: model, conversationId: "new-a", newChatTarget: nil).composerText, "")
    }

    func testDraftRelaunchRestoresFilesAndSeparatesServersAndAccounts() {
        let original = app()
        let draft = original.conversationStates.state(for: "same-id")
        draft.text = "Private draft"
        draft.attachments = [attachment]
        original.conversationStates.flush()
        let restored = app().conversationStates.state(for: "same-id")
        XCTAssertEqual(restored.text, draft.text)
        XCTAssertEqual(restored.attachments, draft.attachments)
        XCTAssertEqual(app(token: "fixture-b").conversationStates.state(for: "same-id").text, "")
        XCTAssertEqual(app(server: URL(string: "https://other.example.invalid/portal")!).conversationStates.state(for: "same-id").text, "")
    }

    func testInterruptedUploadCannotBlockRestoredComposerForever() {
        let original = app()
        let draft = original.conversationStates.state(for: "pending-file")
        var pending = attachment
        pending.uploaded = nil
        draft.attachments = [pending]
        draft.flush()
        let restored = app().conversationStates.state(for: "pending-file")
        XCTAssertFalse(restored.attachments[0].isUploading)
        XCTAssertNotNil(restored.attachments[0].errorText)
    }

    func testLogoutWipesDraftAndOldAsyncReferencesCannotResurrectIt() {
        let original = app()
        let oldState = original.conversationStates.state(for: "chat")
        oldState.text = "Private draft"
        oldState.flush()
        original.handleUnauthorized()
        XCTAssertEqual(oldState.text, "")
        oldState.text = "Late callback"
        oldState.flush()
        XCTAssertEqual(app().conversationStates.state(for: "chat").text, "")
    }

    func testDeletingDraftRemovesPersistedState() {
        let original = app()
        let state = original.conversationStates.state(for: "deleted")
        state.text = "Discard on delete"
        state.flush()
        original.conversationStates.remove("deleted")
        state.text = "Late callback"
        state.flush()
        XCTAssertEqual(app().conversationStates.state(for: "deleted").text, "")
    }

    func testLateDeleteCannotRemoveReplacementSessionDraftWithSameConversationID() async {
        let requested = expectation(description: "Delete requested")
        let gate = FixtureDeliveryGate()
        FixtureProtocol.handler = { request in
            if request.httpMethod == "DELETE", request.url?.path.hasSuffix("/conversations/same-id") == true {
                requested.fulfill()
                return .init(deliveryGate: gate)
            }
            return .init()
        }
        let credentials = MemoryCredentials(["baseURL": server.absoluteString, "token": "first"])
        let model = AppModel(credentials: credentials, defaults: defaults, draftRoot: root,
            session: FixtureProtocol.session(), launchDemo: false)
        let deletion = Task { await model.delete(ConversationSummary(id: "same-id", title: "Old chat")) }
        await fulfillment(of: [requested], timeout: 3)
        model.completeSignIn(token: "replacement")
        let draft = model.conversationStates.state(for: "same-id")
        draft.text = "Replacement session draft"
        draft.flush()
        gate.release()
        await deletion.value
        XCTAssertEqual(draft.text, "Replacement session draft")
        XCTAssertEqual(model.conversationStates.state(for: "same-id").text, "Replacement session draft")
        let restored = AppModel(credentials: credentials, defaults: defaults, draftRoot: root,
            session: FixtureProtocol.session(), launchDemo: false)
        XCTAssertEqual(restored.conversationStates.state(for: "same-id").text, "Replacement session draft")
    }

    func testTrueDemoNeverTouchesExistingRealCredentials() async {
        let seeded = ["baseURL": server.absoluteString, "token": "existing-unrelated-fixture"]
        for action in ["logout", "401", "server"] {
            let credentials = MemoryCredentials(seeded)
            let demo = AppModel(credentials: credentials, defaults: defaults, draftRoot: root, launchDemo: true)
            XCTAssertTrue(demo.isDemoSession)
            switch action {
            case "logout": await demo.signOut()
            case "401": demo.handleUnauthorized()
            default: demo.changeServer()
            }
            XCTAssertEqual(credentials.operations, [], "Demo \(action) must not read, write, or delete real credentials")
            XCTAssertEqual(credentials.values, seeded)
            XCTAssertNil(defaults.string(forKey: "baseURL"))
        }
    }

    func testRealSignInReachedFromDemoPersistsForNormalRelaunchAnd401ClearsIt() {
        let credentials = MemoryCredentials(["baseURL": "https://unrelated.example.invalid", "token": "old-fixture"])
        let demo = AppModel(credentials: credentials, defaults: defaults, draftRoot: root, launchDemo: true)
        demo.changeServer()
        demo.useServer(server, info: MobileInfo(enabled: true, appName: "QA", logoEmoji: "✨", apiVersion: 1))
        XCTAssertFalse(demo.isDemoSession)
        demo.completeSignIn(token: "new-live-fixture")
        XCTAssertEqual(credentials.values["token"], "new-live-fixture")
        let relaunched = AppModel(credentials: credentials, defaults: defaults, draftRoot: root, launchDemo: false)
        XCTAssertEqual(relaunched.phase, .main)
        XCTAssertEqual(relaunched.token, "new-live-fixture")
        relaunched.handleUnauthorized()
        XCTAssertNil(credentials.values["token"])
        XCTAssertEqual(relaunched.phase, .signIn)
    }

    func testRealLogoutReachedFromDemoDeletesRealToken() async {
        let credentials = MemoryCredentials()
        FixtureProtocol.handler = { _ in .init() }
        let demo = AppModel(credentials: credentials, defaults: defaults, draftRoot: root, session: FixtureProtocol.session(), launchDemo: true)
        demo.changeServer()
        demo.useServer(server, info: DemoMode.info)
        demo.completeSignIn(token: "real-session-fixture")
        await demo.signOut()
        XCTAssertNil(credentials.values["token"])
        XCTAssertTrue(credentials.operations.contains("remove:token"))
    }

    func testReturningFromRealServerToDemoNeverStoresFixtureCredentials() {
        let credentials = MemoryCredentials(["baseURL": server.absoluteString, "token": "real-fixture"])
        let model = AppModel(credentials: credentials, defaults: defaults, draftRoot: root, launchDemo: false)
        let existing = credentials.values
        credentials.operations = []
        model.useServer(DemoMode.baseURL, info: DemoMode.info)
        model.completeSignIn(token: DemoMode.token)
        XCTAssertTrue(model.isDemoSession)
        model.handleUnauthorized()
        model.changeServer()
        XCTAssertEqual(credentials.operations, [])
        XCTAssertEqual(credentials.values, existing)
    }

    func testSelectingRealServerFromDemoCannotRestoreAnUnrelatedTokenBeforeSignIn() {
        let credentials = MemoryCredentials(["baseURL": "https://unrelated.example.invalid", "token": "unrelated-fixture"])
        let demo = AppModel(credentials: credentials, defaults: defaults, draftRoot: root, launchDemo: true)
        XCTAssertEqual(credentials.operations, [])
        demo.useServer(server, info: DemoMode.info)
        XCTAssertNil(credentials.values["token"])
        let relaunched = AppModel(credentials: credentials, defaults: defaults, draftRoot: root, launchDemo: false)
        XCTAssertEqual(relaunched.serverURL, server)
        XCTAssertEqual(relaunched.phase, .signIn)
        XCTAssertNil(relaunched.token)
    }

    func testResettingDemoDraftsPreservesRealSessionDraftsAndCredentials() {
        let real = app()
        real.conversationStates.state(for: "chat").text = "Real session draft"
        real.conversationStates.flush()
        let seeded = ["baseURL": server.absoluteString, "token": "fixture-a"]
        let credentials = MemoryCredentials(seeded)
        let demo = AppModel(credentials: credentials, defaults: defaults, draftRoot: root, launchDemo: true)
        demo.conversationStates.state(for: "chat").text = "Fixture draft"
        demo.conversationStates.flush()
        let reset = AppModel(credentials: credentials, defaults: defaults, draftRoot: root,
            launchDemo: true, resetDemoDrafts: true)
        XCTAssertEqual(reset.conversationStates.state(for: "chat").text, "")
        XCTAssertEqual(app().conversationStates.state(for: "chat").text, "Real session draft")
        XCTAssertEqual(credentials.values, seeded)
        XCTAssertEqual(credentials.operations, [], "Resetting fixture drafts must never access real credentials")
    }

    func testStoppedMarkerSurvivesRelaunchAndIsScopedToTheExactResponse() {
        let original = app()
        let state = original.conversationStates.state(for: "chat")
        let user = UIMessage(id: "user-a", role: .user, parts: [.text(TextPart(text: "Question"))])
        state.markStopped(messageId: "stopped-local", parentId: user.id)
        let restored = app().conversationStates.state(for: "chat")
        let localThread = restored.reconcileStoppedReplies(in: [user])
        XCTAssertTrue(restored.showsStoppedPlaceholder(for: localThread.last!))
        let emptyServerReply = UIMessage(id: "server-a", role: .assistant)
        let reconciled = restored.reconcileStoppedReplies(in: [user, emptyServerReply])
        XCTAssertEqual(reconciled.count, 2)
        XCTAssertTrue(restored.showsStoppedPlaceholder(for: emptyServerReply))
        let partial = UIMessage(id: "server-a", role: .assistant, parts: [.text(TextPart(text: "Partial answer"))])
        XCTAssertFalse(restored.showsStoppedPlaceholder(for: partial))
        let nextUser = UIMessage(id: "user-b", role: .user)
        XCTAssertFalse(restored.preventsResume(in: [user, emptyServerReply, nextUser]))
        let replacement = UIMessage(id: "replacement-a", role: .assistant)
        _ = restored.reconcileStoppedReplies(in: [user, replacement])
        XCTAssertFalse(restored.showsStoppedPlaceholder(for: replacement))
        XCTAssertFalse(restored.preventsResume(in: [user, replacement]))
    }

    private func savedDraftFile() throws -> URL {
        let directory = try XCTUnwrap(FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil).first)
        return try XCTUnwrap(FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            .first(where: { $0.pathExtension == "json" }))
    }

    func testWriteFailureIsVisibleAndRetryPreservesTextAndFiles() throws {
        let model = app()
        let state = model.conversationStates.state(for: "unsaved")
        try Data("Temporary storage barrier".utf8).write(to: root)
        state.text = "Keep this multiline\ndraft"
        let retainedAttachment = attachment
        state.attachments = [retainedAttachment]
        XCTAssertFalse(state.flush())
        XCTAssertEqual(state.persistenceIssue, .writeFailed)
        XCTAssertTrue(model.conversationStates.recoverableIDs.contains("unsaved"))
        XCTAssertEqual(state.text, "Keep this multiline\ndraft")
        XCTAssertEqual(state.attachments, [retainedAttachment])
        try FileManager.default.removeItem(at: root)
        XCTAssertTrue(state.retryPersistence())
        XCTAssertNil(state.persistenceIssue)
        let restored = app().conversationStates.state(for: "unsaved")
        XCTAssertEqual(restored.text, state.text)
        XCTAssertEqual(restored.attachments, state.attachments)
    }

    func testDebouncedWriteFailureBecomesObservableWithoutLeavingTheChat() async throws {
        // Keep the store alive: its save closure intentionally captures it weakly.
        let model = app()
        let active = model.conversationStates.state(for: "debounced")
        try Data("Temporary storage barrier".utf8).write(to: root)
        active.text = "An unsaved draft"
        for _ in 0..<100 where active.persistenceIssue == nil {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(active.persistenceIssue, .writeFailed)
        XCTAssertEqual(active.text, "An unsaved draft")
    }

    func testSendDoesNotStartTransportOrClearComposerWhenIdentityCannotBeSaved() throws {
        let model = AppModel(credentials: MemoryCredentials(["baseURL": server.absoluteString, "token": "fixture-a"]),
            defaults: defaults, draftRoot: root, session: FixtureProtocol.session(), launchDemo: false)
        let chat = ChatModel(app: model, conversationId: "blocked-send", newChatTarget: target)
        chat.composerText = "Original request"
        let retainedAttachment = attachment
        chat.attachments = [retainedAttachment]
        try Data("Temporary storage barrier".utf8).write(to: root)
        FixtureProtocol.handler = { _ in XCTFail("Failed persistence must prevent all transport"); return .init() }
        chat.send()
        XCTAssertFalse(chat.isStreaming)
        XCTAssertTrue(chat.messages.isEmpty)
        XCTAssertEqual(chat.composerText, "Original request")
        XCTAssertEqual(chat.attachments, [retainedAttachment])
        XCTAssertNotNil(chat.draftPersistenceMessage)
        XCTAssertFalse(chat.canSend)
        XCTAssertFalse(chat.needsMessageStatusCheck, "No request was started")
        try FileManager.default.removeItem(at: root)
        chat.retryDraftPersistence()
        XCTAssertNil(chat.draftPersistenceMessage)
        XCTAssertTrue(chat.canSend, "Retry saving must not send; the user chooses Send afterward")
    }

    func testRequestIdentityAndAdmissionFenceExistOnDiskBeforeFirstTransport() async throws {
        let model = AppModel(credentials: MemoryCredentials(["baseURL": server.absoluteString, "token": "fixture-a"]),
            defaults: defaults, draftRoot: root, session: FixtureProtocol.session(), launchDemo: false)
        let chat = ChatModel(app: model, conversationId: "durable-send", newChatTarget: target)
        chat.composerText = "Original immutable request"
        let requested = expectation(description: "Offline transport started")
        let storageRoot = root!
        FixtureProtocol.handler = { request in
            guard request.httpMethod == "POST", request.url?.path.hasSuffix("/chat") == true else { return .init(status: 404) }
            let sent = FixtureProtocol.body(request)
            do {
                let directory = try XCTUnwrap(FileManager.default.contentsOfDirectory(at: storageRoot, includingPropertiesForKeys: nil).first)
                let file = try XCTUnwrap(FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil).first)
                let saved = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: file))
                XCTAssertEqual(saved["pendingSubmission"]?["messageId"], sent?["message"]?["id"])
                XCTAssertEqual(saved["pendingSubmission"]?["body"], sent)
                XCTAssertEqual(saved["requiresStatusCheck"]?.boolValue, true)
            } catch {
                XCTFail("Original request was not durable before transport: \(error)")
            }
            requested.fulfill()
            return .init(contentType: "text/event-stream", data: Data(), finish: false)
        }
        chat.send()
        await fulfillment(of: [requested], timeout: 3)
        chat.composerText = "Newer unsent draft"
        XCTAssertTrue(chat.conversationState.flush())
        let restored = app().conversationStates.state(for: "durable-send")
        XCTAssertEqual(restored.pendingSubmission?.messageId, chat.conversationState.pendingSubmission?.messageId)
        XCTAssertEqual(restored.pendingSubmission?.text, "Original immutable request")
        XCTAssertEqual(restored.text, "Newer unsent draft")
        XCTAssertTrue(restored.requiresStatusCheck)
        chat.deactivate()
    }

    func testNilStorageIsExplicitlyUnavailableAndCannotSubmit() {
        let model = AppModel(credentials: MemoryCredentials(["baseURL": server.absoluteString, "token": "fixture-a"]),
            defaults: defaults, draftRoot: nil, session: FixtureProtocol.session(), launchDemo: false)
        let chat = ChatModel(app: model, conversationId: "no-storage", newChatTarget: target)
        chat.composerText = "Keep this in memory"
        XCTAssertEqual(chat.conversationState.persistenceIssue, .unavailable)
        XCTAssertNotNil(chat.draftPersistenceMessage)
        XCTAssertFalse(chat.canSend)
        XCTAssertFalse(chat.conversationState.flush())
    }

    func testCorruptSavedStateCannotBeOverwrittenOrSubmitted() throws {
        let first = app()
        let state = first.conversationStates.state(for: "corrupt")
        state.text = "Previously saved draft"
        state.pendingSubmission = PendingChatSubmission(messageId: "original-id", text: "Pending", attachments: [], body: .object(["message": .object(["id": "original-id"])]))
        state.requiresStatusCheck = true
        XCTAssertTrue(state.flush())
        let file = try savedDraftFile()
        let broken = Data("{broken saved state".utf8)
        try broken.write(to: file)
        let relaunched = app()
        let chat = ChatModel(app: relaunched, conversationId: "corrupt", newChatTarget: target)
        XCTAssertEqual(chat.conversationState.persistenceIssue, .readFailed)
        chat.composerText = "New text must remain in memory"
        XCTAssertFalse(chat.conversationState.flush())
        XCTAssertFalse(chat.canSend)
        XCTAssertFalse(chat.canRegenerate)
        XCTAssertEqual(try Data(contentsOf: file), broken, "Unknown admitted identity must not be overwritten")
    }

    func testRetryLoadingRestoresRepairedSavedIdentityWithoutDiscardingNewText() throws {
        let first = app()
        let state = first.conversationStates.state(for: "repaired")
        state.text = "Saved draft"
        state.pendingSubmission = PendingChatSubmission(messageId: "original-id", text: "Pending", attachments: [], body: .object(["message": .object(["id": "original-id"])]))
        state.requiresStatusCheck = true
        XCTAssertTrue(state.flush())
        let file = try savedDraftFile()
        let good = try Data(contentsOf: file)
        try Data("{broken".utf8).write(to: file)
        let relaunched = app()
        let restored = relaunched.conversationStates.state(for: "repaired")
        restored.text = "New unsaved text"
        try good.write(to: file)
        XCTAssertFalse(restored.retryPersistence(), "Loading must not discard newer in-memory text")
        XCTAssertEqual(restored.text, "New unsaved text")
        XCTAssertEqual(try Data(contentsOf: file), good)
        restored.text = ""
        XCTAssertTrue(restored.retryPersistence())
        XCTAssertNil(restored.persistenceIssue)
        XCTAssertEqual(restored.text, "Saved draft")
        XCTAssertEqual(restored.pendingSubmission?.messageId, "original-id")
        XCTAssertTrue(restored.requiresStatusCheck)
    }

    func testFailedLaterWritePreservesLastDurablePendingIdentity() throws {
        let first = app()
        let state = first.conversationStates.state(for: "last-good")
        state.pendingSubmission = PendingChatSubmission(messageId: "original-id", text: "Pending", attachments: [], body: .object(["message": .object(["id": "original-id"])]))
        state.requiresStatusCheck = true
        XCTAssertTrue(state.flush())
        let file = try savedDraftFile()
        let backup = file.appendingPathExtension("last-good")
        try FileManager.default.moveItem(at: file, to: backup)
        try FileManager.default.createDirectory(at: file, withIntermediateDirectories: false)
        state.text = "Newer unsaved draft"
        XCTAssertFalse(state.flush())
        XCTAssertEqual(state.persistenceIssue, .writeFailed)
        XCTAssertEqual(state.pendingSubmission?.messageId, "original-id")
        XCTAssertTrue(state.requiresStatusCheck)
        try FileManager.default.removeItem(at: file)
        try FileManager.default.moveItem(at: backup, to: file)
        let relaunched = app().conversationStates.state(for: "last-good")
        XCTAssertEqual(relaunched.pendingSubmission?.messageId, "original-id")
        XCTAssertTrue(relaunched.requiresStatusCheck)
        XCTAssertTrue(state.retryPersistence())
        XCTAssertEqual(app().conversationStates.state(for: "last-good").text, "Newer unsaved draft")
    }

    func testFreshCommandKeepsDestinationAndDraftWhenSavingFails() async throws {
        let model = AppModel(credentials: MemoryCredentials(["baseURL": server.absoluteString, "token": "fixture-a"]),
            defaults: defaults, draftRoot: root, session: FixtureProtocol.session(), launchDemo: false)
        var hermes = TargetOption(kind: "bot", id: "fixture-hermes", name: "Fixture Hermes")
        hermes.hermes = true
        let chat = ChatModel(app: model, conversationId: "blocked-command", newChatTarget: hermes)
        chat.composerText = "/new"
        try Data("Temporary storage barrier".utf8).write(to: root)
        FixtureProtocol.handler = { _ in XCTFail("Command must not run without durable destination"); return .init() }
        chat.send()
        for _ in 0..<100 where chat.isExecutingCommand { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertFalse(chat.isExecutingCommand)
        XCTAssertEqual(chat.composerText, "/new")
        XCTAssertNotNil(chat.draftPersistenceMessage)
        let destination = try XCTUnwrap(chat.conversationState.pendingCommand?.nextId)
        try FileManager.default.removeItem(at: root)
        chat.retryDraftPersistence()
        let restored = app().conversationStates.state(for: "blocked-command")
        XCTAssertEqual(restored.pendingCommand?.nextId, destination)
        XCTAssertEqual(restored.text, "/new")
    }

    func testRegenerateDoesNotMutateHistoryWhenAdmissionFenceCannotBeSaved() throws {
        let model = AppModel(credentials: MemoryCredentials(["baseURL": server.absoluteString, "token": "fixture-a"]),
            defaults: defaults, draftRoot: root, session: FixtureProtocol.session(), launchDemo: false)
        let chat = ChatModel(app: model, conversationId: "blocked-regenerate", newChatTarget: target)
        chat.messages = [UIMessage(id: "user", role: .user), UIMessage(id: "assistant", role: .assistant)]
        let before = chat.messages
        try Data("Temporary storage barrier".utf8).write(to: root)
        FixtureProtocol.handler = { _ in XCTFail("Regenerate must not run without its fence"); return .init() }
        chat.regenerate(assistantMessageId: "assistant")
        XCTAssertFalse(chat.isStreaming)
        XCTAssertEqual(chat.messages, before)
        XCTAssertNotNil(chat.draftPersistenceMessage)
    }

    func testFirstAtomicSnapshotCannotRestoreSubmittedDraftAsANewMessage() async throws {
        let model = AppModel(credentials: MemoryCredentials(["baseURL": server.absoluteString, "token": "fixture-a"]),
            defaults: defaults, draftRoot: root, session: FixtureProtocol.session(), launchDemo: false)
        let chat = ChatModel(app: model, conversationId: "atomic-send", newChatTarget: target)
        let file = attachment
        chat.composerText = "Original submitted draft"
        chat.attachments = [file]
        let persist = try XCTUnwrap(chat.conversationState.save)
        var firstSnapshot: Data?
        var snapshotFile: URL?
        chat.conversationState.save = {
            let saved = persist()
            if saved && firstSnapshot == nil {
                do {
                    let url = try self.savedDraftFile()
                    snapshotFile = url
                    firstSnapshot = try Data(contentsOf: url)
                } catch { XCTFail("Could not capture first committed snapshot: \(error)") }
            }
            return saved
        }
        let originalRequested = expectation(description: "Original offline request started")
        FixtureProtocol.handler = { request in
            if request.httpMethod == "POST", request.url?.path.hasSuffix("/chat") == true { originalRequested.fulfill() }
            return .init(contentType: "text/event-stream", data: Data(), finish: false)
        }
        chat.send()
        await fulfillment(of: [originalRequested], timeout: 3)
        chat.deactivate()
        chat.conversationState.save = persist
        let captured = try XCTUnwrap(firstSnapshot)
        let originalFile = try XCTUnwrap(snapshotFile)
        let pending = try XCTUnwrap(chat.conversationState.pendingSubmission)
        // Reopen from exactly the first atomic save, as if the process stopped
        // before the later cleared-composer flush. No process or real app is killed.
        let replicaRoot = root.appendingPathComponent("relaunch", isDirectory: true)
        let replicaScope = replicaRoot.appendingPathComponent(originalFile.deletingLastPathComponent().lastPathComponent)
        try FileManager.default.createDirectory(at: replicaScope, withIntermediateDirectories: true)
        try captured.write(to: replicaScope.appendingPathComponent(originalFile.lastPathComponent))
        let relaunched = AppModel(credentials: MemoryCredentials(["baseURL": server.absoluteString, "token": "fixture-a"]),
            defaults: defaults, draftRoot: replicaRoot, session: FixtureProtocol.session(), launchDemo: false)
        let reopened = ChatModel(app: relaunched, conversationId: "atomic-send", newChatTarget: target)
        XCTAssertEqual(reopened.conversationState.pendingSubmission?.messageId, pending.messageId)
        XCTAssertEqual(reopened.conversationState.pendingSubmission?.attachments, [file])
        XCTAssertTrue(reopened.needsMessageStatusCheck)
        XCTAssertEqual(reopened.composerText, "", "Submitted text belongs only to the immutable pending request")
        XCTAssertTrue(reopened.attachments.isEmpty, "Submitted attachments must not reappear as a new unsent message")
        let user = try XCTUnwrap(pending.body["message"])
        let snapshot: JSONValue = .object([
            "conversationId": "atomic-send", "target": .object(["kind": "app", "id": "qa-model", "name": "QA model"]),
            "initialRows": .array([.object(["id": .string(pending.messageId), "parentId": .null, "message": user])]),
            "initialLeafId": .string(pending.messageId), "resume": false,
        ])
        let data = try JSONEncoder().encode(snapshot)
        var posts = 0
        FixtureProtocol.handler = { request in
            if request.httpMethod == "POST" { posts += 1 }
            return .init(data: data)
        }
        await reopened.checkMessageStatus()
        XCTAssertFalse(reopened.needsMessageStatusCheck)
        XCTAssertNil(reopened.conversationState.pendingSubmission)
        XCTAssertEqual(reopened.composerText, "")
        XCTAssertTrue(reopened.attachments.isEmpty)
        XCTAssertFalse(reopened.canSend, "Acceptance must not turn the original draft into a ready-to-send duplicate")
        reopened.send()
        XCTAssertEqual(posts, 0)
    }

    func testRetainedPendingIdentityOverridesAFalseSavedAdmissionFlag() throws {
        let original = app()
        let state = original.conversationStates.state(for: "inconsistent-fence")
        state.pendingSubmission = PendingChatSubmission(messageId: "original-id", text: "Original", attachments: [],
            body: .object(["message": .object(["id": "original-id"])]))
        state.requiresStatusCheck = false
        state.text = "A newer unsent draft"
        XCTAssertTrue(state.flush())
        let relaunched = app()
        let reopened = ChatModel(app: relaunched, conversationId: "inconsistent-fence", newChatTarget: target)
        XCTAssertEqual(reopened.conversationState.pendingSubmission?.messageId, "original-id")
        XCTAssertTrue(reopened.needsMessageStatusCheck, "A retained request identity must fail closed until checked")
        XCTAssertFalse(reopened.canSend, "A new send must not replace an unresolved original identity")
        XCTAssertFalse(reopened.canRegenerate)
        XCTAssertEqual(reopened.composerText, "A newer unsent draft")
    }

    func testRepeatedSendCannotReplaceTheDurableRequestWithANewerDraft() async throws {
        let model = AppModel(credentials: MemoryCredentials(["baseURL": server.absoluteString, "token": "fixture-a"]),
            defaults: defaults, draftRoot: root, session: FixtureProtocol.session(), launchDemo: false)
        let chat = ChatModel(app: model, conversationId: "single-send", newChatTarget: target)
        let requested = expectation(description: "One original offline request")
        requested.assertForOverFulfill = true
        var posts = 0
        FixtureProtocol.handler = { request in
            if request.httpMethod == "POST", request.url?.path.hasSuffix("/chat") == true {
                posts += 1
                requested.fulfill()
            }
            return .init(contentType: "text/event-stream", data: Data(), finish: false)
        }
        chat.composerText = "Original request"
        chat.send()
        let originalID = chat.conversationState.pendingSubmission?.messageId
        chat.composerText = "Newer unsent request"
        chat.send()
        chat.send()
        await fulfillment(of: [requested], timeout: 3)
        XCTAssertEqual(posts, 1)
        XCTAssertEqual(chat.conversationState.pendingSubmission?.messageId, originalID)
        XCTAssertEqual(chat.conversationState.pendingSubmission?.text, "Original request")
        XCTAssertEqual(chat.composerText, "Newer unsent request")
        XCTAssertTrue(chat.conversationState.flush())
        let restored = app().conversationStates.state(for: "single-send")
        XCTAssertEqual(restored.pendingSubmission?.messageId, originalID)
        XCTAssertEqual(restored.text, "Newer unsent request")
        XCTAssertTrue(restored.requiresStatusCheck)
        chat.deactivate()
    }

    #if os(iOS)
    func testSignInInkAndLabelContrastInBothAppearances() {
        for style in [UIUserInterfaceStyle.light, .dark] {
            let traits = UITraitCollection(userInterfaceStyle: style)
            let background = luminance(UIColor(PortalTheme.ink).resolvedColor(with: traits))
            let foreground = luminance(UIColor(PortalTheme.onInk).resolvedColor(with: traits))
            let contrast = (max(background, foreground) + 0.05) / (min(background, foreground) + 0.05)
            XCTAssertGreaterThan(contrast, 7, "Sign-in text and spinner use the same resolved onInk foreground")
        }
    }

    private func luminance(_ color: UIColor) -> Double {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        XCTAssertTrue(color.getRed(&r, green: &g, blue: &b, alpha: &a))
        func linear(_ c: CGFloat) -> Double { c <= 0.04045 ? Double(c / 12.92) : pow(Double((c + 0.055) / 1.055), 2.4) }
        return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
    }
    #endif
}
