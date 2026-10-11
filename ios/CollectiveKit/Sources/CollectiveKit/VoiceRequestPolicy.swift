import Foundation

/// The embedded engine can only call voice endpoints for its bound conversation.
/// Device credentials never enter JavaScript or a web page's cookie store.
public struct VoiceRequestPolicy: Sendable {
    public let conversationId: String
    public init(conversationId: String) { self.conversationId = conversationId }

    public func validate(path: String, method: String, body: JSONValue?) throws -> URLComponents {
        guard path.utf8.count <= 2048, let url = URLComponents(string: path),
              url.scheme == nil, url.host == nil, url.fragment == nil,
              ["/api/voice/session", "/api/voice/turn", "/api/voice/reaction", "/api/voice/avatar"].contains(url.path),
              url.percentEncodedPath == url.path, ["GET", "POST"].contains(method) else { throw APIError.invalidURL }
        let items = url.queryItems ?? []
        guard Set(items.map(\.name)).count == items.count else { throw APIError.invalidURL }
        let query = Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
        let isSession = url.path.hasSuffix("/session")
        if method == "GET" {
            guard !url.path.hasSuffix("/reaction"), body == nil || body == .null,
                  Set(query.keys).isSubset(of: isSession ? ["conversationId", "botId", "appId"] : ["conversationId", "messageId"]),
                  isSession ? (query["conversationId"] == nil || query["conversationId"] == conversationId) : query["conversationId"] == conversationId
            else { throw APIError.invalidURL }
        } else {
            guard items.isEmpty, !url.path.hasSuffix("/avatar"),
                  body?[isSession ? "chatId" : "conversationId"]?.stringValue == conversationId,
                  !isSession || body?["conversationId"] == nil || body?["conversationId"]?.stringValue == conversationId,
                  let body, try JSONEncoder().encode(body).count <= 64000 else { throw APIError.invalidURL }
        }
        var result = url
        result.path = url.path.replacingOccurrences(of: "/api/voice/", with: "/api/mobile/v1/voice/")
        return result
    }
}
