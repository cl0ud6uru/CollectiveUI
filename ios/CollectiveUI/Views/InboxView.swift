import SwiftUI
import CollectiveKit

@MainActor
struct InboxView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    @State private var items: [InboxItem] = []
    @State private var isLoading: Bool = true
    @State private var errorText: String? = nil

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Inbox")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Done") {
                            dismiss()
                        }
                    }
                    ToolbarItem(placement: .primaryAction) {
                        Button("Mark all read") {
                            Task {
                                await markAllRead()
                            }
                        }
                        .disabled(!items.contains(where: { !$0.read }))
                    }
                }
        }
        .task {
            await load()
        }
    }

    @ViewBuilder
    private var content: some View {
        if isLoading && items.isEmpty {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let errorText, items.isEmpty {
            ContentUnavailableView("Couldn't load the inbox", systemImage: "exclamationmark.triangle", description: Text(errorText))
        } else if items.isEmpty {
            ContentUnavailableView("Inbox is empty", systemImage: "tray", description: Text("Approval requests and routine results will appear here."))
        } else {
            List(items) { item in
                Button {
                    open(item)
                } label: {
                    InboxRow(item: item)
                }
                .buttonStyle(.plain)
            }
            .listStyle(.plain)
            .refreshable {
                await load()
            }
        }
    }

    private func load() async {
        guard let api = model.api else { return }
        isLoading = true
        do {
            items = try await api.inbox()
            errorText = nil
        } catch {
            if !error.isCancellation && !error.isUnauthorized {
                errorText = error.localizedDescription
            }
        }
        isLoading = false
    }

    private func open(_ item: InboxItem) {
        if let index = items.firstIndex(where: { $0.id == item.id }) {
            items[index].read = true
        }
        let api = model.api
        Task {
            if let api, !item.read {
                do {
                    try await api.markInboxRead(id: item.id)
                } catch {
                    // Not critical; the next refresh shows the server state.
                }
            }
            await model.refreshShell()
        }
        if let conversationId = item.conversationId {
            model.openConversation(conversationId)
            dismiss()
        }
    }

    private func markAllRead() async {
        guard let api = model.api else { return }
        do {
            try await api.markInboxRead(id: nil)
            for index in items.indices {
                items[index].read = true
            }
            await model.refreshShell()
        } catch {
            if !error.isUnauthorized {
                model.showBanner(error.localizedDescription, isError: true)
            }
        }
    }
}

@MainActor
struct InboxRow: View {
    let item: InboxItem

    private var iconName: String {
        switch item.kind {
        case "approval":
            return "checkmark.shield"
        case "routine_result", "task_result":
            return "checkmark.circle"
        case "routine_error", "task_error":
            return "exclamationmark.triangle"
        default:
            return "bell"
        }
    }

    private var iconColor: Color {
        switch item.kind {
        case "approval":
            return .orange
        case "routine_error", "task_error":
            return .red
        default:
            return .accentColor
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: iconName)
                .foregroundStyle(iconColor)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text(item.title)
                        .font(.body.weight(item.read ? .regular : .semibold))
                        .lineLimit(2)
                    Spacer(minLength: 4)
                    if !item.read {
                        Circle()
                            .fill(Color.accentColor)
                            .frame(width: 8, height: 8)
                    }
                }
                if let detailText = item.body, !detailText.isEmpty {
                    Text(detailText)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                }
                if let date = item.createdAt {
                    Text(date.formatted(.relative(presentation: .named)))
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
    }
}
