import Foundation
import Observation
import UniformTypeIdentifiers
import CollectiveKit

struct ApprovalDecision: Hashable {
    var approved: Bool
    var reason: String?
}

struct ComposerAttachment: Identifiable, Hashable, Codable {
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
    var isBotHome: Bool = false
    var isUnavailable: Bool = false
    var unavailableReason: String? = nil

    var messages: [UIMessage] = []
    var delegatedApprovals: [DelegatedApproval] = []
    var answeringDelegate = false
    var delegateApprovalError: String?

    func refreshDelegatedApprovals() async {
        guard !isNew, let api = app.api else { return }
        do { delegatedApprovals = try await api.delegatedApprovals(conversationId: conversationId) }
        catch { delegatedApprovals = [] }
        if isReadOnly && !isStreaming { await load(showSpinner: false) }
    }

    func answerDelegate(_ request: DelegatedApproval, approved: Bool) async {
        guard !answeringDelegate, request.expiresAt > Date(), let api = app.api else { return }
        answeringDelegate = true
        delegateApprovalError = nil
        defer { answeringDelegate = false }
        do { try await api.answerDelegatedApproval(conversationId: conversationId, request: request, approved: approved) }
        catch { delegateApprovalError = error.localizedDescription }
        await refreshDelegatedApprovals()
    }

    func stopDelegate(_ request: DelegatedApproval) async {
        guard !answeringDelegate, let api = app.api else { return }
        answeringDelegate = true
        defer { answeringDelegate = false }
        do { try await api.stop(conversationId: request.conversationId, messageId: nil) }
        catch { delegateApprovalError = error.localizedDescription }
        await refreshDelegatedApprovals()
    }
    var isLoading: Bool = false
    var loadError: String? = nil
    var isStreaming: Bool = false
    var isStopping: Bool = false
    var inlineError: String? = nil
    var alertMessage: String? = nil

    var commandResult: ChatCommandResult?
    var commandCatalog: ChatCommandCatalog?
    var commandError: String?
    var isExecutingCommand = false
    var skills: [ChatSkill] = []
    @ObservationIgnored private var commandRevision = 0
    @ObservationIgnored private var commandAttempt: (text: String, nextId: String)?
    @ObservationIgnored private var commandTask: Task<Void, Never>?

    var commands: [ComposerCommand] {
        guard !isReadOnly && !isUnavailable else { return [] }
        return ComposerCommands.options(target: target, skills: skills, catalog: commandCatalog)
    }

    let conversationState: ConversationState
    var composerText: String {
        get { conversationState.text }
        set { conversationState.text = newValue }
    }
    var attachments: [ComposerAttachment] {
        get { conversationState.attachments }
        set { conversationState.attachments = newValue }
    }
    var approvalDecisions: [String: ApprovalDecision] = [:]
    var needsMessageStatusCheck = false
    @ObservationIgnored private var pendingDraft: (messageId: String, text: String, attachments: [ComposerAttachment])?
    @ObservationIgnored private var submittedApproval = false

    /// Bumped whenever the view should scroll to the bottom.
    var scrollToken: Int = 0
    private(set) var scrollReason: ChatScrollReason = .initial

    @ObservationIgnored private var streamTask: Task<Void, Never>? = nil
    @ObservationIgnored private var streamingMessageId: String? = nil
    @ObservationIgnored private var autoResumeBudget: Int = 2
    @ObservationIgnored private var isActive: Bool = false
    @ObservationIgnored private var hasLoaded: Bool = false
    @ObservationIgnored private var streamGeneration = UUID()
    @ObservationIgnored private var stopRequestedFor: String?

    init(app: AppModel, conversationId: String, newChatTarget: TargetOption?) {
        self.app = app
        self.conversationId = conversationId
        self.conversationState = app.conversationStates.state(for: conversationId)
        self.newChatTarget = newChatTarget
        self.isNew = newChatTarget != nil
        self.target = newChatTarget
        self.isUnavailable = newChatTarget?.hermesTeam == true
        if newChatTarget?.hermesTeam == true {
            self.unavailableReason = "Hermes Team Bots are available in the web app. Use it for private chat, Admin mode and reviewing team updates."
        }
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

    var usesBubbles: Bool { target?.kind == "bot" || isGroup }

    var avatarActivity: BotActivity {
        if isUnavailable { return .unavailable }
        if messages.contains(where: { !$0.pendingApprovals.isEmpty }) { return .approval }
        if isStreaming { return .working }
        if inlineError != nil { return .attention }
        return .idle
    }

    var statusLabel: String {
        switch avatarActivity {
        case .working: return "Working…"
        case .approval: return "Waiting for your approval"
        case .attention: return "Needs attention"
        case .unavailable: return "Unavailable"
        case .idle: return target?.label ?? "Ready"
        }
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
        return !needsMessageStatusCheck && !isStreaming && !isExecutingCommand && !isLoading && loadError == nil && target != nil && !isReadOnly && !isUnavailable && !isUploading && hasComposerContent
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
        return !needsMessageStatusCheck && !isStreaming && !isReadOnly && !isUnavailable
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
        await loadCommandCatalog()
        #if DEBUG
        await runDemoSendIfNeeded()
        #endif
    }

    #if DEBUG
    /// `--demo-send "<text>"`: types and sends a message in the chat opened with `--demo-open`.
    private func runDemoSendIfNeeded() async {
        guard DemoMode.isEnabled,
              app.isDemoSession,
              let text = DemoMode.sendText,
              DemoMode.openConversationId == conversationId,
              !DemoRuntime.sendConsumed
        else {
            return
        }
        DemoRuntime.sendConsumed = true
        try? await Task.sleep(nanoseconds: 1_000_000_000)
        for character in text {
            if Task.isCancelled {
                return
            }
            composerText.append(character)
            try? await Task.sleep(nanoseconds: 35_000_000)
        }
        try? await Task.sleep(nanoseconds: 400_000_000)
        send()
    }
    #endif

    func deactivate() {
        isActive = false
        conversationState.flush()
        commandTask?.cancel()
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
            if snapshot.resume && !conversationState.preventsResume(in: messages) && isActive && !isStreaming && autoResumeBudget > 0 {
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
            isBotHome = summary.isBotHome
        }
        if let snapshotTarget = snapshot.target {
            target = snapshotTarget
        }
        skills = snapshot.skills
        isUnavailable = snapshot.unavailable || target?.hermesTeam == true
        unavailableReason = target?.hermesTeam == true
            ? "Hermes Team Bots are available in the web app. Use it for private chat, Admin mode and reviewing team updates."
            : snapshot.unavailableReason
        guard !isStreaming else { return }
        let isFirstTranscript = messages.isEmpty
        messages = conversationState.reconcileStoppedReplies(in: snapshot.displayedThread())
        // Decisions are transient UI state; the server snapshot owns approval status.
        approvalDecisions = [:]
        requestScroll(isFirstTranscript ? .initial : .content)
    }

    private func loadCommandCatalog() async {
        guard target?.hermes == true, let api = app.api else { return }
        do {
            var query = [URLQueryItem(name: "conversationId", value: conversationId)]
            if let target { query.append(URLQueryItem(name: target.kind == "bot" ? "botId" : "appId", value: target.id)) }
            let catalog = try await api.get("/api/chat/commands", query: query, as: ChatCommandCatalog.self)
            guard !Task.isCancelled else { return }
            commandCatalog = catalog
            commandRevision = max(commandRevision, catalog.revision ?? 0)
        } catch { /* Basic controls remain available if optional discovery fails. */ }
    }

    private func executeCommand(_ text: String) async {
        defer { isExecutingCommand = false; commandTask = nil }
        guard let api = app.api, let target else { return }
        if commandAttempt?.text != text { commandAttempt = (text, IDGenerator.make()) }
        let originalDraft = composerText
        var body: [String: JSONValue] = [
            "conversationId": .string(conversationId), "text": .string(text),
            "revision": .number(Double(commandRevision)),
            "newConversationId": .string(commandAttempt?.nextId ?? IDGenerator.make()),
            target.kind == "bot" ? "botId" : "appId": .string(target.id),
        ]
        if let id = messages.last?.id { body["messageId"] = .string(id) }
        commandError = nil
        do {
            let result = try await api.send("/api/chat/commands", method: "POST", body: .object(body), as: ChatCommandResult.self)
            guard !Task.isCancelled else { return }
            commandResult = result
            commandRevision = max(commandRevision, result.revision ?? 0)
            commandAttempt = nil
            if composerText == originalDraft { composerText = "" }
            if result.conversationId != nil { isNew = false }
            if let destination = result.destinationConversationId {
                app.openConversation(destination)
            } else if result.refresh == true {
                streamTask?.cancel()
                await load(showSpinner: false)
            }
            await app.refreshShell()
            await loadCommandCatalog()
        } catch {
            if !error.isCancellation && !error.isUnauthorized {
                commandError = "\(error.localizedDescription) Your draft has been kept; you can retry."
            }
            await loadCommandCatalog()
        }
    }

    // MARK: - Sending

    func send() {
        guard canSend, let api = app.api else { return }
        let draft = composerText.trimmingCharacters(in: .whitespacesAndNewlines)
        if ComposerCommands.isControl(draft, target: target) {
            guard attachments.isEmpty else {
                commandError = "Remove attachments before running a command. Your draft and files have been kept."
                return
            }
            isExecutingCommand = true
            commandTask = Task { await executeCommand(draft) }
            return
        }
        let text = ComposerCommands.messageText(draft, target: target)
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
        if draft.hasPrefix("//"), target?.kind == "bot" || target?.hermes == true {
            body["literalSlash"] = .bool(true)
        }
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

        pendingDraft = (message.id, composerText, attachments)
        messages.append(message)
        composerText = ""
        attachments = []
        inlineError = nil
        autoResumeBudget = 2
        requestScroll(.sent)

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
        conversationState.stoppedReplies.removeAll { $0.parentId == userMessageId }
        messages.removeSubrange((userIndex + 1)...)
        inlineError = nil
        autoResumeBudget = 2
        requestScroll(.sent)
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
        stopRequestedFor = answeredId
        let task = streamTask
        let generation = streamGeneration
        let api = app.api
        let id = conversationId
        Task {
            if let api {
                do {
                    try await api.stop(conversationId: id, messageId: answeredId)
                    guard generation == self.streamGeneration else { return }
                    if self.isStreaming, let answeredId {
                        self.markStopped(parentId: answeredId)
                    }
                    self.isNew = false
                    if self.pendingDraft?.messageId == answeredId { self.pendingDraft = nil }
                } catch {
                    guard generation == self.streamGeneration else { return }
                    if !error.isUnauthorized {
                        self.inlineError = "Couldn't confirm that the server stopped the reply. Reopen this chat to check its status."
                    }
                }
            }
            guard generation == self.streamGeneration else { return }
            task?.cancel()
            self.isStopping = false
            self.stopRequestedFor = nil
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
        submittedApproval = true
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
        let generation = UUID()
        streamGeneration = generation
        stopRequestedFor = nil
        isStopping = false
        isStreaming = true
        app.liveActivities.observe(conversationId: conversationId, replace: true)
        streamingMessageId = existingMessageId
        streamTask = Task { [weak self] in
            var reducer = initialReducer
            var failure: Error? = nil
            do {
                for try await chunk in stream {
                    guard let self, self.streamGeneration == generation else { return }
                    let events = reducer.apply(chunk)
                    self.receive(reducer.message, events: events)
                }
            } catch {
                failure = error
            }
            guard let self, self.streamGeneration == generation else { return }
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
        requestScroll(.content)

        for event in events {
            switch event {
            case .title(let newTitle):
                title = newTitle
            case .notice(let notice):
                app.showBanner(notice)
            case .error(let errorText):
                inlineError = errorText
            case .started:
                app.liveActivities.observe(conversationId: conversationId, replace: true)
            case .aborted:
                // An abort is a terminal stream event, never the normal finishReason "stop".
                if let parentId = stopRequestedFor { markStopped(parentId: parentId) }
            case .data, .finished:
                break
            }
        }
    }

    private func requestScroll(_ reason: ChatScrollReason) {
        scrollReason = reason
        scrollToken += 1
    }

    private func markStopped(parentId: String) {
        let id = streamingMessageId ?? "stopped-" + IDGenerator.make()
        conversationState.markStopped(messageId: id, parentId: parentId)
        messages = conversationState.reconcileStoppedReplies(in: messages)
    }

    private func streamDidEnd(error: Error?) async {
        isStreaming = false
        streamTask = nil
        streamingMessageId = nil

        if let error, !error.isCancellation, !error.isUnauthorized {
            inlineError = error.localizedDescription
            if let apiError = error as? APIError,
               case .server(_, _, let unsavedMessageId) = apiError,
               unsavedMessageId == pendingDraft?.messageId, unsavedMessageId != nil {
                restorePendingDraft()
            } else if pendingDraft != nil || submittedApproval {
                // A dropped connection does not prove rejection. Read persisted state before retrying.
                await checkMessageStatus()
            }
        } else if error == nil {
            pendingDraft = nil
            submittedApproval = false
        }

        if !isNew && !needsMessageStatusCheck { await load(showSpinner: false) }
        await app.refreshShell()
    }

    func checkMessageStatus() async {
        guard let api = app.api else { return }
        needsMessageStatusCheck = true
        do {
            let snapshot = try await api.snapshot(conversationId: conversationId)
            let pendingId = pendingDraft?.messageId
            isNew = false
            apply(snapshot)
            if let pendingId, !snapshot.initialRows.contains(where: { $0.id == pendingId }) {
                restorePendingDraft()
            } else { pendingDraft = nil }
            submittedApproval = false
            needsMessageStatusCheck = false
            if snapshot.resume && !conversationState.preventsResume(in: messages) && isActive { resume() }
        } catch {
            if isNew, (error as? APIError)?.statusCode == 404, pendingDraft != nil {
                restorePendingDraft()
                needsMessageStatusCheck = false
            } else {
                inlineError = "Couldn't confirm the message status. Check again before sending another message."
            }
        }
    }

    private func restorePendingDraft() {
        guard let pending = pendingDraft else { return }
        messages.removeAll { $0.id == pending.messageId }
        // Preserve anything the user typed while the request was in flight.
        composerText = composerText.isEmpty ? pending.text : pending.text + "\n\n" + composerText
        attachments = pending.attachments + attachments
        pendingDraft = nil
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
