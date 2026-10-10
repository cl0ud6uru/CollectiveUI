import XCTest
import CollectiveKit
@testable import CollectiveUI

@MainActor
final class ChatRecoveryTests: XCTestCase {
    private var app: AppModel!
    private var defaults: UserDefaults!
    private var suite: String!
    private var fixture: RecoveryFixture!

    override func setUp() async throws {
        suite = "ChatRecovery.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)!
        fixture = RecoveryFixture()
        let transport = fixture!
        FixtureProtocol.handler = { transport.response($0) }
        app = AppModel(credentials: MemoryCredentials(["baseURL": "https://qa.example.invalid", "token": "fixture"]),
            defaults: defaults, draftRoot: nil, session: FixtureProtocol.session(), launchDemo: false)
    }

    override func tearDown() async throws {
        defaults.removePersistentDomain(forName: suite)
        FixtureProtocol.handler = { _ in .init() }
        app = nil
        fixture = nil
    }

    private func chat() -> ChatModel {
        ChatModel(app: app, conversationId: "chat-a", newChatTarget: TargetOption(kind: "bot", id: "hermes", name: "Hermes"))
    }

    private func waitUntil(_ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        for _ in 0..<300 {
            if condition() { return }
            try? await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("Recovery fixture did not settle", file: file, line: line)
    }

    func testAcceptedMessageRecoveryClearsObsoleteTransportError() async {
        let model = chat()
        model.composerText = "Original request"
        model.send()
        await waitUntil { !model.isStreaming && !model.needsMessageStatusCheck }
        XCTAssertEqual(model.messages.last?.plainText, "Recovered reply")
        XCTAssertNil(model.inlineError)
        XCTAssertEqual(model.avatarActivity, .idle)
        XCTAssertEqual(fixture.postCount, 1)
    }

    func testRegenerateCannotBypassUnconfirmedMessageStatus() async {
        fixture.partialFailure = true
        fixture.snapshotStatus = 503
        let model = chat()
        model.composerText = "Request"
        model.send()
        await waitUntil { !model.isStreaming && model.needsMessageStatusCheck }
        XCTAssertEqual(model.lastAssistantMessageId, "reply-a")
        model.regenerate(assistantMessageId: "reply-a")
        try? await Task.sleep(for: .milliseconds(100))
        XCTAssertFalse(model.isStreaming)
        XCTAssertEqual(fixture.postCount, 1)
    }

    func testServerStreamFailureRemainsVisibleAfterHealthySnapshot() async {
        fixture.serverFailure = true
        let model = chat()
        model.composerText = "Request"
        model.send()
        await waitUntil { !model.isStreaming && !model.needsMessageStatusCheck }
        XCTAssertEqual(model.inlineError, "Hermes run failed")
        XCTAssertEqual(model.avatarActivity, .attention)
        await model.load(showSpinner: false)
        XCTAssertEqual(model.inlineError, "Hermes run failed")
    }

    func testFailedStatusCheckCannotHideGenuineServerFailure() async {
        fixture.serverFailure = true
        fixture.snapshotStatus = 503
        let model = chat()
        model.composerText = "Request"
        model.send()
        await waitUntil { !model.isStreaming && !model.isCheckingMessageStatus }
        XCTAssertTrue(model.needsMessageStatusCheck)
        XCTAssertEqual(model.inlineError, "Hermes run failed")
        fixture.snapshotStatus = 200
        await model.checkMessageStatus()
        XCTAssertFalse(model.needsMessageStatusCheck)
        XCTAssertEqual(model.inlineError, "Hermes run failed")
        XCTAssertEqual(model.avatarActivity, .attention)
    }

    func testMissingSnapshotRetainsRequestAndRetryUsesExactIdentity() async {
        fixture.omitPendingMessage = true
        let model = chat()
        model.composerText = "First line\nSecond line"
        model.send()
        await waitUntil { !model.isStreaming && model.canRetryOriginalMessage }
        XCTAssertTrue(model.needsMessageStatusCheck)
        XCTAssertFalse(model.canRegenerate)
        XCTAssertEqual(model.composerText, "")
        let original = fixture.bodies.first
        model.composerText = "Next draft must stay separate"
        fixture.omitPendingMessage = false
        model.retryOriginalMessage()
        await waitUntil { !model.isStreaming && !model.needsMessageStatusCheck }
        XCTAssertEqual(fixture.postCount, 2)
        XCTAssertEqual(fixture.bodies.last, original)
        XCTAssertEqual(Set(fixture.messageIDs).count, 1)
        XCTAssertEqual(model.messages.filter { $0.role == .user }.count, 1)
        XCTAssertEqual(model.composerText, "Next draft must stay separate")
    }

    func testInterruptedSubmissionSurvivesChatReconstruction() async {
        fixture.holdStream = true
        let model = chat()
        model.composerText = "Keep this original draft"
        model.send()
        await waitUntil { fixture.postCount == 1 }
        model.deactivate()
        XCTAssertTrue(model.needsMessageStatusCheck)
        let reopened = ChatModel(app: app, conversationId: "chat-a", newChatTarget: nil)
        XCTAssertTrue(reopened.needsMessageStatusCheck)
        XCTAssertNotNil(reopened.conversationState.pendingSubmission)
        await reopened.activate()
        XCTAssertFalse(reopened.needsMessageStatusCheck)
        XCTAssertEqual(reopened.messages.last?.plainText, "Recovered reply")
        XCTAssertNil(reopened.conversationState.pendingSubmission)
        XCTAssertEqual(fixture.postCount, 1)
    }

    func testEmptyEOFStillRequiresPositiveAcceptanceEvidence() async {
        fixture.emptyEOF = true
        fixture.omitPendingMessage = true
        let model = chat()
        model.composerText = "Unconfirmed"
        model.send()
        await waitUntil { !model.isStreaming && model.canRetryOriginalMessage }
        XCTAssertNotNil(model.conversationState.pendingSubmission)
        XCTAssertTrue(model.needsMessageStatusCheck)
        XCTAssertEqual(fixture.postCount, 1)
    }

    func testPendingRequestAndGateSurviveDiskRelaunch() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let server = URL(string: "https://qa.example.invalid")!
        let first = ConversationStateStore(server: server, token: "fixture", root: root)
        let state = first.state(for: "chat-a")
        let file = ComposerAttachment(id: UUID(), filename: "notes.txt", mediaType: "text/plain", progress: 1,
            uploaded: UploadedFile(id: "file", url: "/api/files/file", filename: "notes.txt", mediaType: "text/plain", readable: true))
        state.pendingSubmission = PendingChatSubmission(messageId: "immutable-id", text: "Original\nDraft", attachments: [file],
            body: .object(["conversationId": "chat-a", "parentId": "original-parent", "literalSlash": true]))
        state.requiresStatusCheck = true
        state.pendingCommand = PendingCommandAttempt(text: "/new", nextId: "immutable-destination")
        first.flush()
        let restored = ConversationStateStore(server: server, token: "fixture", root: root).state(for: "chat-a")
        XCTAssertTrue(restored.requiresStatusCheck)
        XCTAssertEqual(restored.pendingSubmission?.messageId, "immutable-id")
        XCTAssertEqual(restored.pendingSubmission?.text, "Original\nDraft")
        XCTAssertEqual(restored.pendingSubmission?.attachments, [file])
        XCTAssertEqual(restored.pendingSubmission?.body, state.pendingSubmission?.body)
        XCTAssertEqual(restored.pendingCommand?.nextId, "immutable-destination")
        let other = ConversationStateStore(server: server, token: "different", root: root).state(for: "chat-a")
        XCTAssertNil(other.pendingSubmission)
        XCTAssertFalse(other.requiresStatusCheck)
        XCTAssertNil(other.pendingCommand)
    }

    func testRepeatedStatusChecksUseOneRequest() async {
        fixture.snapshotStatus = 503
        fixture.snapshotDelay = 0.3
        let model = chat()
        model.composerText = "Request"
        model.send()
        // Finish the automatic failed reconciliation before starting the manual
        // single-flight check. The gate is set before that initial read completes.
        await waitUntil { !model.isStreaming && model.needsMessageStatusCheck && !model.isCheckingMessageStatus }
        let previousCount = fixture.snapshotCount
        fixture.snapshotStatus = 200
        fixture.snapshotDelay = 0.3
        let first = Task { await model.checkMessageStatus() }
        await waitUntil { fixture.snapshotCount > previousCount }
        await model.checkMessageStatus()
        await first.value
        XCTAssertEqual(fixture.snapshotCount, previousCount + 1)
        XCTAssertNil(model.inlineError)
        XCTAssertFalse(model.needsMessageStatusCheck)
    }

    func testOlderSnapshotCannotOverwriteAReplacementReply() async {
        let model = ChatModel(app: app, conversationId: "chat-a", newChatTarget: nil)
        await model.load(showSpinner: false)
        fixture.snapshotDelay = 0.4
        let initialCount = fixture.snapshotCount
        let oldLoad = Task { await model.load(showSpinner: false) }
        await waitUntil { fixture.snapshotCount > initialCount }
        fixture.snapshotDelay = 0
        model.composerText = "New request"
        model.send()
        await waitUntil { !model.isStreaming && !model.needsMessageStatusCheck }
        await oldLoad.value
        XCTAssertEqual(model.messages.last?.plainText, "Recovered reply")
        XCTAssertEqual(model.messages.filter { $0.role == .user }.count, 1)
    }

    func testFailedAttachmentPreventsSilentPartialSend() {
        let model = chat()
        model.composerText = "Please read the file"
        model.attachments = [.init(id: UUID(), filename: "report.pdf", mediaType: "application/pdf", progress: 1,
            uploaded: nil, errorText: "Upload failed")]
        XCTAssertFalse(model.canSend)
        model.send()
        XCTAssertEqual(model.composerText, "Please read the file")
        XCTAssertEqual(model.attachments.count, 1)
        XCTAssertEqual(fixture.postCount, 0)
    }

    func testExhaustedResumeBudgetKeepsRunningStateAndAllowsExplicitReconnect() async {
        fixture.runningReply = true
        let model = chat()
        await model.activate()
        model.composerText = "Request"
        model.send()
        await waitUntil { fixture.resumeCount == 2 && !model.isStreaming && !model.isCheckingMessageStatus }
        XCTAssertTrue(model.hasDetachedReply)
        XCTAssertEqual(model.statusLabel, "Reply still running")
        model.composerText = "Next request"
        XCTAssertFalse(model.canSend)
        XCTAssertFalse(model.canRegenerate)
        model.resume()
        await waitUntil { fixture.resumeCount == 3 && !model.isStreaming && !model.isCheckingMessageStatus }
        XCTAssertTrue(model.hasDetachedReply)
        XCTAssertEqual(fixture.postCount, 1)
    }

    func testFreshChatRetryRetainsDestinationAcrossReconstructedModels() async {
        let model = chat()
        model.composerText = "/new"
        model.send()
        await waitUntil { fixture.commandBodies.count == 1 && !model.isExecutingCommand }
        model.deactivate()
        let reopened = chat()
        reopened.send()
        await waitUntil { fixture.commandBodies.count == 2 && !reopened.isExecutingCommand }
        XCTAssertEqual(fixture.commandBodies.first?["newConversationId"], fixture.commandBodies.last?["newConversationId"])
        XCTAssertEqual(reopened.composerText, "/new")
        XCTAssertEqual(fixture.postCount, 0)
    }

    func testBothYoloToggleSpellingsRequireStatusBeforeRetry() async {
        for command in ["/yolo", "/hermes yolo"] {
            var target = TargetOption(kind: "bot", id: "hermes", name: "Hermes")
            target.hermes = true
            let model = ChatModel(app: app, conversationId: "chat-a", newChatTarget: target)
            model.composerText = command
            model.send()
            await waitUntil { !model.isExecutingCommand }
            XCTAssertTrue(model.commandError?.contains("Check /yolo status") == true)
            XCTAssertFalse(model.commandError?.contains("you can retry") == true)
            XCTAssertEqual(model.composerText, command)
        }
    }

    func testStatusCommandDoesNotDiscardUncertainFreshChatDestination() async {
        var target = TargetOption(kind: "bot", id: "hermes", name: "Hermes")
        target.hermes = true
        let model = ChatModel(app: app, conversationId: "chat-a", newChatTarget: target)
        model.composerText = "/new"
        model.send()
        await waitUntil { fixture.commandBodies.count == 1 && !model.isExecutingCommand }
        let destination = fixture.commandBodies.first?["newConversationId"]
        model.composerText = "/status"
        model.send()
        await waitUntil { fixture.commandBodies.count == 2 && !model.isExecutingCommand }
        XCTAssertNotNil(model.commandResult)
        let reopened = ChatModel(app: app, conversationId: "chat-a", newChatTarget: target)
        reopened.composerText = "/reset"
        reopened.send()
        await waitUntil { fixture.commandBodies.count == 3 && !reopened.isExecutingCommand }
        XCTAssertEqual(fixture.commandBodies.last?["newConversationId"], destination)
        XCTAssertEqual(fixture.postCount, 0)
    }

    func testHistoricalFileRejectionAndUnconfirmedCancellationKeepResetDraftAndFence() async {
        fixture.unconfirmedCancellation = true
        let model = ChatModel(app: app, conversationId: "chat-a", newChatTarget: nil)
        await model.activate()
        XCTAssertTrue(model.messages.last?.plainText.contains("No files or prompt were sent") == true)
        model.composerText = "/reset"
        model.send()
        await waitUntil { fixture.commandBodies.count == 1 && !model.isExecutingCommand }
        let destination = model.conversationState.pendingCommand?.nextId
        XCTAssertNotNil(destination)
        XCTAssertEqual(model.commandError, RecoveryFixture.cancellationError + " Your draft has been kept.")
        XCTAssertEqual(model.composerText, "/reset")

        model.checkHermesStatus()
        model.checkHermesStatus()
        await waitUntil { fixture.commandBodies.count == 2 && !model.isExecutingCommand }
        XCTAssertEqual(fixture.commandBodies.last?["text"], "/status")
        XCTAssertEqual(model.commandResult?.lines, [RecoveryFixture.unconfirmedStatus])
        XCTAssertEqual(model.composerText, "/reset")
        XCTAssertEqual(model.conversationState.pendingCommand?.nextId, destination)
        XCTAssertNil(app.selection)
        XCTAssertEqual(fixture.postCount, 0)
        XCTAssertEqual(model.messages.count, 2)
    }

    func testHermesStatusInspectionPreservesUnconfirmedSubmissionAndNewerDraft() async {
        fixture.unconfirmedCancellation = true
        let model = ChatModel(app: app, conversationId: "chat-a", newChatTarget: nil)
        await model.activate()
        let original = PendingChatSubmission(messageId: "unconfirmed-original", text: "Earlier request", attachments: [],
            body: .object(["conversationId": "chat-a"]))
        model.conversationState.pendingSubmission = original
        model.needsMessageStatusCheck = true
        model.composerText = "/reset"
        XCTAssertFalse(model.canSend)
        XCTAssertFalse(model.canRegenerate)
        XCTAssertTrue(model.canCheckHermesStatus)
        model.checkHermesStatus()
        await waitUntil { fixture.commandBodies.count == 1 && !model.isExecutingCommand }
        XCTAssertTrue(model.needsMessageStatusCheck)
        XCTAssertEqual(model.conversationState.pendingSubmission?.messageId, original.messageId)
        XCTAssertEqual(model.composerText, "/reset")
        XCTAssertEqual(model.commandResult?.lines, [RecoveryFixture.unconfirmedStatus])
        XCTAssertFalse(model.canSend)
        XCTAssertFalse(model.canRegenerate)
        XCTAssertEqual(fixture.postCount, 0)
        XCTAssertNil(app.selection)
    }
}

private final class RecoveryFixture: @unchecked Sendable {
    static let cancellationError = "Hermes cancellation is not confirmed. Use /stop to retry or /status to check before continuing."
    static let unconfirmedStatus = "Cancellation requested; upstream identity is not recorded yet. Retry /stop after the worker settles."
    var unconfirmedCancellation = false
    var partialFailure = false
    var serverFailure = false
    var omitPendingMessage = false
    var holdStream = false
    var emptyEOF = false
    var runningReply = false
    private(set) var resumeCount = 0
    private(set) var commandBodies: [JSONValue] = []
    private(set) var bodies: [JSONValue] = []
    private(set) var messageIDs: [String] = []
    var snapshotStatus = 200
    var snapshotDelay: TimeInterval = 0
    private(set) var snapshotCount = 0
    private(set) var postCount = 0
    private var user: UIMessage?

    func response(_ request: URLRequest) -> FixtureProtocol.Reply {
        if request.url?.path == "/api/chat/commands", request.httpMethod == "POST" {
            if let body = FixtureProtocol.body(request) {
                commandBodies.append(body)
                if body["text"]?.stringValue == "/status" {
                    if unconfirmedCancellation {
                        let result: JSONValue = .object(["title": "Chat status", "lines": .array([.string(Self.unconfirmedStatus)])])
                        return .init(data: try! JSONEncoder().encode(result), delay: 0.1)
                    }
                    return .init(data: Data(#"{"title":"Status","lines":["Idle"]}"#.utf8))
                }
            }
            if unconfirmedCancellation {
                return .init(status: 409, data: try! JSONEncoder().encode(JSONValue.object(["error": .string(Self.cancellationError)])))
            }
            return .init(status: 502)
        }
        if request.url?.path == "/api/chat/chat-a/stream" {
            resumeCount += 1
            return .init(status: 502)
        }
        if request.url?.path == "/api/chat" {
            postCount += 1
            if let body = FixtureProtocol.body(request) {
                bodies.append(body)
                if let id = body["message"]?["id"]?.stringValue { messageIDs.append(id) }
            }
            if let raw = bodies.last?["message"], let data = try? JSONEncoder().encode(raw) {
                user = try? JSONDecoder().decode(UIMessage.self, from: data)
            }
            if emptyEOF || holdStream {
                return .init(contentType: "text/event-stream", data: Data(), finish: !holdStream)
            }
            if partialFailure || serverFailure {
                var chunks = [#"{"type":"start","messageId":"reply-a"}"#, #"{"type":"text-start","id":"t"}"#,
                    #"{"type":"text-delta","id":"t","delta":"Partial reply"}"#]
                if serverFailure { chunks += [#"{"type":"error","errorText":"Hermes run failed"}"#, #"{"type":"finish","finishReason":"error"}"#] }
                let sse = chunks.map { "data: " + $0 + "\n\n" }.joined() + (serverFailure ? "data: [DONE]\n\n" : "")
                return .init(contentType: "text/event-stream", data: Data(sse.utf8), error: partialFailure ? URLError(.networkConnectionLost) : nil, errorDelay: 0.1)
            }
            return .init(status: 502, data: Data(#"{"error":"Connection interrupted"}"#.utf8))
        }
        if request.url?.path == "/api/chat/chat-a" {
            snapshotCount += 1
            var rows: [JSONValue] = []
            if unconfirmedCancellation {
                rows = [.object(["id": "historical-user", "parentId": .null,
                    "message": UIMessage(id: "historical-user", role: .user, parts: [.text(TextPart(text: "Please inspect this file"))]).toJSON()]),
                    .object(["id": "reply-a", "parentId": "historical-user", "message": UIMessage(id: "reply-a", role: .assistant,
                        parts: [.text(TextPart(text: "Hermes refused the request. This Hermes server does not support original-file delivery yet. No files or prompt were sent.", state: "done"))]).toJSON()])]
            }
            if let user, !omitPendingMessage {
                rows = [.object(["id": .string(user.id), "parentId": .null, "message": user.toJSON()]),
                    .object(["id": "reply-a", "parentId": .string(user.id), "message": UIMessage(id: "reply-a", role: .assistant,
                        parts: [.text(TextPart(text: "Recovered reply", state: "done"))]).toJSON()])]
            }
            let snapshot: JSONValue = .object(["conversationId": "chat-a", "target": .object(["kind": "bot", "id": "hermes", "name": "Hermes", "hermes": .bool(unconfirmedCancellation)]),
                "initialRows": .array(rows), "initialLeafId": rows.isEmpty ? .null : "reply-a", "resume": .bool(runningReply)])
            return .init(status: snapshotStatus, data: try! JSONEncoder().encode(snapshot), delay: snapshotDelay)
        }
        return .init()
    }
}
