#if os(iOS)
import XCTest
import UIKit
import CollectiveKit
@testable import CollectiveUI

@MainActor
final class AuthenticatedImageTests: XCTestCase {
    private var app: AppModel!
    private var defaults: UserDefaults!
    private var suite: String!
    private var cache: ImageCache!

    override func setUp() async throws {
        suite = "AuthenticatedImageTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)!
        cache = ImageCache()
        app = AppModel(credentials: MemoryCredentials(), defaults: defaults, draftRoot: nil,
            session: FixtureProtocol.session(), launchDemo: false)
        signIn(server: "https://first.invalid", token: "account-a")
    }

    override func tearDown() async throws {
        FixtureProtocol.handler = { _ in .init() }
        defaults.removePersistentDomain(forName: suite)
        app = nil
        cache = nil
    }

    func testSameAttachmentPathIsScopedToServerAndAccountAndStillCachesWithinSession() async {
        let capture = ImageRequestCapture(first: png(.red), second: png(.blue))
        FixtureProtocol.handler = { capture.respond($0) }
        let loader = AuthenticatedImageLoader(cache: cache)
        let path = "/api/files/copied-attachment"
        await loader.load(resource: path, app: app)
        let first = loader.image?.pngData()
        XCTAssertNotNil(first)
        await loader.load(resource: path, app: app)
        XCTAssertEqual(capture.count, 1, "Repeat loads in one session should reuse their authorized image")

        // Cloned/restored installations can contain the same attachment IDs at another origin.
        signIn(server: "https://second.invalid", token: "account-a")
        await loader.load(resource: path, app: app)
        XCTAssertEqual(capture.count, 2)
        XCTAssertNotEqual(loader.image?.pngData(), first)

        // The same URL is fetched again after changing account, even at the same server.
        app.completeSignIn(token: "account-b")
        await loader.load(resource: path, app: app)
        XCTAssertEqual(capture.count, 3)
        XCTAssertEqual(capture.authorizations, ["Bearer account-a", "Bearer account-a", "Bearer account-b"])
    }

    func testLatePreviousSessionImageCannotReplaceOrPopulateCurrentSessionCache() async {
        let gate = FixtureDeliveryGate()
        let capture = ImageRequestCapture(first: png(.red), second: png(.blue), firstGate: gate)
        FixtureProtocol.handler = { capture.respond($0) }
        let loader = AuthenticatedImageLoader(cache: cache)
        let path = "/api/files/copied-attachment"
        let oldRequest = AuthenticatedImageRequest(app: app, resource: path)
        let old = Task { await loader.load(resource: path, app: app) }
        await waitForRequest(capture)
        app.completeSignIn(token: "account-b")
        let currentRequest = AuthenticatedImageRequest(app: app, resource: path)
        await loader.load(resource: path, app: app)
        let currentPixels = loader.image?.pngData()
        XCTAssertNotNil(currentPixels)
        gate.release()
        await old.value
        XCTAssertEqual(loader.request, currentRequest)
        XCTAssertEqual(loader.image?.pngData(), currentPixels)
        XCTAssertNil(cache.image(for: oldRequest), "Obsolete responses must not populate even their old cache namespace")
        XCTAssertEqual(cache.image(for: currentRequest)?.pngData(), currentPixels)
    }

    func testLateImageAfterLogoutIsNotStoredOrShown() async {
        let gate = FixtureDeliveryGate()
        let capture = ImageRequestCapture(first: png(.red), second: png(.blue), firstGate: gate)
        FixtureProtocol.handler = { capture.respond($0) }
        let loader = AuthenticatedImageLoader(cache: cache)
        let path = "/api/files/copied-attachment"
        let oldRequest = AuthenticatedImageRequest(app: app, resource: path)
        let old = Task { await loader.load(resource: path, app: app) }
        await waitForRequest(capture)
        await app.signOut()
        gate.release()
        await old.value
        XCTAssertNil(loader.image)
        XCTAssertNil(cache.image(for: oldRequest))
        XCTAssertNotEqual(loader.request, AuthenticatedImageRequest(app: app, resource: path))
    }

    private func signIn(server: String, token: String) {
        app.useServer(URL(string: server)!, info: MobileInfo(enabled: true, appName: "Fixture", logoEmoji: "", apiVersion: 1))
        app.completeSignIn(token: token)
    }

    private func waitForRequest(_ capture: ImageRequestCapture) async {
        for _ in 0..<200 {
            if capture.count > 0 { break }
            try? await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertGreaterThan(capture.count, 0)
    }

    private func png(_ color: UIColor) -> Data {
        UIGraphicsImageRenderer(size: CGSize(width: 2, height: 2)).pngData { context in
            color.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 2, height: 2))
        }
    }
}

private final class ImageRequestCapture: @unchecked Sendable {
    private let lock = NSLock()
    private var requests: [String] = []
    let first: Data
    let second: Data
    let firstGate: FixtureDeliveryGate?
    init(first: Data, second: Data, firstGate: FixtureDeliveryGate? = nil) {
        self.first = first; self.second = second; self.firstGate = firstGate
    }
    var count: Int { lock.withLock { requests.count } }
    var authorizations: [String] { lock.withLock { requests } }
    func respond(_ request: URLRequest) -> FixtureProtocol.Reply {
        guard request.httpMethod == "GET", request.url?.path.hasPrefix("/api/files/") == true else { return .init() }
        let count = lock.withLock { requests.append(request.value(forHTTPHeaderField: "Authorization") ?? ""); return requests.count }
        return .init(contentType: "image/png", data: count == 1 ? first : second, deliveryGate: count == 1 ? firstGate : nil)
    }
}
#endif
