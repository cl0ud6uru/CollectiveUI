import Foundation

public struct ChatSkill: Decodable, Hashable, Sendable {
    public let slug: String
    public let name: String
    public let description: String
}

public struct ComposerCommand: Identifiable, Hashable, Sendable {
    public let value: String
    public let description: String
    public let isSkill: Bool
    public var id: String { value }
    public init(_ value: String, _ description: String, isSkill: Bool = false) {
        self.value = value
        self.description = description
        self.isSkill = isSkill
    }
}

public struct ChatCommandCatalog: Decodable, Sendable {
    public struct Entry: Decodable, Sendable {
        public let name: String
        public let description: String
    }
    public let commands: [Entry]?
    public let revision: Int?
    public let capabilityWarning: String?
}

public struct ChatCommandResult: Decodable, Sendable {
    public let title: String
    public let lines: [String]
    public let revision: Int?
    public let conversationId: String?
    public let navigateTo: String?
    public let refresh: Bool?

    public var destinationConversationId: String? {
        guard let navigateTo, navigateTo.range(of: #"^/c/[A-Za-z0-9_-]{8,64}$"#, options: .regularExpression) != nil else { return nil }
        return String(navigateTo.dropFirst(3))
    }
}

public enum ComposerCommands {
    /// Matches the website; the server is always responsible for execution and authorization.
    public static func options(target: TargetOption?, skills: [ChatSkill], catalog: ChatCommandCatalog?) -> [ComposerCommand] {
        guard let target, target.kind != "group" else { return [] }
        if target.hermes {
            if let commands = catalog?.commands {
                return commands.map { ComposerCommand("/" + $0.name, $0.description) }
            }
            return [
                ComposerCommand("/help", "Commands available in this chat"),
                ComposerCommand("/status", "Reply state and requested / reported model"),
                ComposerCommand("/usage", "Reported tokens for this conversation"),
                ComposerCommand("/new", "Start a fresh session; keep this chat’s history"),
                ComposerCommand("/reset", "Same as /new; keeps history and memory"),
                ComposerCommand("/stop", "Cancel this chat’s reply, including a pending approval"),
                ComposerCommand("/model", "Inspect or request an allowed model for future turns"),
                ComposerCommand("/skills", "List installed Hermes skills (discovery only)"),
                ComposerCommand("/tools", "List Hermes toolsets (read only)"),
            ]
        }
        guard target.kind == "bot" else { return [] }
        return [ComposerCommand("/new", "Start a fresh chat; keep this one in history"), ComposerCommand("/reset", "Same as /new")]
            + skills.map { ComposerCommand("/" + $0.slug, $0.description.isEmpty ? $0.name : $0.description, isSkill: true) }
    }

    public static func inserting(_ command: String, into draft: String) -> String {
        let text = draft.replacingOccurrences(of: #"^\s+"#, with: "", options: .regularExpression)
        let rest = text.replacingOccurrences(of: #"^/(?!/)(?:hermes\s+)?[\w-]*(?=\s|$)\s*"#, with: "", options: [.regularExpression, .caseInsensitive])
        return command + " " + rest
    }

    /// Skills remain normal chat input. Hermes slash controls must never fall through to an LLM.
    public static func isControl(_ text: String, target: TargetOption?) -> Bool {
        guard let target, target.kind != "group" else { return false }
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let match = value.range(of: #"^/[a-z][a-z0-9_-]*(?=\s|$)"#, options: [.regularExpression, .caseInsensitive]) else { return false }
        var name = value[match].dropFirst().lowercased()
        if ["hermes", "portal"].contains(name) {
            name = value[match.upperBound...].split(whereSeparator: \.isWhitespace).first?.lowercased() ?? "help"
        }
        return target.hermes || (target.kind == "bot" && ["new", "reset"].contains(name))
    }

    public static func messageText(_ text: String, target: TargetOption?) -> String {
        if (target?.kind == "bot" || target?.hermes == true) && text.hasPrefix("//") { return String(text.dropFirst()) }
        return text
    }
}
