import Foundation

/// Side effects of applying a chunk that the UI may want to react to.
public enum StreamEvent: Hashable, Sendable {
    case started(messageId: String)
    case title(String)
    case notice(String)
    case error(String)
    case data(name: String, data: JSONValue)
    case finished(reason: String?)
    case aborted(reason: String?)
}

/// Applies UI message stream chunks to an assistant `UIMessage`.
/// Pure value type so it can be unit-tested without networking.
public struct UIMessageStreamReducer: Sendable {
    public private(set) var message: UIMessage
    /// True when continuing an existing message (e.g. after answering tool approvals):
    /// the message keeps its id even if `start` carries a different one.
    public let isContinuation: Bool
    public private(set) var isFinished: Bool = false
    public private(set) var errorText: String? = nil

    private var activeText: [String: Int] = [:]
    private var activeReasoning: [String: Int] = [:]
    private var toolInputBuffers: [String: String] = [:]

    /// Starts a fresh assistant message. `start.messageId` replaces the placeholder id.
    public init(messageId: String) {
        self.message = UIMessage(id: messageId, role: .assistant, parts: [])
        self.isContinuation = false
    }

    /// Continues appending to an existing assistant message.
    public init(continuing message: UIMessage) {
        self.message = message
        self.isContinuation = true
    }

    @discardableResult
    public mutating func apply(_ chunk: UIMessageChunk) -> [StreamEvent] {
        switch chunk {
        case let .start(messageId, metadata):
            if let messageId, !messageId.isEmpty, !isContinuation {
                message.id = messageId
            }
            mergeMetadata(metadata)
            return [.started(messageId: message.id)]

        case .startStep:
            message.parts.append(.stepStart)
            return []

        case .finishStep:
            activeText.removeAll()
            activeReasoning.removeAll()
            return []

        case let .textStart(id):
            message.parts.append(.text(TextPart(text: "", state: "streaming")))
            activeText[id] = message.parts.count - 1
            return []

        case let .textDelta(id, delta):
            appendDelta(delta, id: id, reasoning: false)
            return []

        case let .textEnd(id):
            endPart(id: id, reasoning: false)
            return []

        case let .reasoningStart(id):
            message.parts.append(.reasoning(TextPart(text: "", state: "streaming")))
            activeReasoning[id] = message.parts.count - 1
            return []

        case let .reasoningDelta(id, delta):
            appendDelta(delta, id: id, reasoning: true)
            return []

        case let .reasoningEnd(id):
            endPart(id: id, reasoning: true)
            return []

        case let .toolInputStart(toolCallId, toolName, dynamic, title):
            upsertTool(toolCallId, toolName: toolName, dynamic: dynamic) { part in
                part.state = "input-streaming"
                if let title {
                    part.title = title
                }
            }
            return []

        case let .toolInputDelta(toolCallId, delta):
            let text = (toolInputBuffers[toolCallId] ?? "") + delta
            toolInputBuffers[toolCallId] = text
            let parsed = JSONValue.parse(text)
            upsertTool(toolCallId, toolName: nil, dynamic: false) { part in
                part.inputText = text
                if let parsed {
                    part.input = parsed
                }
            }
            return []

        case let .toolInputAvailable(toolCallId, toolName, input, dynamic, title):
            toolInputBuffers[toolCallId] = nil
            upsertTool(toolCallId, toolName: toolName, dynamic: dynamic) { part in
                part.state = "input-available"
                part.input = MessagePart.nonNull(input)
                part.inputText = nil
                if let title {
                    part.title = title
                }
            }
            return []

        case let .toolInputError(toolCallId, toolName, input, errorText, dynamic, title):
            toolInputBuffers[toolCallId] = nil
            upsertTool(toolCallId, toolName: toolName, dynamic: dynamic) { part in
                part.state = "output-error"
                part.input = MessagePart.nonNull(input)
                part.errorText = errorText
                if let title {
                    part.title = title
                }
            }
            return []

        case let .toolApprovalRequest(approvalId, toolCallId):
            upsertTool(toolCallId, toolName: nil, dynamic: false) { part in
                part.state = "approval-requested"
                part.approval = ToolApproval(id: approvalId)
            }
            return []

        case let .toolApprovalResponse(approvalId, approved, reason):
            if let index = indexOfTool(approvalId: approvalId), case .tool(var part) = message.parts[index] {
                part.state = "approval-responded"
                part.approval = ToolApproval(id: approvalId, approved: approved, reason: reason)
                message.parts[index] = .tool(part)
            }
            return []

        case let .toolOutputAvailable(toolCallId, output, preliminary):
            upsertTool(toolCallId, toolName: nil, dynamic: false) { part in
                part.state = "output-available"
                part.output = MessagePart.nonNull(output)
                part.preliminary = preliminary ? true : nil
            }
            return []

        case let .toolOutputError(toolCallId, errorText):
            upsertTool(toolCallId, toolName: nil, dynamic: false) { part in
                part.state = "output-error"
                part.errorText = errorText
            }
            return []

        case let .toolOutputDenied(toolCallId):
            upsertTool(toolCallId, toolName: nil, dynamic: false) { part in
                part.state = "output-denied"
            }
            return []

        case let .sourceURL(sourceId, url, title):
            message.parts.append(.sourceURL(SourceURLPart(sourceId: sourceId, url: url, title: title)))
            return []

        case let .sourceDocument(sourceId, mediaType, title, filename):
            message.parts.append(.sourceDocument(SourceDocumentPart(sourceId: sourceId, mediaType: mediaType, title: title, filename: filename)))
            return []

        case let .file(url, mediaType):
            message.parts.append(.file(FilePart(mediaType: mediaType, filename: nil, url: url)))
            return []

        case let .data(name, id, data, transient):
            var events: [StreamEvent] = [.data(name: name, data: data)]
            if name == "title", let title = data["title"]?.stringValue ?? data.stringValue {
                events.append(.title(title))
            }
            if name == "notice", let notice = data["message"]?.stringValue ?? data.stringValue {
                events.append(.notice(notice))
            }
            if !transient {
                let newPart = DataPart(name: name, id: id, data: data)
                if let id, let index = indexOfData(name: name, id: id) {
                    message.parts[index] = .data(newPart)
                } else {
                    message.parts.append(.data(newPart))
                }
            }
            return events

        case let .messageMetadata(metadata):
            mergeMetadata(metadata)
            return []

        case let .finish(reason, metadata):
            mergeMetadata(metadata)
            finalizeStreamingParts()
            isFinished = true
            return [.finished(reason: reason)]

        case let .abort(reason):
            finalizeStreamingParts()
            isFinished = true
            return [.aborted(reason: reason)]

        case let .error(errorText):
            self.errorText = errorText
            return [.error(errorText)]

        case .unknown:
            return []
        }
    }

    // MARK: - Helpers

    private mutating func appendDelta(_ delta: String, id: String, reasoning: Bool) {
        let existing = reasoning ? activeReasoning[id] : activeText[id]
        if let index = existing, index < message.parts.count {
            switch message.parts[index] {
            case .text(var part) where !reasoning:
                part.text += delta
                message.parts[index] = .text(part)
                return
            case .reasoning(var part) where reasoning:
                part.text += delta
                message.parts[index] = .reasoning(part)
                return
            default:
                break
            }
        }
        let part = TextPart(text: delta, state: "streaming")
        if reasoning {
            message.parts.append(.reasoning(part))
            activeReasoning[id] = message.parts.count - 1
        } else {
            message.parts.append(.text(part))
            activeText[id] = message.parts.count - 1
        }
    }

    private mutating func endPart(id: String, reasoning: Bool) {
        let existing = reasoning ? activeReasoning[id] : activeText[id]
        if let index = existing, index < message.parts.count {
            switch message.parts[index] {
            case .text(var part) where !reasoning:
                part.state = "done"
                message.parts[index] = .text(part)
            case .reasoning(var part) where reasoning:
                part.state = "done"
                message.parts[index] = .reasoning(part)
            default:
                break
            }
        }
        if reasoning {
            activeReasoning[id] = nil
        } else {
            activeText[id] = nil
        }
    }

    private mutating func finalizeStreamingParts() {
        for index in message.parts.indices {
            switch message.parts[index] {
            case .text(var part) where part.state == "streaming":
                part.state = "done"
                message.parts[index] = .text(part)
            case .reasoning(var part) where part.state == "streaming":
                part.state = "done"
                message.parts[index] = .reasoning(part)
            default:
                break
            }
        }
        activeText.removeAll()
        activeReasoning.removeAll()
    }

    private func indexOfTool(_ toolCallId: String) -> Int? {
        return message.parts.firstIndex(where: { part in
            if case .tool(let tool) = part {
                return tool.toolCallId == toolCallId
            }
            return false
        })
    }

    private func indexOfTool(approvalId: String) -> Int? {
        return message.parts.firstIndex(where: { part in
            if case .tool(let tool) = part {
                return tool.approval?.id == approvalId
            }
            return false
        })
    }

    private func indexOfData(name: String, id: String) -> Int? {
        return message.parts.firstIndex(where: { part in
            if case .data(let data) = part {
                return data.name == name && data.id == id
            }
            return false
        })
    }

    /// Updates the tool part for `toolCallId`, creating it when `toolName` is given and no part exists yet.
    private mutating func upsertTool(_ toolCallId: String, toolName: String?, dynamic: Bool, _ update: (inout ToolPart) -> Void) {
        if let index = indexOfTool(toolCallId), case .tool(var part) = message.parts[index] {
            update(&part)
            message.parts[index] = .tool(part)
        } else if let toolName {
            var part = ToolPart(toolCallId: toolCallId, toolName: toolName, dynamic: dynamic)
            update(&part)
            message.parts.append(.tool(part))
        }
    }

    private mutating func mergeMetadata(_ metadata: JSONValue?) {
        guard let metadata else { return }
        if case .null = metadata {
            return
        }
        if case .object(let incoming) = metadata, case .object(var existing)? = message.metadata {
            for (key, value) in incoming {
                existing[key] = value
            }
            message.metadata = .object(existing)
        } else {
            message.metadata = metadata
        }
    }
}
