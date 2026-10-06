import XCTest
@testable import CollectiveKit
private let approvalJSON = #"{"requests":[{"runId":"child-run","taskId":"task","conversationId":"child","botName":"Worker","assignerName":"Queen","expiresAt":"2099-01-01T00:00:00.000Z","part":{"type":"tool-workspace_bash","toolCallId":"call","state":"approval-requested","input":{"command":"printf fixture"},"approval":{"id":"opaque-signed-id"}}}]}"#
private final class DelegatedFixture: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let token = request.value(forHTTPHeaderField:"Authorization")
        var valid = token == "Bearer synthetic" && request.url?.path == "/api/chat/origin/approvals"
        if request.httpMethod == "POST" {
            let data: Data
            if let body = request.httpBody { data = body }
            else if let stream = request.httpBodyStream {
                stream.open(); defer {stream.close()};var buffer = [UInt8](repeating:0,count:1024);var bytes=Data()
                while stream.hasBytesAvailable {let n=stream.read(&buffer,maxLength:buffer.count);if n<=0 {break};bytes.append(contentsOf:buffer.prefix(n))}
                data=bytes
            } else {data=Data()}
            let body = (try? JSONSerialization.jsonObject(with:data)) as? [String:Any]
            valid = valid && body?.count == 3 && body?["runId"] as? String == "child-run" && body?["approvalId"] as? String == "opaque-signed-id" && body?["approved"] as? Bool == false
        }
        client?.urlProtocol(self,didReceive:HTTPURLResponse(url:request.url!,statusCode:valid ? 200 : 400,httpVersion:nil,headerFields:nil)!,cacheStoragePolicy:.notAllowed)
        client?.urlProtocol(self,didLoad:Data((request.httpMethod == "POST" ? "{\"accepted\":true}" : approvalJSON).utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
final class DelegatedApprovalTests: XCTestCase {
    func testDurableIdentityAndISOExpiryDecode() throws {
        let list = try JSONDecoder().decode(DelegatedApprovalList.self,from:Data(approvalJSON.utf8))
        XCTAssertEqual(list.requests[0].id,"child-run:opaque-signed-id")
        XCTAssertEqual(list.requests[0].tool?.input,.object(["command":.string("printf fixture")]))
        XCTAssertGreaterThan(list.requests[0].expiresAt,Date())
        XCTAssertThrowsError(try JSONDecoder().decode(DelegatedApprovalList.self,from:Data(approvalJSON.replacingOccurrences(of:"2099-01-01T00:00:00.000Z",with:"invalid").utf8)))
    }
    func testBearerReadAndOwnerDecisionWithoutToolInput() async throws {
        let config=APIClient.makeConfiguration();config.protocolClasses=[DelegatedFixture.self]
        let api=APIClient(baseURL:URL(string:"https://fixture.test")!,token:"synthetic",session:URLSession(configuration:config))
        let requests=try await api.delegatedApprovals(conversationId:"origin")
        try await api.answerDelegatedApproval(conversationId:"origin",request:requests[0],approved:false)
    }
}
