import SwiftUI
import CollectiveKit

@MainActor
struct BotDirectoryRow: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let bot: TargetOption
    let openHome: (TargetOption) -> Void
    let newSideChat: (TargetOption) -> Void

    private var preview: String? {
        [bot.preview, bot.detail].compactMap { $0 }.first { !$0.isEmpty }
    }

    private var activity: BotActivity {
        switch bot.status {
        case "working": .working
        case "waiting": .approval
        default: .idle
        }
    }

    var body: some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 12))
            : AnyLayout(HStackLayout(alignment: .top, spacing: 16))
        Button(action: openBotHome) {
            layout {
                BotIdentityView(botId: bot.id, icon: bot.icon, size: 44, activity: activity)
                    .frame(width: 60, height: 60)
                    .background(PortalTheme.surfaceSecondary, in: .rect(cornerRadius: 16))
                VStack(alignment: .leading, spacing: 6) {
                    Text(bot.name)
                        .font(.headline)
                        .foregroundStyle(PortalTheme.ink)
                        .fixedSize(horizontal: false, vertical: true)
                    if let preview {
                        Text(preview)
                            .font(.callout)
                            .foregroundStyle(PortalTheme.muted)
                            .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    BotDirectoryStatus(status: bot.status)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if !dynamicTypeSize.isAccessibilitySize {
                    Image(systemName: "chevron.forward")
                        .font(.footnote.bold())
                        .foregroundStyle(PortalTheme.muted)
                        .padding(.top, 4)
                        .accessibilityHidden(true)
                }
            }
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(bot.name)
        .accessibilityValue([bot.pinned ? "Pinned" : nil, BotDirectoryStatus.label(for: bot.status), preview].compactMap { $0 }.joined(separator: ". "))
        .accessibilityHint("Opens this bot's home conversation")
        .accessibilityInputLabels([bot.name])
        .accessibilityIdentifier("botDirectory." + bot.id)
        .accessibilityAction(named: "New side chat", startSideChat)
        .contextMenu {
            Button("Open bot home", systemImage: "house", action: openBotHome)
            Button("New side chat", systemImage: "plus.bubble", action: startSideChat)
        }
        .listRowBackground(PortalTheme.surface)
    }

    private func openBotHome() { openHome(bot) }
    private func startSideChat() { newSideChat(bot) }
}
