import XCTest
@testable import CollectiveKit

private final class CredentialFixture: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let token = request.value(forHTTPHeaderField: "Authorization") ?? "none"
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(token.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class CredentialScopeTests: XCTestCase {
    func testArtworkCredentialsRequireSameSchemeHostAndEffectivePort() async throws {
        let config = APIClient.makeConfiguration()
        config.protocolClasses = [CredentialFixture.self]
        let api = APIClient(baseURL: URL(string: "https://example.test")!, token: "fixture", session: URLSession(configuration: config))
        for (url, expected) in [
            ("/api/files/1", "Bearer fixture"),
            ("https://example.test:443/image", "Bearer fixture"),
            ("https://example.test/image", "Bearer fixture"),
            ("http://example.test/image", "none"),
            ("https://example.test:8443/image", "none"),
            ("https://other.test/image", "none"),
        ] {
            let data = try await api.loadData(from: url)
            XCTAssertEqual(String(decoding: data, as: UTF8.self), expected, url)
        }
    }

    func testServerAddressRejectsFragmentsAndEmbeddedCredentials() {
        XCTAssertNil(APIClient.normalizeBaseURL("https://example.test/#broken"))
        XCTAssertNil(APIClient.normalizeBaseURL("https://user:secret@example.test"))
        XCTAssertNil(APIClient.normalizeBaseURL("https://example.test/?query=1"))
        XCTAssertNotNil(APIClient.normalizeBaseURL("http://localhost:3000/portal"))
    }

    func testAuthenticatedRedirectCannotChangeOrigin() {
        let session = URLSession(configuration: .ephemeral)
        var original = URLRequest(url: URL(string: "https://example.test/api/files/1")!)
        original.setValue("Bearer fixture", forHTTPHeaderField: "Authorization")
        let task = session.dataTask(with: original) // Never resumed: no network traffic.
        let delegate = SameOriginRedirectDelegate()
        let response = HTTPURLResponse(url: original.url!, statusCode: 302, httpVersion: nil, headerFields: nil)!
        for target in ["http://example.test/image", "https://example.test:8443/image", "https://other.test/image"] {
            delegate.urlSession(session, task: task, willPerformHTTPRedirection: response, newRequest: URLRequest(url: URL(string: target)!)) { request in
                XCTAssertNil(request, target)
            }
        }
        delegate.urlSession(session, task: task, willPerformHTTPRedirection: response, newRequest: URLRequest(url: URL(string: "https://example.test:443/image")!)) { request in
            XCTAssertNotNil(request)
        }
        task.cancel()
        session.invalidateAndCancel()
    }
}
