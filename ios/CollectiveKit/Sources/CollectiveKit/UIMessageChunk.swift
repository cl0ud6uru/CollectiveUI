import Foundation

/// One chunk of the AI SDK UI message stream (the JSON payload of an SSE `data:` line).
public enum UIMessageChunk: Hashable, Sendable {
    case start(messageId: String?, metadata: JSONValue?)
    case startStep
    case finishStep
    case textStart(id: String)
    case textDelta(id: String, delta: String)
    case textEnd(id: String)
    case reasoningStart(id: String)
    case reasoningDelta(id: String, delta: String)
    case reasoningEnd(id: String)
    case toolInputStart(toolCallId: String, toolName: String, dynamic: Bool, title: String?)
    case toolInputDelta(toolCallId: String, delta: String)
    case toolInputAvailable(toolCallId: String, toolName: String, input: JSONValue?, dynamic: Bool, title: String?)
    case toolInputError(toolCallId: String, toolName: String, input: JSONValue?, errorText: String, dynamic: Bool, title: String?)
    case toolApprovalRequest(approvalId: String, toolCallId: String)
    case toolApprovalResponse(approvalId: String, approved: Bool, reason: String?)
    case toolOutputAvailable(toolCallId: String, output: JSONValue?, preliminary: Bool)
    case toolOutputError(toolCallId: String, errorText: String)
    case toolOutputDenied(toolCallId: String)
    case sourceURL(sourceId: String, url: String, title: String?)
    case sourceDocument(sourceId: String, mediaType: String, title: String, filename: String?)
    case file(url: String, mediaType: String)
    case data(name: String, id: String?, data: JSONValue, transient: Bool)
    case messageMetadata(JSONValue)
    case finish(finishReason: String?, metadata: JSONValue?)
    case abort(reason: String?)
    case error(errorText: String)
    case unknown(type: String)

    /// Parses an SSE data payload. Returns nil when it is not a JSON object.
    public static func parse(_ payload: String) -> UIMessageChunk? {
        guard let json = JSONValue.parse(payload), case .object = json else {
            return nil
        }
        return UIMessageChunk(json: json)
    }

    public init(json: JSONValue) {
        let type = json["type"]?.stringValue ?? ""
        func string(_ key: String) -> String? {
            return json[key]?.stringValue
        }
        func bool(_ key: String) -> Bool {
            return json[key]?.boolValue ?? false
        }
        func value(_ key: String) -> JSONValue? {
            return json[key]
        }

        switch type {
        case "start":
            self = .start(messageId: string("messageId"), metadata: value("messageMetadata"))
        case "start-step":
            self = .startStep
        case "finish-step":
            self = .finishStep
        case "text-start":
            self = .textStart(id: string("id") ?? "")
        case "text-delta":
            self = .textDelta(id: string("id") ?? "", delta: string("delta") ?? string("textDelta") ?? "")
        case "text-end":
            self = .textEnd(id: string("id") ?? "")
        case "reasoning-start":
            self = .reasoningStart(id: string("id") ?? "")
        case "reasoning-delta":
            self = .reasoningDelta(id: string("id") ?? "", delta: string("delta") ?? "")
        case "reasoning-end":
            self = .reasoningEnd(id: string("id") ?? "")
        case "tool-input-start":
            if let toolCallId = string("toolCallId") {
                self = .toolInputStart(
                    toolCallId: toolCallId,
                    toolName: string("toolName") ?? "tool",
                    dynamic: bool("dynamic"),
                    title: string("title")
                )
            } else {
                self = .unknown(type: type)
            }
        case "tool-input-delta":
            if let toolCallId = string("toolCallId") {
                self = .toolInputDelta(toolCallId: toolCallId, delta: string("inputTextDelta") ?? "")
            } else {
                self = .unknown(type: type)
            }
        case "tool-input-available":
            if let toolCallId = string("toolCallId") {
                self = .toolInputAvailable(
                    toolCallId: toolCallId,
                    toolName: string("toolName") ?? "tool",
                    input: value("input"),
                    dynamic: bool("dynamic"),
                    title: string("title")
                )
            } else {
                self = .unknown(type: type)
            }
        case "tool-input-error":
            if let toolCallId = string("toolCallId") {
                self = .toolInputError(
                    toolCallId: toolCallId,
                    toolName: string("toolName") ?? "tool",
                    input: value("input"),
                    errorText: string("errorText") ?? "Invalid tool input",
                    dynamic: bool("dynamic"),
                    title: string("title")
                )
            } else {
                self = .unknown(type: type)
            }
        case "tool-approval-request":
            if let approvalId = string("approvalId"), let toolCallId = string("toolCallId") {
                self = .toolApprovalRequest(approvalId: approvalId, toolCallId: toolCallId)
            } else {
                self = .unknown(type: type)
            }
        case "tool-approval-response":
            if let approvalId = string("approvalId") {
                self = .toolApprovalResponse(approvalId: approvalId, approved: bool("approved"), reason: string("reason"))
            } else {
                self = .unknown(type: type)
            }
        case "tool-output-available":
            if let toolCallId = string("toolCallId") {
                self = .toolOutputAvailable(toolCallId: toolCallId, output: value("output"), preliminary: bool("preliminary"))
            } else {
                self = .unknown(type: type)
            }
        case "tool-output-error":
            if let toolCallId = string("toolCallId") {
                self = .toolOutputError(toolCallId: toolCallId, errorText: string("errorText") ?? "Tool failed")
            } else {
                self = .unknown(type: type)
            }
        case "tool-output-denied":
            if let toolCallId = string("toolCallId") {
                self = .toolOutputDenied(toolCallId: toolCallId)
            } else {
                self = .unknown(type: type)
            }
        case "source-url":
            if let url = string("url") {
                self = .sourceURL(sourceId: string("sourceId") ?? url, url: url, title: string("title"))
            } else {
                self = .unknown(type: type)
            }
        case "source-document":
            self = .sourceDocument(
                sourceId: string("sourceId") ?? "",
                mediaType: string("mediaType") ?? "",
                title: string("title") ?? "Document",
                filename: string("filename")
            )
        case "file":
            if let url = string("url") {
                self = .file(url: url, mediaType: string("mediaType") ?? "application/octet-stream")
            } else {
                self = .unknown(type: type)
            }
        case "message-metadata":
            self = .messageMetadata(value("messageMetadata") ?? .null)
        case "finish":
            self = .finish(finishReason: string("finishReason"), metadata: value("messageMetadata"))
        case "abort":
            self = .abort(reason: string("reason"))
        case "error":
            self = .error(errorText: string("errorText") ?? "Something went wrong.")
        default:
            if type.hasPrefix("data-"), type.count > 5 {
                self = .data(
                    name: String(type.dropFirst(5)),
                    id: string("id"),
                    data: value("data") ?? .null,
                    transient: bool("transient")
                )
            } else {
                self = .unknown(type: type)
            }
        }
    }
}

extension UIMessageChunk: Decodable {
    public init(from decoder: Decoder) throws {
        let json = try JSONValue(from: decoder)
        self.init(json: json)
    }
}
