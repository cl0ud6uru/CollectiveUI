import SwiftUI
import CollectiveKit

@MainActor
struct SidebarView: View {
    @Environment(AppModel.self) private var model
    @Binding var showCompose: Bool
    @Binding var showInbox: Bool
    @Binding var showSettings: Bool
    var onClose: () -> Void = {}
    var onCollapse: () -> Void = {}
    @State private var showSearch = false
    @State private var showBots = false
    @FocusState private var searchFocused: Bool

    @State private var searchText: String = ""
    @State private var searchResults: [SearchResult] = []
    @State private var isSearching: Bool = false
    @State private var renameTarget: ConversationSummary? = nil
    @State private var renameText: String = ""
    @State private var deleteTarget: ConversationSummary? = nil

    private var trimmedQuery: String {
        return searchText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                PortalMark(size: 26)
                Text(model.appName).font(.subheadline.weight(.semibold)).lineLimit(1)
                Spacer(minLength: 0)
                PortalIconButton(label: "Close sidebar", symbol: "sidebar.left", action: onCollapse)
            }
            .padding(.leading, 18)
            .padding(.trailing, 8)
            .padding(.vertical, 4)

            List {
                Section {
                    navigationAction("New chat", symbol: "square.and.pencil") { showCompose = true }
                    navigationAction("Search chats", symbol: "magnifyingglass") {
                        showSearch = true
                        searchFocused = true
                    }
                    navigationAction("Bots", symbol: "square.grid.2x2") { showBots = true }
                    navigationAction("Inbox", symbol: "bell", count: model.inboxUnread) { showInbox = true }
                    if showSearch || !searchText.isEmpty {
                        HStack(spacing: 8) {
                            Image(systemName: "magnifyingglass").foregroundStyle(PortalTheme.muted)
                            TextField("Search chats", text: $searchText)
                                .focused($searchFocused)
                                .submitLabel(.search)
                            Button {
                                searchText = ""
                                showSearch = false
                                searchFocused = false
                            } label: { Image(systemName: "xmark.circle.fill") }
                            .accessibilityLabel("Clear search")
                        }
                        .padding(8)
                        .background(PortalTheme.surfaceSecondary, in: RoundedRectangle(cornerRadius: 10))
                    }
                }
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)

                if trimmedQuery.isEmpty {
                    botsSection
                    projectsSection
                    chatsSections
                    if model.shell == nil { loadingRow }
                } else {
                    searchSection
                }
            }
            .listStyle(.plain)
            .environment(\.defaultMinListRowHeight, 44)
            .scrollContentBackground(.hidden)
            .refreshable { await model.refreshShell() }

            Button { showSettings = true } label: {
                HStack(spacing: 10) {
                    Image(systemName: "person.crop.circle").font(.title2)
                    Text(model.shell?.user?.name ?? "Settings").font(.subheadline).lineLimit(1)
                    Spacer()
                    Image(systemName: "gearshape").font(.subheadline)
                }
                .padding(.horizontal, 18)
                .frame(minHeight: 52)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Settings")
        }
        .background(PortalTheme.sidebar)
        .sheet(isPresented: $showBots) { botDirectory }
        .task(id: searchText) { await runSearch() }
        .onAppear {
            #if DEBUG
            applyDemoSearch()
            #endif
        }
        .alert("Rename chat", isPresented: renameBinding) {
            TextField("Title", text: $renameText)
            Button("Save") {
                if let target = renameTarget {
                    let title = renameText
                    Task {
                        await model.rename(target, to: title)
                    }
                }
                renameTarget = nil
            }
            Button("Cancel", role: .cancel) {
                renameTarget = nil
            }
        }
        .alert("Delete chat?", isPresented: deleteBinding) {
            Button("Delete", role: .destructive) {
                if let target = deleteTarget {
                    Task {
                        await model.delete(target)
                    }
                }
                deleteTarget = nil
            }
            Button("Cancel", role: .cancel) {
                deleteTarget = nil
            }
        } message: {
            Text("This chat will be permanently deleted.")
        }
    }

    private func navigationAction(_ title: String, symbol: String, count: Int = 0, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: symbol).font(.system(size: 17)).frame(width: 20)
                Text(title).font(.subheadline)
                Spacer()
                if count > 0 {
                    Text(String(count)).font(.caption2.weight(.semibold))
                        .foregroundStyle(PortalTheme.onInk)
                        .padding(.horizontal, 6).padding(.vertical, 3)
                        .background(PortalTheme.ink, in: Capsule())
                }
            }.contentShape(Rectangle())
        }.buttonStyle(.plain)
    }

    // MARK: - Sections

    @ViewBuilder
    private var botsSection: some View {
        if !model.bots.isEmpty {
            Section("Bot homes") {
                ForEach(model.bots) { bot in
                    Button {
                        model.selection = .bot(botId: bot.id, kind: "home", nonce: "home")
                        onClose()
                    } label: {
                        BotRow(bot: bot).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("Opens this bot's home conversation")
                    .listRowSeparator(.hidden)
                    .listRowBackground(activeBotId == bot.id ? PortalTheme.surfaceSecondary : Color.clear)
                    .contextMenu {
                        Button {
                            model.selection = .bot(botId: bot.id, kind: "home", nonce: "home")
                            onClose()
                        } label: {
                            Label("Open bot home", systemImage: "house")
                        }
                        Button {
                            model.selection = .bot(botId: bot.id, kind: "side", nonce: UUID().uuidString)
                            onClose()
                        } label: {
                            Label("New side chat", systemImage: "plus.bubble")
                        }
                    }
                }
            }
        }
    }

    private var activeBotId: String? {
        switch model.selection {
        case .bot(let id, _, _): return id
        case .conversation(let id): return model.shell?.conversations.first { $0.id == id }?.botId
        case .newChat(_, let target): return target.kind == "bot" ? target.id : nil
        case nil: return nil
        }
    }

    private var botDirectory: some View {
        NavigationStack {
            List(model.bots) { bot in
                Button {
                    model.selection = .bot(botId: bot.id, kind: "home", nonce: "home")
                    showBots = false
                    onClose()
                } label: { BotRow(bot: bot) }.buttonStyle(.plain)
            }
            .listStyle(.plain).scrollContentBackground(.hidden).background(PortalTheme.background)
            .navigationTitle("Bots").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showBots = false } } }
        }
    }

    @ViewBuilder
    private var projectsSection: some View {
        if let folders = model.shell?.folders, !folders.isEmpty {
            Section("Projects") {
                ForEach(folders) { folder in
                    DisclosureGroup {
                        let chats = model.chatConversations.filter { $0.folderId == folder.id }
                        if chats.isEmpty { Text("No chats yet").font(.caption).foregroundStyle(PortalTheme.muted) }
                        ForEach(chats) { conversationRow($0) }
                    } label: { Label(folder.name, systemImage: "folder").font(.subheadline) }
                    .listRowSeparator(.hidden).listRowBackground(Color.clear)
                }
            }
        }
    }

    private var unfiledChats: [ConversationSummary] {
        let folderIds = Set((model.shell?.folders ?? []).map(\.id))
        return model.chatConversations.filter { $0.folderId.map { !folderIds.contains($0) } ?? true }
    }

    @ViewBuilder
    private var chatsSections: some View {
        ForEach(ConversationGrouping.sections(for: unfiledChats)) { section in
            Section(section.title) {
                ForEach(section.conversations) { conversation in
                    conversationRow(conversation)
                }
            }
        }
    }

    private func conversationRow(_ conversation: ConversationSummary) -> some View {
        Button {
            model.openConversation(conversation.id)
            onClose()
        } label: {
            ConversationRow(conversation: conversation).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            Button {
                Task {
                    await model.setPinned(conversation, pinned: !conversation.pinned)
                }
            } label: {
                Label(conversation.pinned ? "Unpin" : "Pin", systemImage: conversation.pinned ? "pin.slash" : "pin")
            }
            .tint(Color.orange)
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button {
                deleteTarget = conversation
            } label: {
                Label("Delete", systemImage: "trash")
            }
            .tint(Color.red)
            Button {
                Task {
                    await model.archive(conversation)
                }
            } label: {
                Label("Archive", systemImage: "archivebox")
            }
            .tint(Color.indigo)
        }
        .contextMenu {
            Button {
                renameText = conversation.title
                renameTarget = conversation
            } label: {
                Label("Rename", systemImage: "pencil")
            }
            Button {
                Task {
                    await model.setPinned(conversation, pinned: !conversation.pinned)
                }
            } label: {
                Label(conversation.pinned ? "Unpin" : "Pin", systemImage: conversation.pinned ? "pin.slash" : "pin")
            }
            Button {
                Task {
                    await model.archive(conversation)
                }
            } label: {
                Label("Archive", systemImage: "archivebox")
            }
            Button(role: .destructive) {
                deleteTarget = conversation
            } label: {
                Label("Delete", systemImage: "trash")
            }
        }
    }

    @ViewBuilder
    private var searchSection: some View {
        Section {
            if isSearching && searchResults.isEmpty {
                HStack {
                    Spacer()
                    ProgressView()
                    Spacer()
                }
            } else if searchResults.isEmpty {
                Text("No matching chats")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(searchResults) { result in
                    Button {
                        model.openConversation(result.conversationId)
                        onClose()
                    } label: { SearchResultRow(result: result).contentShape(Rectangle()) }
                    .buttonStyle(.plain)
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
                }
            }
        } header: {
            Text("Search results")
        }
    }

    private var loadingRow: some View {
        HStack {
            Spacer()
            if let error = model.shellError {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            } else {
                ProgressView()
            }
            Spacer()
        }
        .listRowBackground(Color.clear)
    }

    // MARK: - Helpers

    private var renameBinding: Binding<Bool> {
        Binding(
            get: { renameTarget != nil },
            set: { presented in
                if !presented {
                    renameTarget = nil
                }
            }
        )
    }

    private var deleteBinding: Binding<Bool> {
        Binding(
            get: { deleteTarget != nil },
            set: { presented in
                if !presented {
                    deleteTarget = nil
                }
            }
        )
    }

    #if DEBUG
    /// `--demo-screen search` shows results for a sample query.
    private func applyDemoSearch() {
        guard DemoMode.isEnabled, DemoMode.screen == "search", !DemoRuntime.searchApplied else { return }
        DemoRuntime.searchApplied = true
        searchText = "vector"
    }
    #endif

    private func runSearch() async {
        let query = trimmedQuery
        guard !query.isEmpty else {
            searchResults = []
            isSearching = false
            return
        }
        isSearching = true
        try? await Task.sleep(nanoseconds: 300_000_000)
        if Task.isCancelled {
            return
        }
        guard let api = model.api else {
            isSearching = false
            return
        }
        do {
            let results = try await api.search(query: query)
            var seen = Set<String>()
            searchResults = results.filter { seen.insert($0.conversationId).inserted }
        } catch {
            if error.isCancellation {
                return
            }
            searchResults = []
        }
        isSearching = false
    }
}

@MainActor
struct InboxIcon: View {
    let unread: Int

    var body: some View {
        Image(systemName: "tray")
            .overlay(alignment: .topTrailing) {
                if unread > 0 {
                    Text(unread > 99 ? "99+" : String(unread))
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(Color.white)
                        .padding(.horizontal, 4)
                        .padding(.vertical, 1)
                        .background(Capsule().fill(Color.red))
                        .offset(x: 10, y: -8)
                }
            }
    }
}

@MainActor
struct BotRow: View {
    let bot: TargetOption

    private var subtitle: String? {
        if bot.status == "waiting" { return "Needs your approval" }
        if bot.status == "working" { return "Working…" }
        if let preview = bot.preview, !preview.isEmpty {
            return preview
        }
        if let detail = bot.detail, !detail.isEmpty {
            return detail
        }
        return nil
    }

    var body: some View {
        HStack(spacing: 12) {
            BotIdentityView(botId: bot.id, icon: bot.icon, size: 32, activity: bot.status == "working" ? .working : bot.status == "waiting" ? .approval : .idle)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(bot.name)
                        .font(.subheadline.weight(.medium))
                        .lineLimit(1)
                    if bot.pinned { Image(systemName: "pin").font(.caption2).foregroundStyle(PortalTheme.subtle).accessibilityLabel("Pinned") }
                    if bot.status == "working" {
                        Circle().fill(PortalTheme.working).frame(width: 7, height: 7)
                            .accessibilityLabel("Working")
                    } else if bot.status == "waiting" {
                        Circle()
                            .fill(PortalTheme.warning)
                            .frame(width: 8, height: 8)
                            .accessibilityLabel("Waiting for you")
                    }
                }
                if let subtitle {
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(bot.status == "waiting" ? PortalTheme.warning : bot.status == "working" ? PortalTheme.working : PortalTheme.muted)
                        .lineLimit(1)
                }
            }
        }
        .padding(.vertical, 2)
    }
}

@MainActor
struct ConversationRow: View {
    let conversation: ConversationSummary

    var body: some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    if conversation.source == "routine" {
                        Image(systemName: "clock")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else if conversation.source == "delegation" {
                        Image(systemName: "arrow.triangle.branch")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else if conversation.isGroup {
                        Image(systemName: "person.3")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Text(conversation.title.isEmpty ? "New chat" : conversation.title)
                        .font(.subheadline)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            if conversation.taskActivity?.unread == true {
                Circle()
                    .fill(Color.accentColor)
                    .frame(width: 8, height: 8)
                    .accessibilityLabel("Unread activity")
            }
        }
    }
}

@MainActor
struct SearchResultRow: View {
    let result: SearchResult

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(result.title.isEmpty ? "Untitled chat" : result.title)
                .lineLimit(1)
            if let snippet = result.snippet, !snippet.isEmpty {
                Text(TextUtilities.stripHTML(snippet))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
    }
}
