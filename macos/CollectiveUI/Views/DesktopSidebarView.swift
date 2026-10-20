import SwiftUI
import CollectiveKit

@MainActor
struct DesktopSidebarView: View {
    @Environment(AppModel.self) private var app
    @Environment(DesktopWorkspace.self) private var workspace

    var body: some View {
        @Bindable var app = app
        List(selection: $app.selection) {
            Button("Home", systemImage: "house") { app.selection = nil }.buttonStyle(.plain)
            if !app.bots.isEmpty {
                Section("Bots") {
                    ForEach(app.bots) { bot in
                        HStack(spacing: DesktopLayout.rowSpacing) {
                            BotIdentityView(botId: bot.id, icon: bot.icon, size: 32, activity: activity(bot))
                            VStack(alignment: .leading, spacing: 4) {
                                HStack(spacing: 5) {
                                    Text(bot.name).lineLimit(1)
                                    if bot.coordinator {
                                        Image(systemName: "star.fill").font(.caption)
                                            .foregroundStyle(PortalTheme.muted)
                                            .help("Default coordinator").accessibilityLabel("Default coordinator")
                                    }
                                }
                                if let preview = bot.preview, !preview.isEmpty {
                                    Text(preview).font(.caption).foregroundStyle(PortalTheme.muted).lineLimit(1)
                                }
                            }
                            Spacer(minLength: 0)
                            if activity(bot) != .idle {
                                Image(systemName: activity(bot) == .approval ? "hand.raised" : "circle.dotted")
                                    .foregroundStyle(activity(bot) == .approval ? PortalTheme.warning : PortalTheme.working)
                                    .help(activity(bot) == .approval ? "Waiting for approval" : "Working")
                                    .accessibilityLabel(activity(bot) == .approval ? "Waiting for approval" : "Working")
                            }
                        }
                        .padding(.vertical, 5)
                        .tag(ChatRoute.bot(botId: bot.id, kind: "home", nonce: bot.id))
                        .accessibilityIdentifier("sidebar.bot." + bot.id)
                    }
                }
            }
            Section("Conversations") {
                ForEach(app.chatConversations) { conversation in
                    Label(conversation.title.isEmpty ? "Untitled chat" : conversation.title,
                          systemImage: conversation.pinned ? "pin" : "bubble.left")
                        .lineLimit(2)
                        .tag(ChatRoute.conversation(conversation.id))
                        .accessibilityIdentifier("sidebar.chat." + conversation.id)
                        .contextMenu {
                            Button(conversation.pinned ? "Unpin" : "Pin") {
                                Task { await app.setPinned(conversation, pinned: !conversation.pinned) }
                            }
                            Button("Archive") { Task { await app.archive(conversation) } }
                        }
                }
            }
            if !localDraftIDs.isEmpty {
                Section("Saved Drafts & Recovery") {
                    ForEach(localDraftIDs, id: \.self) { id in
                        let state = app.conversationStates.state(for: id)
                        Label(state.requiresStatusCheck ? "Message needs confirmation" : "Draft with \(state.newChatTarget?.name ?? "assistant")",
                              systemImage: state.requiresStatusCheck ? "exclamationmark.bubble" : "square.and.pencil")
                            .tag(ChatRoute.conversation(id))
                    }
                }
            }
            if let error = app.shellError {
                Section {
                    Text(error).foregroundStyle(.secondary)
                    Button("Reload") { Task { await app.refreshShell() } }
                }
            } else if app.shell == nil { ProgressView("Loading conversations…") }
        }
        .listStyle(.sidebar)
        .scrollContentBackground(.hidden)
        .background(PortalTheme.sidebar)
        .navigationTitle(app.appName)
        .safeAreaInset(edge: .top, spacing: 0) {
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 10) {
                    PortalMark(size: 26)
                    Text(app.appName).font(.headline)
                }
                Button("New Chat", systemImage: "square.and.pencil") { workspace.showNewChat = true }
                    .buttonStyle(.plain).help("New chat (⌘N)")
                    .accessibilityIdentifier("sidebar.newChat")
            }
            .frame(maxWidth: .infinity, alignment: .leading).padding(16)
            .background(PortalTheme.sidebar)
        }
        .safeAreaInset(edge: .bottom) {
            HStack {
                VStack(alignment: .leading) {
                    Text(app.shell?.user?.name ?? "Signed in").font(.callout)
                    if app.isDemoSession { Text("Offline fixtures").font(.caption).foregroundStyle(.secondary) }
                }
                Spacer()
                SettingsLink { Label("Settings", systemImage: "gearshape") }.labelStyle(.iconOnly)
                    .help("Settings (⌘,)")
            }
            .padding(16).background(PortalTheme.sidebar)
        }
    }

    private func activity(_ bot: TargetOption) -> BotActivity {
        if bot.status == "waiting" { return .approval }
        if bot.status == "working" { return .working }
        return .idle
    }

    private var localDraftIDs: [String] {
        let serverIDs = Set(app.shell?.conversations.map(\.id) ?? [])
        return app.conversationStates.recoverableIDs.filter { !serverIDs.contains($0) }
    }
}
