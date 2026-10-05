import SwiftUI
import CollectiveKit

/// Scroll target placed after the last message.
private let chatBottomAnchor = "chat-bottom-anchor"

@MainActor
struct ChatView: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @State private var model: ChatModel
    @State private var headerHeight: CGFloat = 90
    @State private var scrollTarget: String? = chatBottomAnchor
    @State private var showHistory = false
    @State private var showDetails = false
    let onOpenSidebar: () -> Void

    init(app: AppModel, conversationId: String, newChatTarget: TargetOption?, onOpenSidebar: @escaping () -> Void = {}) {
        self.onOpenSidebar = onOpenSidebar
        _model = State(initialValue: ChatModel(app: app, conversationId: conversationId, newChatTarget: newChatTarget))
    }

    var body: some View {
        VStack(spacing: 0) {
            ZStack(alignment: .top) {
                messageList
                    // Fade continuously behind the floating portrait header.
                    // Compact layouts reserve its space, preserving readable lines.
                    .mask(alignment: .top) {
                        VStack(spacing: 0) {
                            LinearGradient(
                                stops: [.init(color: .clear, location: 0),
                                        .init(color: .black.opacity(0.25), location: 0.35),
                                        .init(color: .black, location: 1)],
                                startPoint: .top, endPoint: .bottom
                            ).frame(height: compactHeader ? 0 : headerHeight + 16)
                            Rectangle()
                        }
                    }
                    .padding(.top, compactHeader ? headerHeight : 0)
                header
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height in
                        if height > 0 && abs(headerHeight - height) > 1 { headerHeight = height }
                    }
            }
            bottomBar
        }
        .background(PortalTheme.background)
        .sheet(isPresented: $showHistory) { history }
        .sheet(isPresented: $showDetails) { details }
        .task {
            await model.activate()
        }
        .onDisappear {
            model.deactivate()
        }
        .alert("Couldn't send message", isPresented: alertBinding) {
            Button("OK", role: .cancel) {
                model.alertMessage = nil
            }
        } message: {
            Text(model.alertMessage ?? "")
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
                        .font(.subheadline.weight(.medium)).lineLimit(1)
                        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
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

    private var alertBinding: Binding<Bool> {
        Binding(
            get: { model.alertMessage != nil },
            set: { presented in
                if !presented {
                    model.alertMessage = nil
                }
            }
        )
    }

    private var messageList: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: model.usesBubbles ? 12 : 24) {
                if model.isLoading {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .padding(.top, 48)
                } else if let loadError = model.loadError {
                    ContentUnavailableView(
                        "Couldn't load this chat",
                        systemImage: "exclamationmark.triangle",
                        description: Text(loadError)
                    )
                } else if model.messages.isEmpty && !model.isStreaming {
                    EmptyChatView(model: model)
                }

                ForEach(model.messages) { message in
                    MessageView(message: message, model: model)
                        .id(message.id)
                }

                if model.showsTypingIndicator {
                    TypingIndicator()
                }

                if let result = model.commandResult {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(result.title).font(.subheadline.weight(.semibold))
                        ForEach(Array(result.lines.enumerated()), id: \.offset) { line in Text(line.element).font(.subheadline) }
                    }
                    .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                    .padding(14).background(PortalTheme.botBubble, in: RoundedRectangle(cornerRadius: 18))
                }
                if let error = model.commandError { InlineErrorView(text: error) }
                if model.isExecutingCommand { ProgressView("Running command…").font(.footnote) }
                if let inlineError = model.inlineError {
                    InlineErrorView(text: inlineError)
                }
                if model.needsMessageStatusCheck {
                    Button("Check message status") { Task { await model.checkMessageStatus() } }
                        .buttonStyle(.bordered).frame(minHeight: 44)
                }

                Color.clear
                    .frame(height: 1)
                    .id(chatBottomAnchor)
            }
            .scrollTargetLayout()
            .frame(maxWidth: 800)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 16)
            .padding(.bottom, compactHeader ? 0 : 12)
            .padding(.top, compactHeader ? 8 : headerHeight + 20)
        }
        // Keep the newest content reachable when the keyboard, draft height,
        // or device orientation changes the available transcript space.
        .defaultScrollAnchor(.bottom)
        .scrollPosition(id: $scrollTarget, anchor: .bottom)
        .scrollDismissesKeyboard(.interactively)
        .overlay(alignment: .bottomTrailing) {
            if scrollTarget != chatBottomAnchor && !model.messages.isEmpty {
                Button { scrollTarget = chatBottomAnchor } label: {
                    Image(systemName: "chevron.down").font(.system(size: 18, weight: .semibold))
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.plain).modifier(ChatGlass(cornerRadius: 22))
                .accessibilityLabel("Scroll to latest message")
                .padding(.trailing, 16).padding(.bottom, 6)
            }
        }
        .onChange(of: model.scrollToken) { _, _ in
            scrollTarget = chatBottomAnchor
        }
        .onAppear {
            scrollTarget = chatBottomAnchor
        }
    }

    @ViewBuilder
    private var bottomBar: some View {
        if model.isReadOnly {
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
