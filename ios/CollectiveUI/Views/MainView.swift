import SwiftUI
import UIKit
import CollectiveKit

@MainActor
struct MainView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var columnVisibility: NavigationSplitViewVisibility = .all
    @State private var sidebarOpen = false
    @State private var showCompose = false
    @State private var showInbox = false
    @State private var showSettings = false

    var body: some View {
        Group {
            if sizeClass == .regular {
                NavigationSplitView(columnVisibility: $columnVisibility) {
                    sidebar
                        .toolbar(.hidden, for: .navigationBar)
                } detail: {
                    detail
                        .toolbar(.hidden, for: .navigationBar)
                }
                .navigationSplitViewStyle(.balanced)
            } else {
                GeometryReader { geometry in
                    ZStack(alignment: .leading) {
                        detail
                            .accessibilityHidden(sidebarOpen)
                        if sidebarOpen {
                            Color.black.opacity(0.36)
                                .ignoresSafeArea()
                                .onTapGesture { closeSidebar() }
                                .accessibilityLabel("Close navigation")
                                .accessibilityAddTraits(.isButton)
                            sidebar
                                .frame(width: min(260, max(220, geometry.size.width - 52)))
                                .background(PortalTheme.sidebar.ignoresSafeArea())
                                .transition(.move(edge: .leading))
                                .accessibilityAddTraits(.isModal)
                        }
                    }
                }
            }
        }
        .background(PortalTheme.background)
        .onChange(of: model.selection) { _, _ in
            if sizeClass != .regular { closeSidebar() }
        }
        .sheet(isPresented: $showCompose) { NewChatSheet().environment(model) }
        .sheet(isPresented: $showInbox) { InboxView().environment(model) }
        .sheet(isPresented: $showSettings) { SettingsView().environment(model) }
        .task {
            await model.refreshShell()
            #if DEBUG
            await applyDemoLaunchOptions()
            #endif
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await model.refreshShell() } }
        }
    }

    private var sidebar: some View {
        SidebarView(showCompose: $showCompose, showInbox: $showInbox,
                    showSettings: $showSettings, onClose: {
                        if sizeClass != .regular { closeSidebar() }
                    }, onCollapse: closeSidebar)
    }

    private var detail: some View {
        ChatDetailView(route: model.selection, onOpenSidebar: openSidebar, onCompose: { showCompose = true })
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(PortalTheme.background)
    }

    private func openSidebar() {
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.2)) {
            if sizeClass == .regular { columnVisibility = .all }
            else { sidebarOpen = true }
        }
    }

    private func closeSidebar() {
        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.2)) {
            if sizeClass == .regular { columnVisibility = .detailOnly }
            else { sidebarOpen = false }
        }
    }

    #if DEBUG
    private func applyDemoLaunchOptions() async {
        guard DemoMode.isEnabled, !DemoRuntime.launchOptionsApplied else { return }
        DemoRuntime.launchOptionsApplied = true
        if DemoMode.sidebarCollapsed { columnVisibility = .detailOnly }
        if let id = DemoMode.openConversationId { model.openConversation(id) }
        else if DemoMode.screen == nil || DemoMode.screen == "search" { sidebarOpen = true }
        try? await Task.sleep(nanoseconds: 700_000_000)
        switch DemoMode.screen {
        case "inbox": showInbox = true
        case "settings": showSettings = true
        case "newchat": showCompose = true
        default: break
        }
    }
    #endif
}

@MainActor
struct ChatDetailView: View {
    @Environment(AppModel.self) private var app
    let route: ChatRoute?
    let onOpenSidebar: () -> Void
    let onCompose: () -> Void

    var body: some View {
        switch route {
        case .some(.conversation(let id)):
            ChatView(app: app, conversationId: id, newChatTarget: nil, onOpenSidebar: onOpenSidebar)
                .id("conversation-" + id)
        case .some(.newChat(let id, let target)):
            ChatView(app: app, conversationId: id, newChatTarget: target, onOpenSidebar: onOpenSidebar)
                .id("new-" + id)
        case .some(.bot(let botId, let kind, let nonce)):
            BotChatOpener(botId: botId, kind: kind, onOpenSidebar: onOpenSidebar)
                .id("bot-" + botId + "-" + kind + "-" + nonce)
        case .none:
            VStack(spacing: 0) {
                HStack {
                    PortalIconButton(label: "Open sidebar", symbol: "line.3.horizontal", action: onOpenSidebar)
                    Text(app.appName).font(.subheadline.weight(.medium))
                    Spacer()
                    PortalIconButton(label: "New chat", symbol: "square.and.pencil", action: onCompose)
                }.padding(.horizontal, 8)
                Spacer()
                PortalMark(size: 44)
                Text("What can I help with?")
                    .font(.title2.weight(.semibold))
                    .multilineTextAlignment(.center)
                    .padding(.top, 20)
                Button("Start a new chat", action: onCompose)
                    .buttonStyle(.borderedProminent)
                    .tint(PortalTheme.ink)
                    .foregroundStyle(PortalTheme.onInk)
                    .clipShape(Capsule())
                    .padding(.top, 20)
                Spacer()
            }
        }
    }
}

@MainActor
struct BotChatOpener: View {
    @Environment(AppModel.self) private var app
    let botId: String
    let kind: String
    let onOpenSidebar: () -> Void
    @State private var conversationId: String?
    @State private var errorText: String?

    var body: some View {
        Group {
            if let conversationId {
                ChatView(app: app, conversationId: conversationId, newChatTarget: nil, onOpenSidebar: onOpenSidebar)
            } else {
                VStack {
                    HStack {
                        PortalIconButton(label: "Open sidebar", symbol: "line.3.horizontal", action: onOpenSidebar)
                        Spacer()
                    }.padding(.horizontal, 8)
                    Spacer()
                    if let errorText {
                        ContentUnavailableView {
                            Label("Couldn't open chat", systemImage: "exclamationmark.triangle")
                        } description: { Text(errorText) } actions: {
                            Button("Try Again") { Task { await open() } }
                        }
                    } else { ProgressView() }
                    Spacer()
                }
            }
        }
        .task {
            if conversationId == nil { await open() }
        }
    }

    private func open() async {
        guard let api = app.api else { return }
        errorText = nil
        do {
            let chatKind = BotChatKind(rawValue: kind) ?? .home
            conversationId = try await api.openBotChat(botId: botId, kind: chatKind)
            if chatKind == .side { await app.refreshShell() }
        } catch {
            if !error.isUnauthorized && !error.isCancellation { errorText = error.localizedDescription }
        }
    }
}
