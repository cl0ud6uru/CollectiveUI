import SwiftUI
import CollectiveKit

/// Keep current bot work visible when the navigation drawer/column is closed.
struct BotWorkRail: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let bots: [TargetOption]
    let onOpenSidebar: () -> Void

    private var active: [TargetOption] { bots.filter { $0.status == "working" || $0.status == "waiting" } }
    private func label(_ bot: TargetOption) -> String {
        "\(bot.name): \(bot.status == "waiting" ? "Needs your approval" : "Working")"
    }

    var body: some View {
        if !active.isEmpty {
            ScrollView(.horizontal) {
                HStack(spacing: 12) {
                    ForEach(active) { bot in
                        Button(action: onOpenSidebar) {
                            HStack(spacing: 6) {
                                BotIdentityView(botId: bot.id, icon: bot.icon, size: 24,
                                                activity: bot.status == "waiting" ? .approval : .working)
                                Text(label(bot)).font(.caption).foregroundStyle(PortalTheme.ink)
                                    .frame(maxWidth: dynamicTypeSize.isAccessibilitySize ? 220 : 280, alignment: .leading)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            .padding(.vertical, 10)
                        }
                        .buttonStyle(.plain)
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(label(bot))
                        .accessibilityHint("Opens bot navigation")
                    }
                }
                .padding(.horizontal, 12)
            }
            .scrollIndicators(.hidden)
            .background(PortalTheme.sidebar)
            .accessibilityIdentifier("bot-work-rail")
        }
    }
}
