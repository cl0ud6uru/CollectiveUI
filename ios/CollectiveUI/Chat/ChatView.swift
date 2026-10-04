import SwiftUI
import CollectiveKit

/// Scroll target placed after the last message.
private let chatBottomAnchor = "chat-bottom-anchor"

@MainActor
struct ChatView: View {
    @State private var model: ChatModel

    init(app: AppModel, conversationId: String, newChatTarget: TargetOption?) {
        _model = State(initialValue: ChatModel(app: app, conversationId: conversationId, newChatTarget: newChatTarget))
    }

    var body: some View {
        VStack(spacing: 0) {
            messageList
            bottomBar
        }
        .navigationTitle(model.displayTitle)
        .navigationBarTitleDisplayMode(.inline)
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
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
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

                    if let inlineError = model.inlineError {
                        InlineErrorView(text: inlineError)
                    }

                    Color.clear
                        .frame(height: 1)
                        .id(chatBottomAnchor)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: model.scrollToken) { _, _ in
                proxy.scrollTo(chatBottomAnchor, anchor: .bottom)
            }
            .onAppear {
                proxy.scrollTo(chatBottomAnchor, anchor: .bottom)
            }
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
            AvatarView(icon: model.assistantIcon, size: 64)
            Text(model.target?.name ?? "New chat")
                .font(.title2.weight(.semibold))
                .multilineTextAlignment(.center)
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
                                        .fill(Color(uiColor: .secondarySystemBackground))
                                )
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.top, 8)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 40)
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
            phase = true
        }
        .accessibilityLabel("Working")
    }
}
