import Foundation

/// Read-only effective identity shared with the website. Older servers omit `pets`.
public struct PetAppearance: Decodable, Hashable, Sendable {
    public let enabled: Bool
    public let appearance: String
    public let motion: String
    public let spriteUrl: String?
    public let spriteVersionNumber: Int?

    private enum CodingKeys: String, CodingKey { case enabled, appearance, motion, spriteUrl, spriteVersionNumber, custom }
    private struct Manifest: Decodable { let spriteVersionNumber: Int? }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = (try? c.decode(Bool.self, forKey: .enabled)) ?? false
        appearance = (try? c.decode(String.self, forKey: .appearance)) ?? "off"
        motion = (try? c.decode(String.self, forKey: .motion)) ?? "auto"
        spriteUrl = try? c.decode(String.self, forKey: .spriteUrl)
        spriteVersionNumber = (try? c.decode(Int.self, forKey: .spriteVersionNumber))
            ?? (try? c.decode(Manifest.self, forKey: .custom))?.spriteVersionNumber
    }

    /// Accept only this bot's effective identity. Web-format metadata maps to the mobile bearer endpoint.
    public func avatarPath(for botId: String) -> String? {
        guard enabled, ["custom", "catalog"].contains(appearance),
              let spriteUrl, let components = URLComponents(string: spriteUrl),
              components.scheme == nil, components.host == nil, components.fragment == nil,
              let encodedId = botId.addingPercentEncoding(withAllowedCharacters: CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")),
              components.percentEncodedPath == "/api/mobile/v1/bots/\(encodedId)/pet/avatar"
                || components.percentEncodedPath == "/api/bots/\(encodedId)/pet/avatar",
              let query = components.queryItems, query.count == 1, query[0].name == "v",
              let revision = query[0].value, !revision.isEmpty else { return nil }
        var result = URLComponents()
        result.percentEncodedPath = "/api/mobile/v1/bots/\(encodedId)/pet/avatar"
        result.queryItems = [URLQueryItem(name: "v", value: revision)]
        return result.string
    }
}


public enum BotActivity: String, Sendable {
    case idle, working, approval, attention, unavailable

    public var atlasRow: Int {
        switch self {
        case .idle, .unavailable: return 0
        case .working: return 7
        case .approval: return 6
        case .attention: return 5
        }
    }

    public var frameCount: Int {
        self == .unavailable ? 1 : (self == .attention ? 8 : 6)
    }

    public var duration: TimeInterval {
        switch self {
        case .idle: return 1.2
        case .working: return 0.9
        case .approval, .attention: return 1.5
        case .unavailable: return 1
        }
    }
}
