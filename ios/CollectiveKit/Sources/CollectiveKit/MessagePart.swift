import Foundation

public struct TextPart: Hashable, Sendable {
    public var text: String
    public var state: String?

    public init(text: String, state: String? = nil) {
        self.text = text
        self.state = state
    }
}

public struct FilePart: Hashable, Sendable {
    public var mediaType: String
    public var filename: String?
    public var url: String

    public init(mediaType: String, filename: String? = nil, url: String) {
        self.mediaType = mediaType
        self.filename = filename
        self.url = url
    }

    public var isImage: Bool {
        return mediaType.lowercased().hasPrefix("image/")
    }
}

public struct SourceURLPart: Hashable, Sendable {
    public var sourceId: String
    public var url: String
    public var title: String?

    public init(sourceId: String, url: String, title: String? = nil) {
        self.sourceId = sourceId
        self.url = url
        self.title = title
    }
}

public struct SourceDocumentPart: Hashable, Sendable {
    public var sourceId: String
    public var mediaType: String
    public var title: String
    public var filename: String?

    public init(sourceId: String, mediaType: String, title: String, filename: String? = nil) {
        self.sourceId = sourceId
        self.mediaType = mediaType
        self.title = title
        self.filename = filename
    }
}

public struct ToolApproval: Hashable, Sendable {
    public var id: String
    public var approved: Bool?
    public var reason: String?

    public init(id: String, approved: Bool? = nil, reason: String? = nil) {
        self.id = id
        self.approved = approved
        self.reason = reason
    }

    public func toJSON() -> JSONValue {
        var object: [String: JSONValue] = ["id": .string(id)]
        if let approved {
            object["approved"] = .bool(approved)
        }
        if let reason {
            object["reason"] = .string(reason)
        }
        return .object(object)
    }
}

public enum ToolPhase: Hashable, Sendable {
    case running
    case awaitingApproval
    case approvalResponded
    case completed
    case failed
    case denied
}

public struct ToolPart: Hashable, Sendable {
    /// `tool-<name>` or `dynamic-tool`.
    public var type: String
    public var toolName: String
    public var toolCallId: String
    public var state: String
    public var input: JSONValue?
    /// Raw streamed input text (from tool-input-delta), not sent back to the server.
    public var inputText: String?
    public var output: JSONValue?
    public var errorText: String?
    public var title: String?
    public var approval: ToolApproval?
    public var preliminary: Bool?

    public init(
        toolCallId: String,
        toolName: String,
        dynamic: Bool = false,
        state: String = "input-streaming",
        input: JSONValue? = nil,
        output: JSONValue? = nil,
        errorText: String? = nil,
        title: String? = nil,
        approval: ToolApproval? = nil
    ) {
        self.type = dynamic ? "dynamic-tool" : "tool-" + toolName
        self.toolName = toolName
        self.toolCallId = toolCallId
        self.state = state
        self.input = input
        self.inputText = nil
        self.output = output
        self.errorText = errorText
        self.title = title
        self.approval = approval
        self.preliminary = nil
    }

    public var isDynamic: Bool {
        return type == "dynamic-tool"
    }

    public var phase: ToolPhase {
        switch state {
        case "approval-requested":
            return .awaitingApproval
        case "approval-responded":
            return .approvalResponded
        case "output-available":
            return preliminary == true ? .running : .completed
        case "output-error":
            return .failed
        case "output-denied":
            return .denied
        default:
            return .running
        }
    }
}

public struct DataPart: Hashable, Sendable {
    /// The part type without the `data-` prefix, e.g. `speaker`.
    public var name: String
    public var id: String?
    public var data: JSONValue

    public init(name: String, id: String? = nil, data: JSONValue) {
        self.name = name
        self.id = id
        self.data = data
    }
}

/// A part of a `UIMessage`. Unrecognised part types decode to `.unknown`
/// and keep their raw JSON so nothing is lost.
public enum MessagePart: Hashable, Sendable {
    case text(TextPart)
    case reasoning(TextPart)
    case stepStart
    case file(FilePart)
    case sourceURL(SourceURLPart)
    case sourceDocument(SourceDocumentPart)
    case tool(ToolPart)
    case data(DataPart)
    case unknown(JSONValue)

    public init(json: JSONValue) {
        let type = json["type"]?.stringValue ?? ""
        switch type {
        case "text":
            self = .text(TextPart(text: json["text"]?.stringValue ?? "", state: json["state"]?.stringValue))
        case "reasoning":
            self = .reasoning(TextPart(text: json["text"]?.stringValue ?? "", state: json["state"]?.stringValue))
        case "step-start":
            self = .stepStart
        case "file":
            if let url = json["url"]?.stringValue {
                self = .file(FilePart(
                    mediaType: json["mediaType"]?.stringValue ?? "application/octet-stream",
                    filename: json["filename"]?.stringValue,
                    url: url
                ))
            } else {
                self = .unknown(json)
            }
        case "source-url":
            if let url = json["url"]?.stringValue {
                self = .sourceURL(SourceURLPart(
                    sourceId: json["sourceId"]?.stringValue ?? url,
                    url: url,
                    title: json["title"]?.stringValue
                ))
            } else {
                self = .unknown(json)
            }
        case "source-document":
            self = .sourceDocument(SourceDocumentPart(
                sourceId: json["sourceId"]?.stringValue ?? "",
                mediaType: json["mediaType"]?.stringValue ?? "",
                title: json["title"]?.stringValue ?? "Document",
                filename: json["filename"]?.stringValue
            ))
        default:
            if type == "dynamic-tool" || type.hasPrefix("tool-"), let toolCallId = json["toolCallId"]?.stringValue {
                let isDynamic = type == "dynamic-tool"
                let toolName = isDynamic ? (json["toolName"]?.stringValue ?? "tool") : String(type.dropFirst(5))
                var part = ToolPart(toolCallId: toolCallId, toolName: toolName, dynamic: isDynamic)
                part.type = type
                part.input = MessagePart.nonNull(json["input"])
                part.output = MessagePart.nonNull(json["output"])
                part.errorText = json["errorText"]?.stringValue
                part.title = json["title"]?.stringValue
                part.preliminary = json["preliminary"]?.boolValue
                if let approval = json["approval"], let approvalId = approval["id"]?.stringValue {
                    part.approval = ToolApproval(
                        id: approvalId,
                        approved: approval["approved"]?.boolValue,
                        reason: approval["reason"]?.stringValue
                    )
                }
                if let state = json["state"]?.stringValue {
                    part.state = state
                } else if part.errorText != nil {
                    part.state = "output-error"
                } else if part.output != nil {
                    part.state = "output-available"
                } else {
                    part.state = "input-available"
                }
                self = .tool(part)
            } else if type.hasPrefix("data-"), type.count > 5 {
                self = .data(DataPart(
                    name: String(type.dropFirst(5)),
                    id: json["id"]?.stringValue,
                    data: json["data"] ?? .null
                ))
            } else {
                self = .unknown(json)
            }
        }
    }

    static func nonNull(_ value: JSONValue?) -> JSONValue? {
        guard let value else { return nil }
        if case .null = value {
            return nil
        }
        return value
    }

    /// The wire `type` of this part.
    public var typeName: String {
        switch self {
        case .text:
            return "text"
        case .reasoning:
            return "reasoning"
        case .stepStart:
            return "step-start"
        case .file:
            return "file"
        case .sourceURL:
            return "source-url"
        case .sourceDocument:
            return "source-document"
        case .tool(let part):
            return part.type
        case .data(let part):
            return "data-" + part.name
        case .unknown(let raw):
            return raw["type"]?.stringValue ?? ""
        }
    }

    public func toJSON() -> JSONValue {
        switch self {
        case .text(let part):
            var object: [String: JSONValue] = ["type": "text", "text": .string(part.text)]
            if let state = part.state {
                object["state"] = .string(state)
            }
            return .object(object)
        case .reasoning(let part):
            var object: [String: JSONValue] = ["type": "reasoning", "text": .string(part.text)]
            if let state = part.state {
                object["state"] = .string(state)
            }
            return .object(object)
        case .stepStart:
            return .object(["type": "step-start"])
        case .file(let part):
            var object: [String: JSONValue] = [
                "type": "file",
                "mediaType": .string(part.mediaType),
                "url": .string(part.url),
            ]
            if let filename = part.filename {
                object["filename"] = .string(filename)
            }
            return .object(object)
        case .sourceURL(let part):
            var object: [String: JSONValue] = [
                "type": "source-url",
                "sourceId": .string(part.sourceId),
                "url": .string(part.url),
            ]
            if let title = part.title {
                object["title"] = .string(title)
            }
            return .object(object)
        case .sourceDocument(let part):
            var object: [String: JSONValue] = [
                "type": "source-document",
                "sourceId": .string(part.sourceId),
                "mediaType": .string(part.mediaType),
                "title": .string(part.title),
            ]
            if let filename = part.filename {
                object["filename"] = .string(filename)
            }
            return .object(object)
        case .tool(let part):
            var object: [String: JSONValue] = [
                "type": .string(part.type),
                "toolCallId": .string(part.toolCallId),
                "state": .string(part.state),
            ]
            if part.isDynamic {
                object["toolName"] = .string(part.toolName)
            }
            if let input = part.input {
                object["input"] = input
            }
            if let output = part.output {
                object["output"] = output
            }
            if let errorText = part.errorText {
                object["errorText"] = .string(errorText)
            }
            if let title = part.title {
                object["title"] = .string(title)
            }
            if let approval = part.approval {
                object["approval"] = approval.toJSON()
            }
            if let preliminary = part.preliminary {
                object["preliminary"] = .bool(preliminary)
            }
            return .object(object)
        case .data(let part):
            var object: [String: JSONValue] = ["type": .string("data-" + part.name), "data": part.data]
            if let id = part.id {
                object["id"] = .string(id)
            }
            return .object(object)
        case .unknown(let raw):
            return raw
        }
    }
}

extension MessagePart: Codable {
    public init(from decoder: Decoder) throws {
        let json = try JSONValue(from: decoder)
        self.init(json: json)
    }

    public func encode(to encoder: Encoder) throws {
        try toJSON().encode(to: encoder)
    }
}

public enum MessageRole: String, Hashable, Sendable, Codable {
    case user
    case assistant
    case system
}

public struct UIMessage: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var role: MessageRole
    public var parts: [MessagePart]
    public var metadata: JSONValue?

    public init(id: String, role: MessageRole, parts: [MessagePart] = [], metadata: JSONValue? = nil) {
        self.id = id
        self.role = role
        self.parts = parts
        self.metadata = metadata
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case role
        case parts
        case metadata
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = container.lenient(String.self, .id) ?? ""
        role = MessageRole(rawValue: container.lenient(String.self, .role) ?? "") ?? .assistant
        parts = container.lenient([MessagePart].self, .parts) ?? []
        metadata = container.lenient(JSONValue.self, .metadata)
    }

    public func encode(to encoder: Encoder) throws {
        try toJSON().encode(to: encoder)
    }

    public func toJSON() -> JSONValue {
        var object: [String: JSONValue] = [
            "id": .string(id),
            "role": .string(role.rawValue),
            "parts": .array(parts.map { $0.toJSON() }),
        ]
        if let metadata {
            object["metadata"] = metadata
        }
        return .object(object)
    }

    /// All text parts joined, used for copy and for restoring the composer.
    public var plainText: String {
        let texts = parts.compactMap { part -> String? in
            if case .text(let text) = part {
                return text.text
            }
            return nil
        }
        return texts.joined(separator: "\n\n")
    }

    public var files: [FilePart] {
        return parts.compactMap { part -> FilePart? in
            if case .file(let file) = part {
                return file
            }
            return nil
        }
    }

    public var toolParts: [ToolPart] {
        return parts.compactMap { part -> ToolPart? in
            if case .tool(let tool) = part {
                return tool
            }
            return nil
        }
    }

    /// Tool parts currently waiting for the user's approve/deny decision.
    public var pendingApprovals: [ToolPart] {
        return toolParts.filter { $0.state == "approval-requested" && $0.approval != nil }
    }

    /// Whether anything renderable has arrived yet (used for the typing indicator).
    public var hasVisibleContent: Bool {
        for part in parts {
            switch part {
            case .text(let text):
                if !text.text.isEmpty { return true }
            case .reasoning, .tool, .file, .sourceURL, .sourceDocument:
                return true
            case .data(let data):
                if data.name == "run-error" || data.name == "bot-error" { return true }
            case .stepStart, .unknown:
                break
            }
        }
        return false
    }
}
