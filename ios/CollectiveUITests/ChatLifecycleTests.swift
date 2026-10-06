import XCTest
import CollectiveKit
@testable import CollectiveUI

/// All requests use this in-memory transport; no test opens a browser, contacts a server,
/// or stores synthetic credentials in the device Keychain.
final class FixtureProtocol: URLProtocol {
    struct Reply {
        var status = 200
        var contentType = "application/json"
        var data = Data("{}".utf8)
        var finish = true
        var delay: TimeInterval = 0
    }
    static var handler: (URLRequest) -> Reply = { _ in Reply() }

    static func session() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [FixtureProtocol.self]
        return URLSession(configuration: config)
    }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let reply = Self.handler(request)
        if reply.delay > 0 {
            DispatchQueue.global().asyncAfter(deadline: .now() + reply.delay) { self.deliver(reply) }
        } else { deliver(reply) }
    }
    private func deliver(_ reply: Reply) {
        let response = HTTPURLResponse(url: request.url!, statusCode: reply.status, httpVersion: nil,
            headerFields: ["Content-Type": reply.contentType])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: reply.data)
        if reply.finish { client?.urlProtocolDidFinishLoading(self) }
    }
    override func stopLoading() {}

    static func body(_ request: URLRequest) -> JSONValue? {
        if let data = request.httpBody { return JSONValue.parse(data: data) }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 4096)
        defer { buffer.deallocate() }
        while stream.hasBytesAvailable {
            let count = stream.read(buffer, maxLength: 4096)
            if count <= 0 { break }
            data.append(buffer, count: count)
        }
        return JSONValue.parse(data: data)
    }
}

private final class ChatFixture: @unchecked Sendable {
    enum Scenario { case normal, reject, emptyStream, partialStream }
    let scenario: Scenario
    var user: UIMessage?
    var didStop = false
    var stopDelay: TimeInterval = 0
    private var replyCount = 0
    private var replyId = "reply-a"
    init(_ scenario: Scenario) { self.scenario = scenario }

    func response(_ request: URLRequest) -> FixtureProtocol.Reply {
        let path = request.url!.path
        if path == "/api/chat", let body = FixtureProtocol.body(request), let raw = body["message"],
           let data = try? JSONEncoder().encode(raw), let message = try? JSONDecoder().decode(UIMessage.self, from: data) {
            user = message
            replyCount += 1
            replyId = replyCount == 1 ? "reply-a" : "reply-\(replyCount)"
            if scenario == .reject {
                let error: JSONValue = .object(["error": "Fixture rejected", "unsavedMessageId": .string(message.id)])
                return .init(status: 500, data: try! JSONEncoder().encode(error))
            }
            var chunks: [JSONValue] = [.object(["type": "start", "messageId": .string(replyId)])]
            if scenario == .normal || scenario == .partialStream {
                chunks += [.object(["type": "text-start", "id": "t"]), .object(["type": "text-delta", "id": "t", "delta": "Partial reply"])]
            }
            if scenario == .normal { chunks += [.object(["type": "text-end", "id": "t"]), .object(["type": "finish", "finishReason": "stop"])] }
            let sse = chunks.map { "data: " + $0.compactString() + "\n\n" }.joined()
                + (scenario == .normal ? "data: [DONE]\n\n" : "")
            return .init(contentType: "text/event-stream", data: Data(sse.utf8), finish: scenario == .normal)
        }
        if path.hasSuffix("/stop") { didStop = true; return .init(delay: stopDelay) }
        if path == "/api/chat/chat-a" {
            var rows: [JSONValue] = []
            if let user {
                rows.append(.object(["id": .string(user.id), "parentId": .null, "message": user.toJSON()]))
                let parts: [MessagePart] = scenario == .partialStream || scenario == .normal ? [.text(TextPart(text: "Partial reply", state: "done"))] : []
                rows.append(.object(["id": .string(replyId), "parentId": .string(user.id), "message": UIMessage(id: replyId, role: .assistant, parts: parts).toJSON()]))
            }
            let snapshot: JSONValue = .object(["conversationId": "chat-a", "target": .object(["kind": "app", "id": "model", "name": "QA model"]),
                "initialRows": .array(rows), "initialLeafId": user == nil ? .null : .string(replyId), "resume": .bool(!didStop && scenario != .normal)])
            return .init(data: try! JSONEncoder().encode(snapshot))
        }
        return .init()
    }
}

@MainActor
final class ChatLifecycleTests: XCTestCase {
    private let target = TargetOption(kind: "app", id: "model", name: "QA model")
    private var suite: String!
    private var defaults: UserDefaults!
    private var app: AppModel!
    private var fixture: ChatFixture!

    private func prepare(_ scenario: ChatFixture.Scenario) {
        suite = "ChatLifecycle.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)!
        fixture = ChatFixture(scenario)
        let transport = fixture!
        FixtureProtocol.handler = { transport.response($0) }
        app = AppModel(credentials: MemoryCredentials(["baseURL": "https://qa.example.invalid", "token": "fixture-token"]),
            defaults: defaults, draftRoot: nil, session: FixtureProtocol.session(), launchDemo: false)
    }

    override func tearDown() async throws {
        if let suite { defaults.removePersistentDomain(forName: suite) }
        app = nil
        fixture = nil
        FixtureProtocol.handler = { _ in .init() }
    }

    private func waitUntil(_ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        for _ in 0..<200 {
            if condition() { return }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("Fixture lifecycle did not settle", file: file, line: line)
    }

    func testDemoChunksReachTheLoadingThreadInOrderBeforeFinish() async {
        let finished = expectation(description: "Ordered offline stream finished")
        let client = DemoOrderingClient(finished: finished, expectedRunLoop: CFRunLoopGetCurrent())
        let transport = DemoURLProtocol(request: URLRequest(url: URL(string: "https://qa.example.invalid")!),
            cachedResponse: nil, client: client)
        let delivery = DemoDelivery(target: transport, runLoop: CFRunLoopGetCurrent())
        defer { withExtendedLifetime((transport, delivery)) {} }
        let expected = (0..<100).map(String.init)
        delivery.schedule(expected.map { DemoStreamEvent(delay: 0.001, payload: $0) })
        await fulfillment(of: [finished], timeout: 5)
        XCTAssertEqual(client.payloads, expected)
        XCTAssertEqual(client.countAtFinish, expected.count)
        XCTAssertTrue(client.usedExpectedRunLoop)
    }

    func testSuccessfulSendClearsSharedDraftAndNormalStopFinishDoesNotShowStopped() async {
        prepare(.normal)
        let chat = ChatModel(app: app, conversationId: "chat-a", newChatTarget: target)
        chat.composerText = "One line\nAnother line"
        chat.send()
        await waitUntil { !chat.isStreaming }
        XCTAssertEqual(chat.messages.last?.plainText, "Partial reply")
        let reopened = ChatModel(app: app, conversationId: "chat-a", newChatTarget: nil)
        XCTAssertEqual(reopened.composerText, "")
        XCTAssertTrue(reopened.conversationState.stoppedReplies.isEmpty)
    }

    func testConfirmedRejectedSendRestoresDraftAndFilesIntoReconstructedModel() async {
        prepare(.reject)
        let chat = ChatModel(app: app, conversationId: "chat-a", newChatTarget: target)
        chat.composerText = "Original multiline\ndraft"
        let file = UploadedFile(id: "fixture-file", url: "/api/files/fixture-file", filename: "test.txt", mediaType: "text/plain", readable: true)
        chat.attachments = [ComposerAttachment(id: UUID(), filename: file.filename, mediaType: file.mediaType, progress: 1, uploaded: file)]
        chat.send()
        let reopened = ChatModel(app: app, conversationId: "chat-a", newChatTarget: target)
        reopened.composerText = "Typed while submitting"
        await waitUntil { !chat.isStreaming }
        XCTAssertEqual(reopened.composerText, "Original multiline\ndraft\n\nTyped while submitting")
        XCTAssertEqual(reopened.attachments.first?.uploaded, file)
        XCTAssertFalse(chat.messages.contains { $0.role == .user })
    }

    func testStopBeforeFirstOutputSurvivesSnapshotAndReconstructedChat() async {
        prepare(.emptyStream)
        let chat = ChatModel(app: app, conversationId: "chat-a", newChatTarget: target)
        chat.composerText = "Slow reply"
        chat.send()
        await waitUntil { chat.messages.last?.id == "reply-a" }
        XCTAssertTrue(chat.isStreaming)
        chat.stop()
        await waitUntil { !chat.isStreaming && !chat.isStopping }
        XCTAssertTrue(fixture.didStop)
        XCTAssertTrue(chat.conversationState.showsStoppedPlaceholder(for: chat.messages.last!))
        let reopened = ChatModel(app: app, conversationId: "chat-a", newChatTarget: nil)
        await reopened.load(showSpinner: false)
        XCTAssertTrue(reopened.conversationState.showsStoppedPlaceholder(for: reopened.messages.last!))
        XCTAssertFalse(reopened.isStreaming)
    }

    func testStopPreservesPartialOutputAndRegenerateClearsOnlyThatTurnMarker() async {
        prepare(.partialStream)
        let chat = ChatModel(app: app, conversationId: "chat-a", newChatTarget: target)
        chat.composerText = "Partial reply please"
        chat.send()
        await waitUntil { chat.messages.last?.plainText == "Partial reply" }
        chat.stop()
        await waitUntil { !chat.isStreaming && !chat.isStopping }
        XCTAssertEqual(chat.messages.last?.plainText, "Partial reply")
        XCTAssertFalse(chat.conversationState.showsStoppedPlaceholder(for: chat.messages.last!))
        XCTAssertEqual(chat.conversationState.stoppedReplies.count, 1)
        chat.regenerate(assistantMessageId: "reply-a")
        XCTAssertTrue(chat.conversationState.stoppedReplies.isEmpty)
        chat.deactivate()
    }

    func testOldStopAcknowledgementCannotDisableStopOrLabelAReplacementReply() async {
        prepare(.normal)
        fixture.stopDelay = 0.5
        let chat = ChatModel(app: app, conversationId: "chat-a", newChatTarget: target)
        chat.composerText = "First question"
        chat.send()
        chat.stop()
        await waitUntil { !chat.isStreaming && fixture.didStop }
        XCTAssertTrue(chat.isStopping, "Old Stop acknowledgement is still pending")
        chat.composerText = "Next question"
        chat.send()
        XCTAssertFalse(chat.isStopping, "A replacement stream gets its own Stop state")
        await waitUntil { !chat.isStreaming }
        try? await Task.sleep(nanoseconds: 550_000_000)
        XCTAssertFalse(chat.isStopping)
        XCTAssertTrue(chat.conversationState.stoppedReplies.isEmpty)
        XCTAssertEqual(chat.messages.last?.id, "reply-2")
    }
}

private final class DemoOrderingClient: NSObject, URLProtocolClient, @unchecked Sendable {
    private let lock = NSLock()
    private var received: [String] = []
    private var finishedCount = 0
    private var callbacksOnExpectedLoop = true
    private let finished: XCTestExpectation
    private let expectedRunLoop: CFRunLoop

    init(finished: XCTestExpectation, expectedRunLoop: CFRunLoop) {
        self.finished = finished
        self.expectedRunLoop = expectedRunLoop
    }
    var payloads: [String] { lock.lock(); defer { lock.unlock() }; return received }
    var countAtFinish: Int { lock.lock(); defer { lock.unlock() }; return finishedCount }
    var usedExpectedRunLoop: Bool { lock.lock(); defer { lock.unlock() }; return callbacksOnExpectedLoop }

    func urlProtocol(_ urlProtocol: URLProtocol, didLoad data: Data) {
        lock.lock(); defer { lock.unlock() }
        callbacksOnExpectedLoop = callbacksOnExpectedLoop && CFEqual(CFRunLoopGetCurrent(), expectedRunLoop)
        received.append(String(decoding: data, as: UTF8.self))
    }
    func urlProtocolDidFinishLoading(_ urlProtocol: URLProtocol) {
        lock.lock()
        callbacksOnExpectedLoop = callbacksOnExpectedLoop && CFEqual(CFRunLoopGetCurrent(), expectedRunLoop)
        finishedCount = received.count
        lock.unlock()
        finished.fulfill()
    }
    func urlProtocol(_ urlProtocol: URLProtocol, didFailWithError error: Error) { finished.fulfill() }
    func urlProtocol(_ urlProtocol: URLProtocol, didReceive response: URLResponse, cacheStoragePolicy policy: URLCache.StoragePolicy) {}
    func urlProtocol(_ urlProtocol: URLProtocol, wasRedirectedTo request: URLRequest, redirectResponse: URLResponse) {}
    func urlProtocol(_ urlProtocol: URLProtocol, cachedResponseIsValid cachedResponse: CachedURLResponse) {}
    func urlProtocol(_ urlProtocol: URLProtocol, didReceive challenge: URLAuthenticationChallenge) {}
    func urlProtocol(_ urlProtocol: URLProtocol, didCancel challenge: URLAuthenticationChallenge) {}
}
