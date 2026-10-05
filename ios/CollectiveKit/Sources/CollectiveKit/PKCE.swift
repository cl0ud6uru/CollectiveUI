import Foundation
import CryptoKit

/// Proof Key for Code Exchange (RFC 7636) helpers, S256 method only.
public enum PKCE {
    /// A 43-character code verifier: base64url of 32 random bytes.
    public static func makeVerifier() -> String {
        return base64URLEncode(randomBytes(count: 32))
    }

    /// base64url(SHA256(verifier)) without padding.
    public static func challenge(for verifier: String) -> String {
        let digest = SHA256.hash(data: Data(verifier.utf8))
        return base64URLEncode(Data(digest))
    }

    /// Random opaque value used to bind the callback to this request.
    public static func makeState() -> String {
        return base64URLEncode(randomBytes(count: 16))
    }

    public static func base64URLEncode(_ data: Data) -> String {
        return data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func randomBytes(count: Int) -> Data {
        var bytes = [UInt8]()
        bytes.reserveCapacity(count)
        for _ in 0..<count {
            bytes.append(UInt8.random(in: UInt8.min...UInt8.max))
        }
        return Data(bytes)
    }
}

/// Builds the web authorization URL and interprets the `collectiveui://auth/callback` redirect.
public enum MobileAuth {
    public static let callbackScheme = "collectiveui"

    public enum CallbackResult: Equatable, Sendable {
        case code(String)
        case denied(String)
        case invalid(String)
    }

    public static func authorizeURL(baseURL: URL, challenge: String, state: String, deviceName: String) -> URL? {
        var base = baseURL.absoluteString
        while base.hasSuffix("/") {
            base.removeLast()
        }
        guard var components = URLComponents(string: base + "/mobile/authorize") else {
            return nil
        }
        components.queryItems = [
            URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "device_name", value: String(deviceName.prefix(100))),
        ]
        components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        return components.url
    }

    public static func parseCallback(_ url: URL, expectedState: String) -> CallbackResult {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return .invalid("The sign-in response could not be read.")
        }
        let items = components.queryItems ?? []
        func value(_ name: String) -> String? {
            return items.first(where: { $0.name == name })?.value
        }
        guard let state = value("state"), state == expectedState else {
            return .invalid("The sign-in response didn't match this request. Please try again.")
        }
        if let error = value("error") {
            return .denied(error)
        }
        guard let code = value("code"), !code.isEmpty else {
            return .invalid("The sign-in response was missing an authorization code.")
        }
        return .code(code)
    }
}
