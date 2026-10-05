import SwiftUI
import CollectiveKit

/// Compose sheet: pick a model connection or a bot for a brand-new chat.
@MainActor
struct NewChatSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if !model.apps.isEmpty {
                    Section("Models") {
                        ForEach(model.apps) { option in
                            targetButton(option)
                        }
                    }
                }
                if !model.bots.isEmpty {
                    Section("Bots") {
                        ForEach(model.bots) { option in
                            targetButton(option)
                        }
                    }
                }
                if model.apps.isEmpty && model.bots.isEmpty {
                    Text("Nothing is available to chat with yet. Ask your administrator to add a model connection.")
                        .foregroundStyle(.secondary)
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(PortalTheme.background)
            .navigationTitle("New chat")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        dismiss()
                    }
                }
            }
        }
    }

    private func targetButton(_ option: TargetOption) -> some View {
        Button {
            model.startNewChat(with: option)
            dismiss()
        } label: {
            HStack(spacing: 12) {
                BotIdentityView(botId: option.kind == "bot" ? option.id : nil, icon: option.icon ?? (option.kind == "app" ? "✨" : nil), size: 32)
                VStack(alignment: .leading, spacing: 2) {
                    Text(option.name)
                        .foregroundStyle(Color.primary)
                    if let detail = option.detail, !detail.isEmpty {
                        Text(detail)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
