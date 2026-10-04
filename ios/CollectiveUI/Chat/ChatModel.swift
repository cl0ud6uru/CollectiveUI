import Foundation
import Observation
import UniformTypeIdentifiers
import CollectiveKit

struct ApprovalDecision: Hashable {
    var approved: Bool
    var reason: String?
}

struct ComposerAttachment: Identifiable, Hashable {
    let id: UUID
    var filename: String
    var mediaType: String
    var progress: Double
    var uploaded: UploadedFile?
    var errorText: String?
    var previewData: Data?

    var isUploading: Bool {
        return uploaded == nil && errorText == nil
    }

    var isImage: Bool {
        return mediaType.lowercased().hasPrefix("image/")
    }
}

/// State and actions for one conversation: snapshot loading, streaming, approvals and the composer.
@MainActor
@Observable
final class ChatModel {
    let app: AppModel
    let conversationId: String

    private(set) var newChatTarget: TargetOption? = nil
    private(set) var isNew: Bool = false

    var title: String? = nil
    var target: TargetOption? = nil
    var source: String = "chat"
    var isGroup: Bool = false
    var isUnavailable: Bool = false
    var unavailableReason: String? = nil

    var messages: [UIMessage] = []
    var isLoading: Bool = false
    var loadError: String? = nil
    var isStreaming: Bool = false
    var isStopping: Bool = false
    var inlineError: String? = nil
    var alertMessage: String? = nil

    var composerText: String = ""
    var attachments: [ComposerAttachment] = []
    var approvalDecisions: [String: ApprovalDecision] = [:]

    /// Bumped whenever the view should scroll to the bottom.
    var scrollToken: Int = 0

    @ObservationIgnored private var streamTask: Task<Void, Never>? = nil
    @ObservationIgnored private var streamingMessageId: String? = nil
    @ObservationIgnored private var autoResumeBudget: Int = 2
    @ObservationIgnored private var isActive: Bool = false
    @ObservationIgnored private var hasLoaded: Bool = false

    init(app: AppModel, conversationId: String, newChatTarget: TargetOption?) {
        self.app = app
        self.conversationId = conversationId
        self.newChatTarget = newChatTarget
        self.isNew = newChatTarget != nil
        self.target = newChatTarget
    }

    // MARK: - Derived state

    var isReadOnly: Bool {
        return source == "delegation"
    }

    var displayTitle: String {
        if let title, !title.isEmpty {
            return title
        }
        if isNew {
            return target?.name ?? "New chat"
        }
        return target?.name ?? "Chat"
    }

    var assistantName: String {
        return target?.name ?? "Assistant"
    }

    var assistantIcon: String? {
        if let icon = target?.icon {
            return icon
        }
        return target?.kind == "app" ? "✨" : nil
    }

    var hasComposerContent: Bool {
        let hasText = !composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let hasFiles = attachments.contains(where: { $0.uploaded != nil })
        return hasText || hasFiles
    }

    var isUploading: Bool {
        return attachments.contains(where: { $0.isUploading })
    }

    var canSend: Bool {
        return !isStreaming && !isReadOnly && !isUnavailable && !isUploading && hasComposerContent
    }

    var showsTypingIndicator: Bool {
        guard isStreaming else { return false }
        guard let last = messages.last else { return true }
        if last.role == .assistant {
            return !last.hasVisibleContent
        }
        return true
    }

    var lastAssistantMessageId: String? {
        guard let last = messages.last, last.role == .assistant else { return nil }
        return last.id
    }

    var canAnswerApprovals: Bool {
        return !isStreaming && !isReadOnly && !isUnavailable
    }

    // MARK: - Lifecycle

    func activate() async {
        isActive = true
        if !hasLoaded {
            hasLoaded = true
            await load(showSpinner: true)
        } else if !isStreaming {
            await load(showSpinner: false)
        }
    }

    func deactivate() {
        isActive = false
        if isStreaming {
            // The server keeps generating; the reply is resumed when the chat is opened again.
            streamTask?.cancel()
        }
    }

    func load(showSpinner: Bool) async {
        guard !isNew, let api = app.api else { return }
        if showSpinner && messages.isEmpty {
            isLoading = true
        }
        do {
            let snapshot = try await api.snapshot(conversationId: conversationId)
            apply(snapshot)
            if snapshot.resume && isActive && !isStreaming && autoResumeBudget > 0 {
                autoResumeBudget -= 1
                resume()
            }
        } catch {
            if !error.isUnauthorized && !error.isCancellation && messages.isEmpty {
                loadError = error.localizedDescription
            }
        }
        isLoading = false
    }

    private func apply(_ snapshot: ConversationSnapshot) {
        loadError = nil
        if let summary = snapshot.summary {
            title = summary.title
            source = summary.source
            isGroup = summary.isGroup
        }
        if let snapshotTarget = snapshot.target {
            target = snapshotTarget
        }
        isUnavailable = snapshot.unavailable
        unavailableReason = snapshot.unavailableReason
        guard !isStreaming else { return }
        messages = snapshot.displayedThread()
        scrollToken += 1
    }

    // MARK: - Sending

    func send() {
        guard canSend, let api = app.api else { return }
        let text = composerText.trimmingCharacters(in: .whitespacesAndNewlines)
        var parts: [MessagePart] = []
        if !text.isEmpty {
            parts.append(.text(TextPart(text: text)))
        }
        for attachment in attachments {
            if let file = attachment.uploaded {
                parts.append(.file(FilePart(mediaType: file.mediaType, filename: file.filename, url: file.url)))
            }
        }
        guard !parts.isEmpty else { return }

        let message = UIMessage(id: IDGenerator.make(), role: .user, parts: parts)
        var body: [String: JSONValue] = [
            "conversationId": .string(conversationId),
            "message": message.toJSON(),
        ]
        if let parentId = messages.last?.id {
            body["parentId"] = .string(parentId)
        } else {
            body["parentId"] = .null
        }
        if isNew, let newTarget = newChatTarget {
            if newTarget.kind == "bot" {
                body["botId"] = .string(newTarget.id)
            } else if newTarget.kind == "app" {
                body["appId"] = .string(newTarget.id)
            }
        }

        messages.append(message)
        composerText = ""
        attachments = []
        inlineError = nil
        autoResumeBudget = 2
        scrollToken += 1

        startStream(api.streamChat(body: .object(body)), reducer: UIMessageStreamReducer(messageId: IDGenerator.make()), existingMessageId: nil)
    }

    func sendStarter(_ text: String) {
        composerText = text
        send()
    }

    /// Re-generates the reply to the user message preceding `assistantMessageId`.
    func regenerate(assistantMessageId: String) {
        guard !isStreaming, !isReadOnly, !isUnavailable, let api = app.api else { return }
        guard let index = messages.firstIndex(where: { $0.id == assistantMessageId }) else { return }
        guard let userIndex = messages[..<index].lastIndex(where: { $0.role == .user }) else { return }
        let userMessageId = messages[userIndex].id
        messages.removeSubrange((userIndex + 1)...)
        inlineError = nil
        autoResumeBudget = 2
        scrollToken += 1
        let body: JSONValue = .object([
            "conversationId": .string(conversationId),
            "regenerate": .bool(true),
            "parentId": .string(userMessageId),
        ])
        startStream(api.streamChat(body: body), reducer: UIMessageStreamReducer(messageId: IDGenerator.make()), existingMessageId: nil)
    }

    /// Re-attaches to a reply that is still running on the server.
    func resume() {
        guard !isStreaming, let api = app.api else { return }
        startStream(api.resumeStream(conversationId: conversationId), reducer: UIMessageStreamReducer(messageId: IDGenerator.make()), existingMessageId: nil)
    }

    func stop() {
        guard isStreaming, !isStopping else { return }
        isStopping = true
        let answeredId = answeredUserMessageId()
        let task = streamTask
        let api = app.api
        let id = conversationId
        Task {
            if let api {
                do {
                    try await api.stop(conversationId: id, messageId: answeredId)
                } catch {
                    // The local stream is cancelled regardless.
                }
            }
            task?.cancel()
            self.isStopping = false
        }
    }

    // MARK: - Tool approvals

    func decision(for approvalId: String) -> ApprovalDecision? {
        return approvalDecisions[approvalId]
    }

    /// Records a decision; once every pending approval in the message has one, sends them together.
    func decide(approvalId: String, approved: Bool, reason: String?, messageId: String) {
        guard canAnswerApprovals else { return }
        approvalDecisions[approvalId] = ApprovalDecision(approved: approved, reason: reason)
        guard let index = messages.firstIndex(where: { $0.id == messageId }) else { return }
        var message = messages[index]
        let pending = message.pendingApprovals
        guard !pending.isEmpty else { return }
        for tool in pending {
            guard let approval = tool.approval, approvalDecisions[approval.id] != nil else {
                return
            }
        }
        guard let api = app.api else { return }

        var answeredParts: [JSONValue] = []
        for partIndex in message.parts.indices {
            guard case .tool(var tool) = message.parts[partIndex],
                  tool.state == "approval-requested",
                  let approval = tool.approval,
                  let choice = approvalDecisions[approval.id]
            else {
                continue
            }
            let answer = ToolApproval(id: approval.id, approved: choice.approved, reason: choice.reason)
            tool.state = "approval-responded"
            tool.approval = answer
            message.parts[partIndex] = .tool(tool)

            var object: [String: JSONValue] = [
                "type": .string(tool.type),
                "toolCallId": .string(tool.toolCallId),
                "state": .string("approval-responded"),
                "approval": answer.toJSON(),
            ]
            if tool.isDynamic {
                object["toolName"] = .string(tool.toolName)
            }
            answeredParts.append(.object(object))
        }
        messages[index] = message
        inlineError = nil

        let body: JSONValue = .object([
            "conversationId": .string(conversationId),
            "message": .object([
                "id": .string(message.id),
                "role": .string("assistant"),
                "parts": .array(answeredParts),
            ]),
        ])
        startStream(api.streamChat(body: body), reducer: UIMessageStreamReducer(continuing: message), existingMessageId: message.id)
    }

    // MARK: - Streaming

    private func startStream(
        _ stream: AsyncThrowingStream<UIMessageChunk, Error>,
        reducer initialReducer: UIMessageStreamReducer,
        existingMessageId: String?
    ) {
        streamTask?.cancel()
        isStreaming = true
        streamingMessageId = existingMessageId
        streamTask = Task { [weak self] in
            var reducer = initialReducer
            var failure: Error? = nil
            do {
                for try await chunk in stream {
                    guard let self else { return }
                    let events = reducer.apply(chunk)
                    self.receive(reducer.message, events: events)
                }
            } catch {
                failure = error
            }
            guard let self else { return }
            await self.streamDidEnd(error: failure)
        }
    }

    private func receive(_ message: UIMessage, events: [StreamEvent]) {
        if isNew {
            // The server has accepted the first message, so the conversation now exists.
            isNew = false
        }
        if let currentId = streamingMessageId, let index = messages.firstIndex(where: { $0.id == currentId }) {
            messages[index] = message
        } else if let index = messages.firstIndex(where: { $0.id == message.id }) {
            messages[index] = message
        } else {
            messages.append(message)
        }
        streamingMessageId = message.id
        scrollToken += 1

        for event in events {
            switch event {
            case .title(let newTitle):
                title = newTitle
            case .notice(let notice):
                app.showBanner(notice)
            case .error(let errorText):
                inlineError = errorText
            case .started, .data, .finished, .aborted:
                break
            }
        }
    }

    private func streamDidEnd(error: Error?) async {
        isStreaming = false
        streamTask = nil
        streamingMessageId = nil

        if let error, !error.isCancellation, !error.isUnauthorized {
            if let apiError = error as? APIError, case .server(_, let message, let unsavedMessageId) = apiError {
                alertMessage = message
                if let unsavedMessageId, let index = messages.firstIndex(where: { $0.id == unsavedMessageId }) {
                    let removed = messages.remove(at: index)
                    if composerText.isEmpty {
                        composerText = removed.plainText
                    }
                }
            } else {
                inlineError = error.localizedDescription
            }
        }

        if !isNew {
            await load(showSpinner: false)
        }
        await app.refreshShell()
    }

    private func answeredUserMessageId() -> String? {
        if let currentId = streamingMessageId, let index = messages.firstIndex(where: { $0.id == currentId }) {
            return messages[..<index].last(where: { $0.role == .user })?.id
        }
        return messages.last(where: { $0.role == .user })?.id
    }

    // MARK: - Attachments

    func addAttachment(data: Data, filename: String, mediaType: String) {
        guard let api = app.api else { return }
        let attachment = ComposerAttachment(
            id: UUID(),
            filename: filename,
            mediaType: mediaType,
            progress: 0,
            uploaded: nil,
            errorText: nil,
            previewData: mediaType.lowercased().hasPrefix("image/") ? data : nil
        )
        attachments.append(attachment)
        let attachmentId = attachment.id
        Task {
            do {
                let file = try await api.upload(data: data, filename: filename, mimeType: mediaType) { fraction in
                    Task { @MainActor in
                        self.updateProgress(attachmentId, fraction: fraction)
                    }
                }
                self.finishUpload(attachmentId, file: file, errorText: nil)
            } catch {
                let message = error.isUnauthorized ? "Not signed in" : error.localizedDescription
                self.finishUpload(attachmentId, file: nil, errorText: message)
            }
        }
    }

    func importFile(at url: URL) {
        let scoped = url.startAccessingSecurityScopedResource()
        defer {
            if scoped {
                url.stopAccessingSecurityScopedResource()
            }
        }
        do {
            let data = try Data(contentsOf: url)
            let mediaType = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
            addAttachment(data: data, filename: url.lastPathComponent, mediaType: mediaType)
        } catch {
            app.showBanner("Couldn't read \(url.lastPathComponent): \(error.localizedDescription)", isError: true)
        }
    }

    func removeAttachment(id: UUID) {
        attachments.removeAll(where: { $0.id == id })
    }

    private func updateProgress(_ id: UUID, fraction: Double) {
        guard let index = attachments.firstIndex(where: { $0.id == id }) else { return }
        attachments[index].progress = fraction
    }

    private func finishUpload(_ id: UUID, file: UploadedFile?, errorText: String?) {
        guard let index = attachments.firstIndex(where: { $0.id == id }) else { return }
        attachments[index].uploaded = file
        attachments[index].errorText = errorText
        attachments[index].progress = 1
    }
}
