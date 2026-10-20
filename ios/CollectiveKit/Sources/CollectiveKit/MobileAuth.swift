import Foundation

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
        guard components.scheme?.lowercased() == callbackScheme,
              components.host?.lowercased() == "auth", components.path == "/callback",
              components.user == nil, components.password == nil, components.port == nil,
              components.fragment == nil else {
            return .invalid("The sign-in response used an unexpected callback address.")
        }
        let items = components.queryItems ?? []
        for name in ["state", "code", "error"] where items.filter({ $0.name == name }).count > 1 {
            return .invalid("The sign-in response contained duplicate parameters.")
        }
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
