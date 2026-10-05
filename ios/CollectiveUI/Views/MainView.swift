import SwiftUI
import UIKit
import CollectiveKit

@MainActor
struct MainView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase

    @State private var columnVisibility: NavigationSplitViewVisibility = .automatic
    @State private var compactColumn: NavigationSplitViewColumn = .sidebar
    @State private var showCompose: Bool = false
    @State private var showInbox: Bool = false
    @State private var showSettings: Bool = false

    var body: some View {
        NavigationSplitView(columnVisibility: $columnVisibility, preferredCompactColumn: $compactColumn) {
            SidebarView(showCompose: $showCompose, showInbox: $showInbox, showSettings: $showSettings)
        } detail: {
            NavigationStack {
                ChatDetailView(route: model.selection)
            }
        }
        .navigationSplitViewStyle(.balanced)
        .onChange(of: model.selection) { _, newValue in
            if newValue != nil {
                compactColumn = .detail
            }
        }
        .sheet(isPresented: $showCompose) {
            NewChatSheet()
                .environment(model)
        }
        .sheet(isPresented: $showInbox) {
            InboxView()
                .environment(model)
        }
        .sheet(isPresented: $showSettings) {
            SettingsView()
                .environment(model)
        }
        .task {
            await model.refreshShell()
            #if DEBUG
            await applyDemoLaunchOptions()
            #endif
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                Task {
                    await model.refreshShell()
                }
            }
        }
    }

    #if DEBUG
    /// Applies `--demo-open`, `--demo-screen` and `--demo-sidebar-collapsed` once per launch.
    private func applyDemoLaunchOptions() async {
        guard DemoMode.isEnabled, !DemoRuntime.launchOptionsApplied else { return }
        DemoRuntime.launchOptionsApplied = true
        if DemoMode.sidebarCollapsed {
            columnVisibility = .detailOnly
        } else if UIDevice.current.userInterfaceIdiom == .pad {
            columnVisibility = .all
        }
        if let conversationId = DemoMode.openConversationId {
            model.openConversation(conversationId)
        }
        try? await Task.sleep(nanoseconds: 700_000_000)
        switch DemoMode.screen {
        case "inbox":
            showInbox = true
        case "settings":
            showSettings = true
        case "newchat":
            showCompose = true
        default:
            break
        }
    }
    #endif
}

/// Detail column content for the current route.
@MainActor
struct ChatDetailView: View {
    @Environment(AppModel.self) private var app
    let route: ChatRoute?

    var body: some View {
        switch route {
        case .some(.conversation(let conversationId)):
            ChatView(app: app, conversationId: conversationId, newChatTarget: nil)
                .id("conversation-" + conversationId)
        case .some(.newChat(let conversationId, let target)):
            ChatView(app: app, conversationId: conversationId, newChatTarget: target)
                .id("new-" + conversationId)
        case .some(.bot(let botId, let kind, let nonce)):
            BotChatOpener(botId: botId, kind: kind)
                .id("bot-" + botId + "-" + kind + "-" + nonce)
        case .none:
            ContentUnavailableView(
                "No chat selected",
                systemImage: "bubble.left.and.bubble.right",
                description: Text("Pick a bot or a chat, or start a new one.")
            )
        }
    }
}

/// Resolves a bot's home chat (or a new side chat) and then shows it.
@MainActor
struct BotChatOpener: View {
    @Environment(AppModel.self) private var app
    let botId: String
    let kind: String

    @State private var conversationId: String? = nil
    @State private var errorText: String? = nil

    var body: some View {
        Group {
            if let conversationId {
                ChatView(app: app, conversationId: conversationId, newChatTarget: nil)
            } else if let errorText {
                ContentUnavailableView {
                    Label("Couldn't open chat", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(errorText)
                } actions: {
                    Button("Try Again") {
                        self.errorText = nil
                        Task {
                            await open()
                        }
                    }
                }
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task {
            await openIfNeeded()
        }
    }

    private func openIfNeeded() async {
        if conversationId == nil && errorText == nil {
            await open()
        }
    }

    private func open() async {
        guard let api = app.api else { return }
        do {
            let chatKind = BotChatKind(rawValue: kind) ?? .home
            conversationId = try await api.openBotChat(botId: botId, kind: chatKind)
            if chatKind == .side {
                await app.refreshShell()
            }
        } catch {
            if !error.isUnauthorized && !error.isCancellation {
                errorText = error.localizedDescription
            }
        }
    }
}
