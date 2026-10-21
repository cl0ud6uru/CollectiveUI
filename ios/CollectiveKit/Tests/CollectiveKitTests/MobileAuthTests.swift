import XCTest
@testable import CollectiveKit

final class MobileAuthTests: XCTestCase {
    func testAuthorizePreservesSubpathAndEncodesDeviceName() throws {
        let url = try XCTUnwrap(MobileAuth.authorizeURL(baseURL: URL(string: "https://fixture.invalid/portal")!,
            challenge: "challenge", state: "state", deviceName: "Mac + desk"))
        XCTAssertEqual(url.path, "/portal/mobile/authorize")
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!
        XCTAssertEqual(items.first(where: { $0.name == "device_name" })?.value, "Mac + desk")
        XCTAssertEqual(items.first(where: { $0.name == "code_challenge_method" })?.value, "S256")
    }

    func testValidCallbackAndDenial() {
        XCTAssertEqual(MobileAuth.parseCallback(URL(string: "collectiveui://auth/callback?state=s&code=c")!, expectedState: "s"), .code("c"))
        XCTAssertEqual(MobileAuth.parseCallback(URL(string: "collectiveui://auth/callback?state=s&error=denied")!, expectedState: "s"), .denied("denied"))
    }

    func testUnexpectedCallbackOriginsAndDuplicateParametersFailClosed() {
        for value in ["https://auth/callback?state=s&code=c", "collectiveui://other/callback?state=s&code=c",
                      "collectiveui://auth/other?state=s&code=c", "collectiveui://auth/callback?state=s&code=c&code=d",
                      "collectiveui://auth/callback?state=s&state=s&code=c", "collectiveui://auth/callback?state=wrong&code=c",
                      "collectiveui://auth/callback?state=s&code=c#extra"] {
            guard case .invalid = MobileAuth.parseCallback(URL(string: value)!, expectedState: "s") else {
                return XCTFail("Accepted unexpected callback: \(value)")
            }
        }
    }
}
