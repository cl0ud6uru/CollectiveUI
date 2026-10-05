import Foundation

public enum BotChatKind: String, Sendable {
    case home
    case side
}

/// HTTP client for the CollectiveUI mobile API.
///
/// Immutable: create a new client when the server or token changes.
public final class APIClient: @unchecked Sendable {
    public let baseURL: URL
    public let token: String?
    public let session: URLSession
    private let onUnauthorized: (@Sendable () -> Void)?

    /// Shared session with long timeouts so streamed replies (with periodic keepalives) are not cut off.
    public static let sharedSession: URLSession = APIClient.makeSession()

    /// The configuration used by `sharedSession`. Callers can adjust a copy (for example to add
    /// `protocolClasses`) and pass the resulting session to `init(baseURL:token:session:onUnauthorized:)`.
    public static func makeConfiguration() -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 300
        configuration.timeoutIntervalForResource = 60 * 60 * 6
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.httpCookieAcceptPolicy = .never
        configuration.httpShouldSetCookies = false
        return configuration
    }

    public static func makeSession() -> URLSession {
        return URLSession(configuration: makeConfiguration())
    }

    public init(baseURL: URL, token: String? = nil, session: URLSession? = nil, onUnauthorized: (@Sendable () -> Void)? = nil) {
        self.baseURL = baseURL
        self.token = token
        self.session = session ?? APIClient.sharedSession
        self.onUnauthorized = onUnauthorized
    }

    /// Normalises a user-entered server address: adds `https://` when no scheme is given
    /// and strips trailing slashes. Returns nil when no host can be found.
    public static func normalizeBaseURL(_ input: String) -> URL? {
        var text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        let lowered = text.lowercased()
        if !lowered.hasPrefix("http://") && !lowered.hasPrefix("https://") {
            if lowered.contains("://") {
                return nil
            }
            text = "https://" + text
        }
        while text.hasSuffix("/") {
            text.removeLast()
        }
        guard let components = URLComponents(string: text),
              let host = components.host, !host.isEmpty,
              components.query == nil,
              let url = components.url
        else {
            return nil
        }
        return url
    }

    // MARK: - Request building

    public func endpoint(_ path: String, query: [URLQueryItem] = []) throws -> URL {
        var base = baseURL.absoluteString
        while base.hasSuffix("/") {
            base.removeLast()
        }
        let fullPath = path.hasPrefix("/") ? path : "/" + path
        guard var components = URLComponents(string: base + fullPath) else {
            throw APIError.invalidURL
        }
        if !query.isEmpty {
            components.queryItems = query
            // URLComponents leaves "+" alone, but servers decode it as a space.
            components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        }
        guard let url = components.url else {
            throw APIError.invalidURL
        }
        return url
    }

    public func makeRequest(_ path: String, method: String = "GET", query: [URLQueryItem] = [], body: JSONValue? = nil) throws -> URLRequest {
        let target = try endpoint(path, query: query)
        var request = URLRequest(url: target)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }
        return request
    }

    static func pathComponent(_ value: String) -> String {
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }

    // MARK: - Performing requests

    @discardableResult
    public func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }
        try validate(status: http.statusCode, data: data, request: request)
        return (data, http)
    }

    func validate(status: Int, data: Data, request: URLRequest) throws {
        if (200..<300).contains(status) {
            return
        }
        if status == 401, request.value(forHTTPHeaderField: "Authorization") != nil {
            onUnauthorized?()
            throw APIError.unauthorized
        }
        throw APIError.from(status: status, data: data)
    }

    public func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            throw APIError.decoding(String(describing: error))
        }
    }

    public func get<T: Decodable>(_ path: String, query: [URLQueryItem] = [], as type: T.Type) async throws -> T {
        let request = try makeRequest(path, query: query)
        let (data, _) = try await perform(request)
        return try decode(type, from: data)
    }

    public func send<T: Decodable>(_ path: String, method: String, body: JSONValue?, as type: T.Type) async throws -> T {
        let request = try makeRequest(path, method: method, body: body)
        let (data, _) = try await perform(request)
        return try decode(type, from: data)
    }

    public func sendIgnoringResponse(_ path: String, method: String, body: JSONValue? = nil) async throws {
        let request = try makeRequest(path, method: method, body: body)
        try await perform(request)
    }

    // MARK: - Auth

    public func mobileInfo() async throws -> MobileInfo {
        return try await get("/api/mobile/info", as: MobileInfo.self)
    }

    public func exchangeToken(code: String, codeVerifier: String) async throws -> TokenResponse {
        let body: JSONValue = .object([
            "code": .string(code),
            "codeVerifier": .string(codeVerifier),
        ])
        return try await send("/api/mobile/auth/token", method: "POST", body: body, as: TokenResponse.self)
    }

    public func currentSession() async throws -> SessionInfo {
        return try await get("/api/mobile/v1/session", as: SessionInfo.self)
    }

    public func revokeSession() async throws {
        try await sendIgnoringResponse("/api/mobile/v1/session", method: "DELETE")
    }

    // MARK: - Shell, conversations, inbox, search

    public func shell() async throws -> ShellResponse {
        return try await get("/api/mobile/v1/shell", as: ShellResponse.self)
    }

    public func openBotChat(botId: String, kind: BotChatKind) async throws -> String {
        let path = "/api/mobile/v1/bots/\(APIClient.pathComponent(botId))/chat"
        let body: JSONValue = .object(["kind": .string(kind.rawValue)])
        let response = try await send(path, method: "POST", body: body, as: BotChatResponse.self)
        return response.conversationId
    }

    public func updateConversation(id: String, title: String? = nil, pinned: Bool? = nil, archived: Bool? = nil) async throws {
        var object: [String: JSONValue] = [:]
        if let title {
            object["title"] = .string(title)
        }
        if let pinned {
            object["pinned"] = .bool(pinned)
        }
        if let archived {
            object["archived"] = .bool(archived)
        }
        let path = "/api/mobile/v1/conversations/\(APIClient.pathComponent(id))"
        try await sendIgnoringResponse(path, method: "PATCH", body: .object(object))
    }

    public func deleteConversation(id: String) async throws {
        let path = "/api/mobile/v1/conversations/\(APIClient.pathComponent(id))"
        try await sendIgnoringResponse(path, method: "DELETE")
    }

    public func inbox() async throws -> [InboxItem] {
        return try await get("/api/mobile/v1/inbox", as: InboxResponse.self).items
    }

    /// Marks one item read, or everything when `id` is nil.
    public func markInboxRead(id: String?) async throws {
        var object: [String: JSONValue] = [:]
        if let id {
            object["id"] = .string(id)
        }
        try await sendIgnoringResponse("/api/mobile/v1/inbox/read", method: "POST", body: .object(object))
    }

    public func search(query: String) async throws -> [SearchResult] {
        let items = [URLQueryItem(name: "q", value: query)]
        return try await get("/api/search", query: items, as: SearchResponse.self).results
    }

    // MARK: - Chat

    public func snapshot(conversationId: String) async throws -> ConversationSnapshot {
        return try await get("/api/chat/\(APIClient.pathComponent(conversationId))", as: ConversationSnapshot.self)
    }

    public func stop(conversationId: String, messageId: String?) async throws {
        var object: [String: JSONValue] = [:]
        if let messageId {
            object["messageId"] = .string(messageId)
        }
        let path = "/api/chat/\(APIClient.pathComponent(conversationId))/stop"
        try await sendIgnoringResponse(path, method: "POST", body: .object(object))
    }

    /// Sends a chat request (new message, regenerate or approval answer) and streams the reply.
    public func streamChat(body: JSONValue) -> AsyncThrowingStream<UIMessageChunk, Error> {
        do {
            var request = try makeRequest("/api/chat", method: "POST", body: body)
            request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
            return stream(request)
        } catch {
            return AsyncThrowingStream { continuation in
                continuation.finish(throwing: error)
            }
        }
    }

    /// Re-attaches to a reply that is still being generated. Finishes immediately on 204.
    public func resumeStream(conversationId: String) -> AsyncThrowingStream<UIMessageChunk, Error> {
        do {
            var request = try makeRequest("/api/chat/\(APIClient.pathComponent(conversationId))/stream")
            request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
            return stream(request)
        } catch {
            return AsyncThrowingStream { continuation in
                continuation.finish(throwing: error)
            }
        }
    }

    func stream(_ request: URLRequest) -> AsyncThrowingStream<UIMessageChunk, Error> {
        let session = self.session
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let (bytes, response) = try await session.bytes(for: request)
                    guard let http = response as? HTTPURLResponse else {
                        throw APIError.invalidResponse
                    }
                    if http.statusCode == 204 {
                        continuation.finish()
                        return
                    }
                    if !(200..<300).contains(http.statusCode) {
                        var body = Data()
                        for try await byte in bytes {
                            body.append(byte)
                        }
                        try self.validate(status: http.statusCode, data: body, request: request)
                        throw APIError.invalidResponse
                    }
                    var parser = SSEParser()
                    for try await byte in bytes {
                        guard let event = parser.feed(byte: byte) else { continue }
                        switch event {
                        case .done:
                            continuation.finish()
                            return
                        case .data(let payload):
                            if let chunk = UIMessageChunk.parse(payload) {
                                continuation.yield(chunk)
                            }
                        }
                    }
                    if let event = parser.finish(), case .data(let payload) = event, let chunk = UIMessageChunk.parse(payload) {
                        continuation.yield(chunk)
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in
                task.cancel()
            }
        }
    }

    // MARK: - Files

    /// Uploads a file as multipart/form-data (field `file`), reporting fractional progress.
    public func upload(
        data: Data,
        filename: String,
        mimeType: String,
        progress: (@Sendable (Double) -> Void)? = nil
    ) async throws -> UploadedFile {
        var request = try makeRequest("/api/files", method: "POST")
        let boundary = "CollectiveUI-\(UUID().uuidString)"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        let body = Multipart.body(boundary: boundary, fieldName: "file", filename: filename, mimeType: mimeType, data: data)
        let box = ProgressObservationBox()
        let session = self.session
        let uploadRequest = request
        let result: (Data, URLResponse) = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<(Data, URLResponse), Error>) in
            let task = session.uploadTask(with: uploadRequest, from: body) { responseData, response, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                guard let responseData, let response else {
                    continuation.resume(throwing: APIError.invalidResponse)
                    return
                }
                continuation.resume(returning: (responseData, response))
            }
            if let progress {
                box.observation = task.progress.observe(\.fractionCompleted, options: [.new]) { observed, _ in
                    progress(observed.fractionCompleted)
                }
            }
            task.resume()
        }
        box.observation?.invalidate()
        box.observation = nil
        guard let http = result.1 as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }
        try validate(status: http.statusCode, data: result.0, request: uploadRequest)
        return try decode(UploadedFile.self, from: result.0)
    }

    /// Loads file bytes: `data:` URLs are decoded locally, server-relative paths (`/api/files/<id>`)
    /// and same-host URLs are fetched with the bearer token.
    public func loadData(from urlString: String) async throws -> Data {
        if urlString.hasPrefix("data:") {
            return try APIClient.decodeDataURL(urlString)
        }
        var request: URLRequest
        if urlString.hasPrefix("/") {
            request = try makeRequest(urlString)
        } else {
            guard let url = URL(string: urlString) else {
                throw APIError.invalidURL
            }
            request = URLRequest(url: url)
            if let token, url.host() == baseURL.host() {
                request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            }
        }
        request.setValue("*/*", forHTTPHeaderField: "Accept")
        let (data, _) = try await perform(request)
        return data
    }

    public static func decodeDataURL(_ urlString: String) throws -> Data {
        guard let comma = urlString.firstIndex(of: ",") else {
            throw APIError.invalidURL
        }
        let meta = urlString[urlString.startIndex..<comma]
        let payload = String(urlString[urlString.index(after: comma)...])
        if meta.hasSuffix(";base64") {
            guard let data = Data(base64Encoded: payload, options: [.ignoreUnknownCharacters]) else {
                throw APIError.invalidURL
            }
            return data
        }
        let decoded = payload.removingPercentEncoding ?? payload
        return Data(decoded.utf8)
    }
}

private final class ProgressObservationBox: @unchecked Sendable {
    var observation: NSKeyValueObservation?
}

public enum Multipart {
    public static func body(boundary: String, fieldName: String, filename: String, mimeType: String, data: Data) -> Data {
        let safeName = filename
            .replacingOccurrences(of: "\"", with: "'")
            .replacingOccurrences(of: "\r", with: " ")
            .replacingOccurrences(of: "\n", with: " ")
        var body = Data()
        body.append(Data("--\(boundary)\r\n".utf8))
        body.append(Data("Content-Disposition: form-data; name=\"\(fieldName)\"; filename=\"\(safeName)\"\r\n".utf8))
        body.append(Data("Content-Type: \(mimeType)\r\n\r\n".utf8))
        body.append(data)
        body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        return body
    }
}
