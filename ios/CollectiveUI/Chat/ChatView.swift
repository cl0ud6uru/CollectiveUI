import SwiftUI
import CollectiveKit

/// Scroll target placed after the last message.
private let chatBottomAnchor = "chat-bottom-anchor"

@MainActor
struct ChatView: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @Environment(\.scenePhase) private var scenePhase
    @State private var model: ChatModel
    @State private var scrollPolicy = ChatScrollPolicy()
    @State private var userIsScrolling = false
    @State private var distanceFromBottom: CGFloat = 0
    @State private var showHistory = false
    @State private var showDetails = false
    let onOpenSidebar: () -> Void

    init(app: AppModel, conversationId: String, newChatTarget: TargetOption?, onOpenSidebar: @escaping () -> Void = {}) {
        self.onOpenSidebar = onOpenSidebar
        _model = State(initialValue: ChatModel(app: app, conversationId: conversationId, newChatTarget: newChatTarget))
    }

    var body: some View {
        VStack(spacing: 0) {
            header
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("chat.header")
                .padding(.bottom, 8)
            messageList
            bottomBar
        }
        .background(PortalTheme.background)
        .sheet(isPresented: $showHistory) { history }
        .sheet(isPresented: $showDetails) { details }
        .task {
            await model.activate()
        }
        .task(id: model.conversationId) {
            while !Task.isCancelled {
                await model.refreshDelegatedApprovals()
                do { try await Task.sleep(for: .seconds(2)) } catch { break }
            }
        }
        .onDisappear {
            model.deactivate()
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background { model.deactivate() }
            else if phase == .active { Task { await model.activate() } }
        }
        .alert("Couldn't send message", item: $model.alertMessage) { _ in
            Button("OK", role: .cancel) {
                model.alertMessage = nil
            }
        } message: { message in
            Text(message)
        }
    }

    private var header: some View {
        ZStack(alignment: .top) {
            HStack(spacing: 8) {
                Button(action: onOpenSidebar) {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 20, weight: .medium)).frame(width: 44, height: 44)
                }
                .buttonStyle(.plain).modifier(ChatGlass(cornerRadius: 22))
                .accessibilityLabel("Open sidebar")
                .accessibilityActivationPoint(.center)
                if !model.usesBubbles || compactHeader {
                    if model.usesBubbles {
                        BotIdentityView(botId: model.target?.id, icon: model.assistantIcon, size: 32, activity: model.avatarActivity)
                    }
                    Text(model.target?.name ?? model.displayTitle)
                        .font(.subheadline.weight(.medium)).lineLimit(compactHeader ? 2 : 1)
                        .accessibilityLabel(model.assistantName + ", " + model.statusLabel)
                }
                Spacer(minLength: 4)
                if model.target?.kind == "bot" {
                    Menu {
                        Button { showHistory = true } label: { Label("Chat history", systemImage: "clock") }
                        Button { showDetails = true } label: { Label("Bot details", systemImage: "info.circle") }
                    } label: {
                        Image(systemName: "ellipsis").font(.system(size: 20, weight: .semibold))
                            .frame(width: 44, height: 44)
                    }
                    .buttonStyle(.plain).modifier(ChatGlass(cornerRadius: 22))
                    .accessibilityLabel("Chat options")
                }
            }
            .padding(.horizontal, 16)
            if model.usesBubbles && !compactHeader {
                VStack(spacing: -2) {
                    BotIdentityView(botId: model.target?.id, icon: model.assistantIcon, size: 48, activity: model.avatarActivity)
                        .zIndex(1)
                    Button { showDetails = true } label: {
                        VStack(spacing: 2) {
                            HStack(spacing: 4) {
                                Text(model.assistantName).font(.subheadline.weight(.semibold)).lineLimit(1)
                                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(PortalTheme.muted)
                            }
                            Text(model.statusLabel).font(.caption).foregroundStyle(statusColor).lineLimit(1)
                        }
                        .padding(.horizontal, 14).padding(.vertical, 6)
                        .frame(minHeight: 44)
                        .modifier(ChatGlass(cornerRadius: 24))
                    }
                    .buttonStyle(.plain).accessibilityLabel("Bot details")
                    .accessibilityValue(model.assistantName + ", " + model.statusLabel)
                }
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 76)
                .padding(.bottom, 4)
            }
        }
        .foregroundStyle(PortalTheme.ink)
        .padding(.top, 2)
    }

    private var compactHeader: Bool {
        dynamicTypeSize.isAccessibilitySize || verticalSizeClass == .compact
    }

    private var statusColor: Color {
        switch model.avatarActivity {
        case .working: return PortalTheme.working
        case .approval: return PortalTheme.warning
        case .attention, .unavailable: return PortalTheme.danger
        case .idle: return PortalTheme.muted
        }
    }

    private var history: some View {
        NavigationStack {
            List {
                let chats = model.app.chatConversations.filter { $0.botId == model.target?.id }
                if chats.isEmpty { Text("No side chats yet").foregroundStyle(PortalTheme.muted) }
                ForEach(chats) { chat in
                    Button {
                        showHistory = false
                        model.app.openConversation(chat.id)
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(chat.title.isEmpty ? "Untitled chat" : chat.title)
                            if let date = chat.updatedAt { Text(date, style: .date).font(.caption).foregroundStyle(PortalTheme.muted) }
                        }.padding(.vertical, 4)
                    }
                }
            }
            .scrollContentBackground(.hidden).background(PortalTheme.background)
            .navigationTitle("Chat history").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showHistory = false } } }
        }
    }

    private var details: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    BotIdentityView(botId: model.target?.id, icon: model.assistantIcon, size: 84)
                    Text(model.assistantName).font(.title2.weight(.semibold))
                    if let detail = model.target?.detail { Text(detail).foregroundStyle(PortalTheme.muted) }
                }
                .multilineTextAlignment(.center).frame(maxWidth: .infinity).padding(24)
            }
            .background(PortalTheme.background)
            .navigationTitle("Bot details").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showDetails = false } } }
        }
    }

    private var messageList: some View {
        GeometryReader { viewport in
            ScrollViewReader { proxy in
                ScrollView {
                    transcript(width: max(0, min(800, viewport.size.width - 32)))
                        .frame(width: viewport.size.width)
                }
                .accessibilityIdentifier("chat.transcript")
                .scrollDismissesKeyboard(.interactively)
                .onScrollGeometryChange(for: CGFloat.self) { geometry in
                    max(0, geometry.contentSize.height - geometry.visibleRect.maxY)
                } action: { _, distance in
                    distanceFromBottom = distance
                    scrollPolicy.observe(distanceFromBottom: Double(distance), userIsScrolling: userIsScrolling)
                }
                .onScrollPhaseChange { _, phase in
                    switch phase {
                    case .tracking, .interacting, .decelerating: userIsScrolling = true
                    default: userIsScrolling = false
                    }
                    scrollPolicy.observe(distanceFromBottom: Double(distanceFromBottom), userIsScrolling: userIsScrolling)
                }
                .overlay(alignment: .bottomTrailing) {
                    if !scrollPolicy.followsLatest && !model.messages.isEmpty {
                        Button {
                            userIsScrolling = false
                            scrollPolicy.jumpToLatest()
                            proxy.scrollTo(chatBottomAnchor, anchor: .bottom)
                        } label: {
                            Image(systemName: "chevron.down").font(.system(size: 18, weight: .semibold))
                                .frame(width: 44, height: 44)
                        }
                        .buttonStyle(.plain).modifier(ChatGlass(cornerRadius: 22))
                        .accessibilityLabel("Scroll to latest message")
                        .accessibilityIdentifier("chat.latest")
                        .padding(.trailing, 16).padding(.bottom, 6)
                    }
                }
                .onChange(of: model.scrollToken) { _, _ in
                    if !userIsScrolling && scrollPolicy.shouldScroll(for: model.scrollReason) {
                        proxy.scrollTo(chatBottomAnchor, anchor: .bottom)
                    }
                }
                .onChange(of: viewport.size) { _, _ in
                    if !userIsScrolling && scrollPolicy.shouldScroll(for: .layout) {
                        proxy.scrollTo(chatBottomAnchor, anchor: .bottom)
                    }
                }
                .onAppear { proxy.scrollTo(chatBottomAnchor, anchor: .bottom) }
            }
        }
    }

    private func transcript(width: CGFloat) -> some View {
            let latestMessageId = model.messages.last?.id
            return VStack(alignment: .leading, spacing: model.usesBubbles ? 12 : 24) {
                if model.isLoading {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .padding(.top, 48)
                } else if let loadError = model.loadError {
                    ContentUnavailableView {
                        Label("Couldn't load this chat", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(loadError)
                    } actions: {
                        Button("Retry loading chat") { Task { await model.load(showSpinner: true) } }
                            .buttonStyle(.bordered).frame(minHeight: 44)
                    }
                } else if model.messages.isEmpty && !model.isStreaming {
                    EmptyChatView(model: model)
                }

                // Measure every row: changing lazy estimates above the growing reply
                // can move the reader even while automatic following is paused.
                ForEach(model.delegatedApprovals) { request in
                    VStack(alignment: .leading, spacing: 10) {
                        Text("\(request.botName) needs your approval").font(.headline)
                        Text("Assigned by \(request.assignerName) · Only you can approve this action.").font(.caption).foregroundStyle(.secondary)
                        if let tool = request.tool {
                            Text(TextUtilities.toolDisplayName(tool.toolName)).font(.subheadline)
                            ScrollView { Text(tool.input?.prettyPrinted() ?? "").font(.system(.caption, design: .monospaced)).textSelection(.enabled) }.frame(maxHeight: 240)
                        }
                        ViewThatFits {
                            HStack { delegateButtons(request) }
                            VStack { delegateButtons(request) }
                        }
                        .disabled(model.answeringDelegate || request.expiresAt <= Date())
                        Text("Expires \(request.expiresAt.formatted(date: .omitted, time: .shortened))").font(.caption).foregroundStyle(.secondary)
                    }
                    .padding(12).background(PortalTheme.surface, in: RoundedRectangle(cornerRadius: 12))
                }
                if let error = model.delegateApprovalError { Text(error).font(.caption).foregroundStyle(PortalTheme.danger) }
                ForEach(model.messages) { message in
                    MessageView(message: message, model: model,
                        marksLatestParagraph: message.role == .assistant && message.id == latestMessageId)
                        .id(message.id)
                }

                if model.showsTypingIndicator {
                    TypingIndicator()
                }

                if let result = model.commandResult {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(result.title).font(.subheadline.weight(.semibold))
                        ForEach(result.lines.enumerated(), id: \.offset) { line in Text(line.element).font(.subheadline) }
                    }
                    .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                    .padding(14).background(PortalTheme.botBubble, in: RoundedRectangle(cornerRadius: 18))
                }
                if let error = model.commandError { InlineErrorView(text: error) }
                if model.isExecutingCommand { ProgressView("Running command…").font(.footnote) }
                if let inlineError = model.inlineError {
                    InlineErrorView(text: inlineError)
                }
                if model.needsMessageStatusCheck && !model.isStreaming {
                    if model.isCheckingMessageStatus {
                        ProgressView("Checking message status…").font(.footnote)
                    } else {
                        Button("Check message status") { Task { await model.checkMessageStatus() } }
                            .buttonStyle(.bordered).frame(minHeight: 44)
                    }
                    if model.canRetryOriginalMessage {
                        Button("Retry original message") { model.retryOriginalMessage() }
                            .buttonStyle(.bordered).frame(minHeight: 44)
                            .accessibilityHint("Retries the saved request without creating a duplicate message.")
                    }
                }
                if model.hasDetachedReply && !model.needsMessageStatusCheck {
                    Text("The reply is still running on the server.").font(.footnote)
                    Button("Reconnect to reply") { model.resume() }
                        .buttonStyle(.bordered).frame(minHeight: 44)
                }

                Color.clear
                    .frame(height: 1)
                    .id(chatBottomAnchor)
            }
            .frame(width: width)
            .padding(.horizontal, 16)
            .padding(.bottom, 12)
            .padding(.top, 12)
    }

    @ViewBuilder
    private func delegateButtons(_ request: DelegatedApproval) -> some View {
        Button(request.tool?.toolName == "workspace_bash" ? "Run" : "Allow once") { Task { await model.answerDelegate(request, approved: true) } }.buttonStyle(.borderedProminent)
        Button("Deny", role: .destructive) { Task { await model.answerDelegate(request, approved: false) } }.buttonStyle(.bordered)
        Button("Stop task", role: .destructive) { Task { await model.stopDelegate(request) } }.buttonStyle(.bordered)
    }

    @ViewBuilder
    private var bottomBar: some View {
        if model.target?.hermesTeam == true {
            VStack(spacing: 8) {
                NoticeBar(text: model.unavailableReason ?? "Open this Team Bot in the web app.", systemImage: "globe")
                if let baseURL = model.app.serverURL, let botId = model.target?.id {
                    Link("Open Team Bot on the web", destination: baseURL.appendingPathComponent("bots").appendingPathComponent(botId))
                        .font(.callout).padding(.bottom, 12)
                }
            }
        } else if model.isReadOnly {
            NoticeBar(text: "Delegated task — read only", systemImage: "lock")
        } else if model.isUnavailable {
            NoticeBar(text: model.unavailableReason ?? "This chat can't continue.", systemImage: "exclamationmark.circle")
        } else {
            ComposerView(model: model)
        }
    }
}

@MainActor
struct EmptyChatView: View {
    let model: ChatModel

    var body: some View {
        VStack(spacing: 14) {
            if !model.usesBubbles {
                AvatarView(icon: model.assistantIcon, size: 48)
                Text(model.target?.name ?? "New chat")
                    .font(.title2.weight(.semibold)).multilineTextAlignment(.center)
            }
            if let detail = model.target?.detail, !detail.isEmpty {
                Text(detail)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            if let starters = model.target?.starters, !starters.isEmpty, !model.isReadOnly, !model.isUnavailable {
                VStack(spacing: 8) {
                    ForEach(starters, id: \.self) { starter in
                        Button {
                            model.sendStarter(starter)
                        } label: {
                            Text(starter)
                                .font(.callout)
                                .multilineTextAlignment(.leading)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 14)
                                .padding(.vertical, 10)
                                .background(
                                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                                        .fill(PortalTheme.surfaceSecondary)
                                )
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.top, 8)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, model.usesBubbles ? 12 : 40)
        .padding(.horizontal, 8)
    }
}

@MainActor
struct NoticeBar: View {
    let text: String
    let systemImage: String

    var body: some View {
        Label(text, systemImage: systemImage)
            .font(.footnote)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .padding(.horizontal, 16)
            .background(.bar)
    }
}

@MainActor
struct InlineErrorView: View {
    let text: String

    var body: some View {
        Label(text, systemImage: "exclamationmark.octagon")
            .font(.footnote)
            .foregroundStyle(Color.red)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(10)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Color.red.opacity(0.08))
            )
    }
}

@MainActor
struct TypingIndicator: View {
    @State private var phase: Bool = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 5) {
            ForEach(0..<3, id: \.self) { index in
                Circle()
                    .fill(Color.secondary)
                    .frame(width: 7, height: 7)
                    .opacity(phase ? 1.0 : 0.3)
                    .animation(
                        .easeInOut(duration: 0.6).repeatForever().delay(Double(index) * 0.2),
                        value: phase
                    )
            }
        }
        .padding(.vertical, 6)
        .onAppear {
            phase = !reduceMotion
        }
        .accessibilityLabel("Working")
    }
}
