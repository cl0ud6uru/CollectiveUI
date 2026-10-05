import SwiftUI
import CollectiveKit

@MainActor
struct SidebarView: View {
    @Environment(AppModel.self) private var model
    @Binding var showCompose: Bool
    @Binding var showInbox: Bool
    @Binding var showSettings: Bool

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
        @Bindable var bindableModel = model
        List(selection: $bindableModel.selection) {
            if trimmedQuery.isEmpty {
                botsSection
                chatsSections
                if model.shell == nil {
                    loadingRow
                }
            } else {
                searchSection
            }
        }
        .listStyle(.sidebar)
        .navigationTitle(model.appName)
        .searchable(text: $searchText, prompt: "Search chats")
        .task(id: searchText) {
            await runSearch()
        }
        .onAppear {
            #if DEBUG
            applyDemoSearch()
            #endif
        }
        .refreshable {
            await model.refreshShell()
        }
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    showSettings = true
                } label: {
                    Image(systemName: "person.crop.circle")
                }
                .accessibilityLabel("Settings")
            }
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button {
                    showInbox = true
                } label: {
                    InboxIcon(unread: model.inboxUnread)
                }
                .accessibilityLabel("Inbox")
                Button {
                    showCompose = true
                } label: {
                    Image(systemName: "square.and.pencil")
                }
                .accessibilityLabel("New chat")
            }
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

    // MARK: - Sections

    @ViewBuilder
    private var botsSection: some View {
        if !model.bots.isEmpty {
            Section("Bots") {
                ForEach(model.bots) { bot in
                    NavigationLink(value: ChatRoute.bot(botId: bot.id, kind: "home", nonce: "home")) {
                        BotRow(bot: bot)
                    }
                    .contextMenu {
                        Button {
                            model.selection = .bot(botId: bot.id, kind: "side", nonce: UUID().uuidString)
                        } label: {
                            Label("New side chat", systemImage: "plus.bubble")
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var chatsSections: some View {
        ForEach(ConversationGrouping.sections(for: model.chatConversations)) { section in
            Section(section.title) {
                ForEach(section.conversations) { conversation in
                    conversationRow(conversation)
                }
            }
        }
    }

    private func conversationRow(_ conversation: ConversationSummary) -> some View {
        NavigationLink(value: ChatRoute.conversation(conversation.id)) {
            ConversationRow(conversation: conversation)
        }
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
                    NavigationLink(value: ChatRoute.conversation(result.conversationId)) {
                        SearchResultRow(result: result)
                    }
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
            AvatarView(icon: bot.icon, size: 34)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(bot.name)
                        .font(.body.weight(.medium))
                        .lineLimit(1)
                    if bot.status == "working" {
                        ProgressView()
                            .controlSize(.mini)
                    } else if bot.status == "waiting" {
                        Circle()
                            .fill(Color.orange)
                            .frame(width: 8, height: 8)
                            .accessibilityLabel("Waiting for you")
                    }
                }
                if let subtitle {
                    Text(subtitle)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
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
                        .lineLimit(1)
                }
                if let date = conversation.updatedAt {
                    Text(date.formatted(.relative(presentation: .named)))
                        .font(.caption)
                        .foregroundStyle(.secondary)
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
