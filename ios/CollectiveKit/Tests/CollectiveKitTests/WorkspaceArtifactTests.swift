import XCTest
@testable import CollectiveKit
private final class ArtifactFixture: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let path = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!.first!.value!
        let payload = "\(request.url!.path)|\(request.value(forHTTPHeaderField: "Authorization") ?? "none")|\(path)"
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(payload.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
final class WorkspaceArtifactTests: XCTestCase {
    func testArtifactPathsAndUntrustedURLs() {
        for value in ["../secret", "/etc/passwd", "a\\b", "C:file", "a\n.svg", "."] { XCTAssertNil(WorkspaceArtifact.normalizePath(value)) }
        XCTAssertEqual(WorkspaceArtifact.normalizePath("./art/../report.svg"), "report.svg")
        XCTAssertEqual(WorkspaceArtifact.path(toolName: "workspace_write", output: .object(["ok":.bool(true),"path":.string("/home/agent/workspace/report.svg"),"downloadUrl":.string("https://evil.test")])), "report.svg")
        XCTAssertNil(WorkspaceArtifact.path(toolName: "workspace_bash", output: .object(["ok":.bool(true),"path":.string("report.svg")])))
    }
    func testBearerDownloadAndPercentEncoding() async throws {
        let config = APIClient.makeConfiguration()
        config.protocolClasses = [ArtifactFixture.self]
        let api = APIClient(baseURL: URL(string:"https://fixture.test")!, token:"synthetic", session:URLSession(configuration:config))
        let bytes = try await api.workspaceFile(path:"art/hé+100%.svg")
        XCTAssertEqual(String(decoding:bytes,as:UTF8.self), "/api/workspace/files|Bearer synthetic|art/hé+100%.svg")
        do { _ = try await api.workspaceFile(path:"../secret"); XCTFail("Traversal accepted") } catch {}
    }
}
