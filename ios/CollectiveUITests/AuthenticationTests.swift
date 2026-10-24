import XCTest
import CollectiveKit
@testable import CollectiveUI

@MainActor
private final class FixtureAuthenticator: WebAuthenticating {
    var callback: ((URL) async throws -> URL)?
    var authorizeURL: URL?
    var cancelCount = 0
    var suspends = false
    var pending: CheckedContinuation<URL, Error>?
    func authenticate(url: URL, callbackScheme: String) async throws -> URL {
        authorizeURL = url
        if suspends { return try await withCheckedThrowingContinuation { pending = $0 } }
        if let callback { return try await callback(url) }
        let state = URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!.first { $0.name == "state" }!.value!
        return URL(string: "collectiveui://auth/callback?code=fixture-code&state=\(state)")!
    }
    func cancel() {
        cancelCount += 1
        let continuation = pending
        pending = nil
        continuation?.resume(throwing: CancellationError())
    }
}

@MainActor
final class AuthenticationTests: XCTestCase {
    private var app: AppModel!
    private var credentials: MemoryCredentials!
    private var authenticator: FixtureAuthenticator!
    private var defaults: UserDefaults!
    private var suite: String!

    override func setUp() async throws {
        suite = "AuthenticationTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)!
        credentials = MemoryCredentials()
        authenticator = FixtureAuthenticator()
        FixtureProtocol.handler = { request in
            if request.url?.path == "/portal/api/mobile/info" {
                return .init(data: Data(#"{"enabled":true,"appName":"Fixture"}"#.utf8))
            }
            if request.url?.path == "/portal/api/mobile/auth/token" {
                // FixtureProtocol runs off the main actor; route capture is supplied per test below.
                return .init(data: Data(#"{"token":"fixture-token"}"#.utf8))
            }
            return .init(data: Data(#"{"branding":{},"apps":[],"bots":[],"conversations":[]}"#.utf8))
        }
        app = AppModel(credentials: credentials, defaults: defaults, draftRoot: nil,
            session: FixtureProtocol.session(), launchDemo: false, authenticator: authenticator)
        app.useServer(URL(string: "https://fixture.invalid/portal")!, info: MobileInfo(enabled: true, appName: "Fixture", logoEmoji: "", apiVersion: 1))
    }

    override func tearDown() async throws {
        defaults.removePersistentDomain(forName: suite)
        FixtureProtocol.handler = { _ in .init() }
        app = nil
    }

    func testPKCEBrowserCallbackExchangesAndPersistsServerSession() async {
        let capture = AuthRequestCapture()
        FixtureProtocol.handler = { request in capture.respond(request) }
        await app.signIn()
        XCTAssertEqual(app.token, "fixture-token")
        XCTAssertEqual(credentials.values["token"], "fixture-token")
        XCTAssertEqual(credentials.values["baseURL"], "https://fixture.invalid/portal")
        XCTAssertEqual(capture.tokenRequests, 1)
        XCTAssertEqual(capture.body?["code"]?.stringValue, "fixture-code")
        let verifier = capture.body?["codeVerifier"]?.stringValue
        XCTAssertNotNil(verifier)
        let items = URLComponents(url: authenticator.authorizeURL!, resolvingAgainstBaseURL: false)!.queryItems!
        XCTAssertEqual(items.first { $0.name == "code_challenge" }?.value, verifier.map(PKCE.challenge(for:)))
        XCTAssertEqual(app.phase, .main)
    }

    func testStateMismatchNeverExchangesOrStoresToken() async {
        let capture = AuthRequestCapture()
        FixtureProtocol.handler = { request in capture.respond(request) }
        authenticator.callback = { _ in URL(string: "collectiveui://auth/callback?code=c&state=wrong")! }
        await app.signIn()
        XCTAssertNil(app.token)
        XCTAssertNil(credentials.values["token"])
        XCTAssertEqual(capture.tokenRequests, 0)
        XCTAssertEqual(app.phase, .signIn)
    }

    func testLateBrowserCallbackCannotSignInToChangedServer() async {
        let current = app!
        authenticator.callback = { url in
            current.changeServer()
            let state = URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!.first { $0.name == "state" }!.value!
            return URL(string: "collectiveui://auth/callback?code=c&state=\(state)")!
        }
        await app.signIn()
        XCTAssertEqual(app.phase, .setup)
        XCTAssertNil(app.token)
        XCTAssertNil(credentials.values["token"])
        XCTAssertFalse(app.isSigningIn)
    }

    func testLateTokenExchangeCannotOverwriteNewServer() async {
        let gate = FixtureDeliveryGate()
        let capture = AuthRequestCapture(tokenGate: gate)
        FixtureProtocol.handler = { request in capture.respond(request) }
        let task = Task { await app.signIn() }
        for _ in 0..<200 {
            if capture.tokenRequests > 0 { break }
            try? await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(capture.tokenRequests, 1)
        app.useServer(URL(string: "https://other.invalid")!, info: MobileInfo(enabled: true, appName: "Other", logoEmoji: "", apiVersion: 1))
        gate.release()
        await task.value
        for _ in 0..<200 {
            if !capture.revokedTokens.isEmpty { break }
            try? await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(capture.revokedTokens, ["Bearer fixture-token"])
        XCTAssertEqual(app.serverURL?.host, "other.invalid")
        XCTAssertNil(app.token)
        XCTAssertNil(credentials.values["token"])
    }

    func testSlowRevocationEndsLocalAccessAndCannotClearReplacementSession() async {
        let gate = FixtureDeliveryGate()
        FixtureProtocol.handler = { request in
            if request.httpMethod == "DELETE", request.url?.path.hasSuffix("/api/mobile/v1/session") == true { return .init(deliveryGate: gate) }
            return .init()
        }
        app.completeSignIn(token: "old-session")
        let task = Task { await app.signOut() }
        for _ in 0..<200 {
            if app.token == nil { break }
            try? await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertNil(app.token)
        app.completeSignIn(token: "replacement-session")
        gate.release()
        await task.value
        XCTAssertEqual(app.token, "replacement-session")
        XCTAssertEqual(credentials.values["token"], "replacement-session")
    }

    #if os(iOS)
    func testStalledActivityUnregisterEndsLocalAccessWhenActivitiesEnabled() async {
        await checkStalledActivityUnregister(enabled: true)
    }

    func testStalledActivityUnregisterEndsLocalAccessWhenActivitiesDisabled() async {
        await checkStalledActivityUnregister(enabled: false)
    }

    private func checkStalledActivityUnregister(enabled: Bool) async {
        let previousEnabled = app.liveActivities.enabled
        await app.liveActivities.setEnabled(enabled)
        let gate = FixtureDeliveryGate()
        let capture = SignOutRequestCapture(activityGate: gate)
        FixtureProtocol.handler = { capture.respond($0) }
        app.completeSignIn(token: "old-session")
        let oldDraft = app.conversationStates.state(for: "old-chat")
        oldDraft.text = "Private draft"
        let task = Task { await app.signOut() }
        for _ in 0..<200 {
            if capture.activityTokens.count == 1 && capture.revokedTokens.count == 1 { break }
            try? await Task.sleep(for: .milliseconds(10))
        }
        // Neither a disabled feature nor an unresponsive unregister request can retain access.
        XCTAssertNil(app.token)
        XCTAssertEqual(app.phase, .signIn)
        XCTAssertNil(credentials.values["token"])
        XCTAssertTrue(defaults.bool(forKey: "nativeSignedOut"))
        XCTAssertEqual(oldDraft.text, "")
        XCTAssertEqual(capture.activityTokens, ["Bearer old-session"])
        XCTAssertEqual(capture.revokedTokens, ["Bearer old-session"])

        app.useServer(URL(string: "https://replacement.invalid")!, info: MobileInfo(enabled: true, appName: "Replacement", logoEmoji: "", apiVersion: 1))
        app.completeSignIn(token: "replacement-session")
        // A late unauthorized result from the old server must not clear the replacement login.
        gate.release()
        await task.value
        await Task.yield()
        XCTAssertEqual(app.serverURL?.host, "replacement.invalid")
        XCTAssertEqual(app.token, "replacement-session")
        XCTAssertEqual(credentials.values["token"], "replacement-session")
        FixtureProtocol.handler = { _ in .init() }
        await app.liveActivities.setEnabled(previousEnabled)
    }
    #endif

    func testEndedSessionDoesNotRestoreWhenCredentialDeletionFails() {
        app.completeSignIn(token: "token-that-cannot-be-deleted")
        credentials.rejectsTokenRemoval = true
        app.handleUnauthorized()
        XCTAssertNil(app.token)
        XCTAssertEqual(credentials.values["token"], "token-that-cannot-be-deleted")
        let relaunched = AppModel(credentials: credentials, defaults: defaults, draftRoot: nil,
            session: FixtureProtocol.session(), launchDemo: false)
        XCTAssertNil(relaunched.token)
        XCTAssertEqual(relaunched.phase, .signIn)
    }

    func testCancellingSignInTaskDismissesBrowserWithoutTokenExchange() async {
        let capture = AuthRequestCapture()
        FixtureProtocol.handler = { capture.respond($0) }
        authenticator.suspends = true
        let previousCancellations = authenticator.cancelCount
        let task = Task { await app.signIn() }
        for _ in 0..<200 {
            if authenticator.pending != nil { break }
            try? await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertNotNil(authenticator.pending)
        task.cancel()
        await task.value
        XCTAssertGreaterThan(authenticator.cancelCount, previousCancellations)
        XCTAssertNil(authenticator.pending)
        XCTAssertEqual(capture.tokenRequests, 0)
        XCTAssertNil(app.token)
        XCTAssertNil(app.banner)
        XCTAssertFalse(app.isSigningIn)
    }

    func testWindowClosureCancelsSignInWithoutChangingSelectedServer() async {
        authenticator.suspends = true
        let task = Task { await app.signIn() }
        for _ in 0..<200 {
            if authenticator.pending != nil { break }
            try? await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertNotNil(authenticator.pending)
        app.cancelSignIn()
        await task.value
        XCTAssertNil(authenticator.pending)
        XCTAssertEqual(app.serverURL?.host, "fixture.invalid")
        XCTAssertNil(app.token)
        XCTAssertNil(app.banner)
    }

    func testPartialCredentialWriteDoesNotPairNewTokenWithOldServer() async {
        let capture = AuthRequestCapture()
        FixtureProtocol.handler = { capture.respond($0) }
        credentials.values["baseURL"] = "https://stale.invalid"
        credentials.rejectedWrites = ["baseURL"]
        await app.signIn()
        XCTAssertNil(app.token)
        XCTAssertTrue(defaults.bool(forKey: "nativeSignedOut"))
        XCTAssertNotNil(app.banner)
        let relaunched = AppModel(credentials: credentials, defaults: defaults, draftRoot: nil,
            session: FixtureProtocol.session(), launchDemo: false)
        XCTAssertEqual(relaunched.serverURL?.host, "fixture.invalid")
        XCTAssertNil(relaunched.token)
    }

    func testRestorationDoesNotSendSavedTokenToDifferentSelectedServer() {
        credentials.values = ["baseURL": "https://previous.invalid", "token": "previous-server-token"]
        defaults.set("https://selected.invalid", forKey: "baseURL")
        defaults.set(false, forKey: "nativeSignedOut")
        let restored = AppModel(credentials: credentials, defaults: defaults, draftRoot: nil,
            session: FixtureProtocol.session(), launchDemo: false)
        XCTAssertEqual(restored.serverURL?.host, "selected.invalid")
        XCTAssertNil(restored.token)
        XCTAssertNil(restored.api?.token)
    }

    func testDemoSignInNeverOpensBrowserOrTouchesCredentials() async {
        let memory = MemoryCredentials(["baseURL": "https://private.invalid", "token": "private-token"])
        let browser = FixtureAuthenticator()
        let demo = AppModel(credentials: memory, defaults: defaults, draftRoot: nil,
            launchDemo: true, authenticator: browser)
        demo.useServer(DemoMode.baseURL, info: DemoMode.info)
        await demo.signIn()
        XCTAssertNil(browser.authorizeURL)
        XCTAssertEqual(memory.operations, [])
        XCTAssertEqual(memory.values["token"], "private-token")
        XCTAssertNil(demo.token)
    }
}

#if os(iOS)
private final class SignOutRequestCapture: @unchecked Sendable {
    private let lock = NSLock()
    private var activities: [String] = []
    private var revoked: [String] = []
    let activityGate: FixtureDeliveryGate
    init(activityGate: FixtureDeliveryGate) { self.activityGate = activityGate }
    var activityTokens: [String] { lock.withLock { activities } }
    var revokedTokens: [String] { lock.withLock { revoked } }

    func respond(_ request: URLRequest) -> FixtureProtocol.Reply {
        let bearer = request.value(forHTTPHeaderField: "Authorization") ?? ""
        if request.httpMethod == "DELETE", request.url?.path.hasSuffix("/api/mobile/v1/live-activities") == true {
            lock.withLock { activities.append(bearer) }
            return .init(status: 401, deliveryGate: activityGate)
        }
        if request.httpMethod == "DELETE", request.url?.path.hasSuffix("/api/mobile/v1/session") == true {
            lock.withLock { revoked.append(bearer) }
        }
        return .init()
    }
}
#endif

private final class AuthRequestCapture: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    private var savedBody: JSONValue?
    private var revoked: [String] = []
    let tokenGate: FixtureDeliveryGate?
    init(tokenGate: FixtureDeliveryGate? = nil) { self.tokenGate = tokenGate }
    var tokenRequests: Int { lock.withLock { count } }
    var revokedTokens: [String] { lock.withLock { revoked } }
    var body: JSONValue? { lock.withLock { savedBody } }
    func respond(_ request: URLRequest) -> FixtureProtocol.Reply {
        if request.httpMethod == "DELETE", request.url?.path.hasSuffix("/api/mobile/v1/session") == true {
            lock.withLock { revoked.append(request.value(forHTTPHeaderField: "Authorization") ?? "") }
            return .init()
        }
        if request.url?.path.hasSuffix("/api/mobile/info") == true {
            return .init(data: Data(#"{"enabled":true,"appName":"Fixture"}"#.utf8))
        }
        if request.url?.path.hasSuffix("/api/mobile/auth/token") == true {
            lock.withLock { count += 1; savedBody = FixtureProtocol.body(request) }
            return .init(data: Data(#"{"token":"fixture-token"}"#.utf8), deliveryGate: tokenGate)
        }
        return .init(data: Data(#"{"branding":{},"apps":[],"bots":[],"conversations":[]}"#.utf8))
    }
}
