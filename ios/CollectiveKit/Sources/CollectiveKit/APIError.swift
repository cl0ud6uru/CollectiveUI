import Foundation

public enum APIError: Error, LocalizedError, Equatable, Sendable {
    case invalidURL
    case invalidResponse
    case unauthorized
    case server(status: Int, message: String, unsavedMessageId: String?)
    case decoding(String)

    public var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "That doesn't look like a valid server address."
        case .invalidResponse:
            return "The server sent an unexpected response."
        case .unauthorized:
            return "Your session has ended. Please sign in again."
        case .server(let status, let message, _):
            if message.isEmpty {
                return "The server returned an error (\(status))."
            }
            return message
        case .decoding:
            return "Couldn't read the server's response."
        }
    }

    public var statusCode: Int? {
        if case .server(let status, _, _) = self {
            return status
        }
        if case .unauthorized = self {
            return 401
        }
        return nil
    }

    /// Builds an error from a non-2xx response body of the form `{ "error": "...", "unsavedMessageId": "..." }`.
    public static func from(status: Int, data: Data) -> APIError {
        let json = JSONValue.parse(data: data)
        let message = json?["error"]?.stringValue
            ?? json?["message"]?.stringValue
            ?? HTTPURLResponse.localizedString(forStatusCode: status).capitalized
        let unsaved = json?["unsavedMessageId"]?.stringValue
        return .server(status: status, message: message, unsavedMessageId: unsaved)
    }
}

public extension Error {
    /// True when the error means the bearer token is no longer valid.
    var isUnauthorized: Bool {
        if let apiError = self as? APIError, case .unauthorized = apiError {
            return true
        }
        return false
    }

    /// True for task / URL loading cancellations, which should never be shown to the user.
    var isCancellation: Bool {
        if self is CancellationError {
            return true
        }
        if let urlError = self as? URLError, urlError.code == .cancelled {
            return true
        }
        return false
    }
}
