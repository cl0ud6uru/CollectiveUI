import XCTest
import UIKit
import CollectiveKit
@testable import CollectiveUI

final class MemoryCredentials: CredentialStore {
    var values: [String: String]
    var operations: [String] = []
    init(_ values: [String: String] = [:]) { self.values = values }
    func set(_ value: String, for account: String) { operations.append("set:\(account)"); values[account] = value }
    func string(for account: String) -> String? { operations.append("read:\(account)"); return values[account] }
    func remove(_ account: String) { operations.append("remove:\(account)"); values.removeValue(forKey: account) }
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
        XCTAssertNil(model.sessionInfo)
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
}
