import SwiftUI
import CollectiveKit

@MainActor
struct DesktopNewChatView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("New Chat").font(.title2).padding(.horizontal)
            TextField("Find a bot or model", text: $query).textFieldStyle(.roundedBorder).padding(.horizontal)
            List {
                Section("Models") { targets(app.apps) }
                Section("Bots — private conversation") { targets(app.bots) }
            }
            HStack { Spacer(); Button("Cancel", role: .cancel) { dismiss() } }.padding(.horizontal)
        }
        .padding(.vertical).frame(width: 460, height: 460)
    }

    @ViewBuilder
    private func targets(_ values: [TargetOption]) -> some View {
        ForEach(values.filter { query.isEmpty || $0.name.localizedStandardContains(query) }) { target in
            Button {
                app.startNewChat(with: target)
                dismiss()
            } label: {
                HStack(spacing: 12) {
                    BotIdentityView(botId: target.kind == "bot" ? target.id : nil, icon: target.icon, size: 32)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(target.name)
                        if target.hermesTeam { Text("Team Bot native support is pending").font(.caption).foregroundStyle(.secondary) }
                        else if let detail = target.detail { Text(detail).font(.caption).foregroundStyle(.secondary) }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 4)
            }
            .buttonStyle(.plain).disabled(target.hermesTeam)
        }
    }
}
