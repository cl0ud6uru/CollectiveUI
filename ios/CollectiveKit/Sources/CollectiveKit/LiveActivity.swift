import Foundation
#if os(iOS)
import ActivityKit
#endif

public enum RunActivityPhase: String, Codable, Sendable, CaseIterable {
    case queued, working, attention, completed, failed, cancelled, reconnecting
    public var isTerminal: Bool { [.completed, .failed, .cancelled].contains(self) }
    public var label: String {
        switch self {
        case .queued: return "Queued"
        case .working: return "Working"
        case .attention: return "Needs your attention"
        case .completed: return "Completed"
        case .failed: return "Needs attention · failed"
        case .cancelled: return "Stopped"
        case .reconnecting: return "Reconnecting"
        }
    }
    public var symbol: String {
        switch self {
        case .queued: return "clock"
        case .working: return "ellipsis"
        case .attention: return "exclamationmark.bubble.fill"
        case .completed: return "checkmark.circle.fill"
        case .failed: return "exclamationmark.triangle.fill"
        case .cancelled: return "stop.circle"
        case .reconnecting: return "wifi.slash"
        }
    }
    public var poseIndex: Int {
        switch self {
        case .queued, .completed, .cancelled, .reconnecting: return 0
        case .working: return 1
        case .attention: return 2
        case .failed: return 3
        }
    }
}

public struct RunActivityContent: Codable, Hashable, Sendable {
    public var phase: RunActivityPhase
    public var updatedAt: Int
    public var revision: Int
    public init(phase: RunActivityPhase, updatedAt: Int, revision: Int = 0) {
        self.phase = phase; self.updatedAt = updatedAt; self.revision = revision
    }
    /// A reconnect snapshot must never rewind content already received from APNs.
    public func accepts(_ next: Self) -> Bool {
        !phase.isTerminal && (next.updatedAt > updatedAt || (next.updatedAt == updatedAt && next.revision >= revision))
    }
}

public struct RunActivitySnapshot: Decodable, Sendable {
    public var runId: String
    public var conversationId: String
    public var botId: String
    public var content: RunActivityContent
    public var backgroundUpdates: Bool
}

public struct CollectiveRunAttributes: Codable, Hashable, Sendable {
    public typealias ContentState = RunActivityContent
    // Scope is a random per-login local identifier, never the account id, URL, or bearer token.
    public var scope: String
    public var conversationId: String
    public var botId: String
    public var runId: String
    public var pet: String
    /// 24×26 four-pose paletted stills; <= 1,752 base64 bytes. No network or App Group grant needed.
    public var petPixels: String
    public init(scope: String, conversationId: String, botId: String, runId: String, pet: String, petPixels: String = "") {
        self.scope = scope; self.conversationId = conversationId; self.botId = botId; self.runId = runId
        self.pet = pet; self.petPixels = petPixels
    }
    public var chatURL: URL? {
        var c = URLComponents(); c.scheme = "collectiveui"; c.host = "activity"
        c.queryItems = [URLQueryItem(name: "scope", value: scope), URLQueryItem(name: "conversation", value: conversationId),
            URLQueryItem(name: "bot", value: botId), URLQueryItem(name: "run", value: runId)]
        return c.url
    }
}
#if os(iOS)
extension CollectiveRunAttributes: ActivityAttributes {}
#endif

public struct ActivityDeepLink: Equatable, Sendable {
    public let conversationId: String
    public let botId: String
    public let runId: String
    public init?(url: URL, expectedScope: String) {
        guard let c = URLComponents(url: url, resolvingAgainstBaseURL: false), c.scheme == "collectiveui", c.host == "activity",
              c.path.isEmpty, c.fragment == nil, c.user == nil, c.password == nil, c.port == nil,
              let items = c.queryItems, items.count == 4 else { return nil }
        let keys = ["scope", "conversation", "bot", "run"]
        guard Set(items.map(\.name)) == Set(keys), items.first(where: { $0.name == "scope" })?.value == expectedScope else { return nil }
        func id(_ key: String) -> String? {
            guard let v = items.first(where: { $0.name == key })?.value, !v.isEmpty, v.count <= 100,
                  v.unicodeScalars.allSatisfy({ CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-").contains($0) }) else { return nil }
            return v
        }
        guard let chat = id("conversation"), let bot = id("bot"), let run = id("run") else { return nil }
        conversationId = chat; botId = bot; runId = run
    }
}

public enum ActivityStartPolicy {
    public static func mayStart(enabled: Bool, authorized: Bool, foreground: Bool, phase: RunActivityPhase,
                                runId: String, existingRunIds: [String], dismissedRunIds: Set<String>) -> Bool {
        enabled && authorized && foreground && !phase.isTerminal && !existingRunIds.contains(runId)
            && existingRunIds.count < 3 && !dismissedRunIds.contains(runId)
    }
}

/// Fixed framing prevents arbitrary decoded data from inflating the widget layout or payload.
public struct ActivityPetPixels: Sendable {
    public static let width = 24
    public static let height = 26
    public static let byteCount = 64 + width * height * 4 / 2
    public let bytes: [UInt8]
    public init?(base64: String) {
        guard base64.utf8.count <= 1752, let data = Data(base64Encoded: base64), data.count == Self.byteCount else { return nil }
        bytes = Array(data)
    }
    public func rgba(x: Int, y: Int, pose: Int) -> (UInt8, UInt8, UInt8, UInt8) {
        guard (0..<Self.width).contains(x), (0..<Self.height).contains(y), (0..<4).contains(pose) else { return (0, 0, 0, 0) }
        let pixel = pose * Self.width * Self.height + y * Self.width + x
        let b = bytes[64 + pixel / 2]
        let i = Int(pixel % 2 == 0 ? b >> 4 : b & 15) * 4
        return (bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3])
    }
}
