import XCTest
@testable import CollectiveKit

final class PKCETests: XCTestCase {
    func testRFC7636AppendixBVector() {
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
        XCTAssertEqual(PKCE.challenge(for: verifier), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    }

    func testVerifierShape() {
        let verifier = PKCE.makeVerifier()
        XCTAssertEqual(verifier.count, 43)
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        XCTAssertTrue(verifier.unicodeScalars.allSatisfy { allowed.contains($0) })
        XCTAssertNotEqual(PKCE.makeVerifier(), verifier)
        XCTAssertFalse(PKCE.challenge(for: verifier).contains("="))
    }

    func testAuthorizeURL() throws {
        let base = try XCTUnwrap(URL(string: "https://ai.example.com"))
        let url = try XCTUnwrap(MobileAuth.authorizeURL(baseURL: base, challenge: "abc", state: "s+1", deviceName: "Ada's iPhone"))
        let components = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
        XCTAssertEqual(components.path, "/mobile/authorize")
        let items = components.queryItems ?? []
        XCTAssertEqual(items.first(where: { $0.name == "code_challenge_method" })?.value, "S256")
        XCTAssertEqual(items.first(where: { $0.name == "device_name" })?.value, "Ada's iPhone")
        XCTAssertTrue(url.absoluteString.contains("state=s%2B1"))
    }

    func testCallbackParsing() throws {
        let ok = try XCTUnwrap(URL(string: "collectiveui://auth/callback?code=xyz&state=s1"))
        XCTAssertEqual(MobileAuth.parseCallback(ok, expectedState: "s1"), .code("xyz"))
        let denied = try XCTUnwrap(URL(string: "collectiveui://auth/callback?error=access_denied&state=s1"))
        XCTAssertEqual(MobileAuth.parseCallback(denied, expectedState: "s1"), .denied("access_denied"))
        if case .invalid = MobileAuth.parseCallback(ok, expectedState: "other") {} else {
            XCTFail("State mismatch must be rejected")
        }
    }

    func testIDs() {
        let id = IDGenerator.make()
        XCTAssertEqual(id.count, 16)
        XCTAssertTrue(id.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber) })
    }

    func testNormalizeBaseURL() {
        XCTAssertEqual(APIClient.normalizeBaseURL("ai.example.com/")?.absoluteString, "https://ai.example.com")
        XCTAssertEqual(APIClient.normalizeBaseURL(" http://localhost:3000// ")?.absoluteString, "http://localhost:3000")
        XCTAssertEqual(APIClient.normalizeBaseURL("https://x.org/portal")?.absoluteString, "https://x.org/portal")
        XCTAssertNil(APIClient.normalizeBaseURL(""))
        XCTAssertNil(APIClient.normalizeBaseURL("ftp://x.org"))
    }

    func testEndpointBuilding() throws {
        let base = try XCTUnwrap(URL(string: "https://x.org/portal"))
        let client = APIClient(baseURL: base)
        let url = try client.endpoint("/api/search", query: [URLQueryItem(name: "q", value: "c++ more")])
        XCTAssertEqual(url.absoluteString, "https://x.org/portal/api/search?q=c%2B%2B%20more")
        XCTAssertEqual(APIClient.pathComponent("a/b c"), "a%2Fb%20c")
    }

    func testSessionConfiguration() {
        let configuration = APIClient.makeConfiguration()
        XCTAssertEqual(configuration.timeoutIntervalForRequest, 300)
        XCTAssertFalse(configuration.httpShouldSetCookies)
        let session = URLSession(configuration: configuration)
        let base = URL(string: "https://x.org") ?? URL(fileURLWithPath: "/")
        let client = APIClient(baseURL: base, token: "t", session: session)
        XCTAssertTrue(client.session === session)
    }

    func testMultipartBody() {
        let body = Multipart.body(boundary: "B", fieldName: "file", filename: "a\"b.txt", mimeType: "text/plain", data: Data("hi".utf8))
        let text = String(decoding: body, as: UTF8.self)
        XCTAssertEqual(text, "--B\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a'b.txt\"\r\nContent-Type: text/plain\r\n\r\nhi\r\n--B--\r\n")
    }

    func testDataURLDecoding() throws {
        XCTAssertEqual(try APIClient.decodeDataURL("data:text/plain;base64,aGk="), Data("hi".utf8))
        XCTAssertEqual(try APIClient.decodeDataURL("data:text/plain,a%20b"), Data("a b".utf8))
    }
}
