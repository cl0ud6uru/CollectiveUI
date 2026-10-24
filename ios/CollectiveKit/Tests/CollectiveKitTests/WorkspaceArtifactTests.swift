import XCTest
@testable import CollectiveKit
private final class ArtifactFixture: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!
        let path = query.first { $0.name == "path" }!.value!
        let instance = query.first { $0.name == "instanceId" }?.value ?? "legacy"
        let payload = "\(request.url!.path)|\(request.value(forHTTPHeaderField: "Authorization") ?? "none")|\(path)|\(instance)"
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
        XCTAssertEqual(WorkspaceArtifact.parse(toolName: "workspace_write", output: .object(["ok":.bool(true),"path":.string("/home/agent/workspace/report.svg"),"downloadUrl":.string("https://evil.test")]))?.path, "report.svg")
        XCTAssertNil(WorkspaceArtifact.parse(toolName: "workspace_bash", output: .object(["ok":.bool(true),"path":.string("report.svg")])))
    }
    func testBearerDownloadAndPercentEncoding() async throws {
        let config = APIClient.makeConfiguration()
        config.protocolClasses = [ArtifactFixture.self]
        let api = APIClient(baseURL: URL(string:"https://fixture.test")!, token:"synthetic", session:URLSession(configuration:config))
        let bytes = try await api.workspaceFile(path:"art/hé+100%.svg")
        XCTAssertEqual(String(decoding:bytes,as:UTF8.self), "/api/workspace/files|Bearer synthetic|art/hé+100%.svg|legacy")
        do { _ = try await api.workspaceFile(path:"../secret"); XCTFail("Traversal accepted") } catch {}
    }

    func testIdenticalFilenamesDownloadFromTheirRecordedInstances() async throws {
        let config = APIClient.makeConfiguration()
        config.protocolClasses = [ArtifactFixture.self]
        let api = APIClient(baseURL: URL(string: "https://fixture.test")!, token: "synthetic", session: URLSession(configuration: config))
        for id in ["template-instance-a", "template-instance-b"] {
            let artifact = try XCTUnwrap(WorkspaceArtifact.parse(toolName: "workspace_write", output: .object([
                "ok": .bool(true), "path": .string("report.csv"), "instanceId": .string(id),
                "downloadUrl": .string("https://untrusted.invalid/report.csv"),
            ])))
            let bytes = try await api.workspaceFile(path: artifact.path, instanceId: artifact.instanceId)
            XCTAssertEqual(String(decoding: bytes, as: UTF8.self), "/api/workspace/files|Bearer synthetic|report.csv|\(id)")
        }
        let legacy = try XCTUnwrap(WorkspaceArtifact.parse(toolName: "workspace_read", output: .object([
            "ok": .bool(true), "path": .string("report.csv"),
        ])))
        XCTAssertNil(legacy.instanceId)
        let bytes = try await api.workspaceFile(path: legacy.path, instanceId: legacy.instanceId)
        XCTAssertEqual(String(decoding: bytes, as: UTF8.self), "/api/workspace/files|Bearer synthetic|report.csv|legacy")
    }

    func testMalformedInstanceSelectorsNeverFallBackToLegacy() async throws {
        let invalidIDs = ["", "short", "../workspace", "instance?x=1", "instance123\n", String(repeating: "a", count: 65), "abcdefghé"]
        for value in invalidIDs.map(JSONValue.string) + [.number(12), .bool(false), .array([]), .object([:])] {
            XCTAssertNil(WorkspaceArtifact.parse(toolName: "workspace_read", output: .object([
                "ok": .bool(true), "path": .string("report.csv"), "instanceId": value,
            ])), "Accepted malformed selector: \(value)")
        }
        let config = APIClient.makeConfiguration()
        config.protocolClasses = [ArtifactFixture.self]
        let api = APIClient(baseURL: URL(string: "https://fixture.test")!, session: URLSession(configuration: config))
        for id in invalidIDs {
            do {
                _ = try await api.workspaceFile(path: "report.csv", instanceId: id)
                XCTFail("Downloaded with malformed selector: \(id)")
            } catch APIError.invalidURL { }
        }
        // JSON null is the server's legacy/absent selector, matching the web parser.
        let legacy = WorkspaceArtifact.parse(toolName: "workspace_read", output: .object([
            "ok": .bool(true), "path": .string("report.csv"), "instanceId": .null,
        ]))
        XCTAssertNotNil(legacy)
        XCTAssertNil(legacy?.instanceId)
    }
}
