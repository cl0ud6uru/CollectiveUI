import Foundation

public struct DelegatedApproval: Decodable, Hashable, Sendable, Identifiable {
    public let runId: String
    public let taskId: String
    public let conversationId: String
    public let botName: String
    public let assignerName: String
    public let expiresAt: Date
    public let part: MessagePart
    public var id: String { "\(runId):\(tool?.approval?.id ?? "")" }
    public var tool: ToolPart? { if case .tool(let tool) = part { return tool }; return nil }
    private enum CodingKeys: String, CodingKey { case runId, taskId, conversationId, botName, assignerName, expiresAt, part }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        runId = try c.decode(String.self, forKey: .runId)
        taskId = try c.decode(String.self, forKey: .taskId)
        conversationId = try c.decode(String.self, forKey: .conversationId)
        botName = try c.decode(String.self, forKey: .botName)
        assignerName = try c.decode(String.self, forKey: .assignerName)
        guard let date = c.lenientDate(.expiresAt) else { throw DecodingError.dataCorruptedError(forKey: .expiresAt, in: c, debugDescription: "Invalid approval expiry") }
        expiresAt = date
        part = try c.decode(MessagePart.self, forKey: .part)
    }
}
public struct DelegatedApprovalList: Decodable, Sendable {
    public let requests: [DelegatedApproval]
}
extension APIClient {
    public func delegatedApprovals(conversationId: String) async throws -> [DelegatedApproval] {
        try await get("/api/chat/\(APIClient.pathComponent(conversationId))/approvals", as: DelegatedApprovalList.self).requests
    }
    public func answerDelegatedApproval(conversationId: String, request: DelegatedApproval, approved: Bool) async throws {
        guard let id = request.tool?.approval?.id else { throw APIError.invalidResponse }
        let _: JSONValue = try await send("/api/chat/\(APIClient.pathComponent(conversationId))/approvals", method: "POST", body: .object([
            "runId": .string(request.runId), "approvalId": .string(id), "approved": .bool(approved)
        ]), as: JSONValue.self)
    }
}
