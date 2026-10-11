import SwiftUI
import CollectiveKit

@MainActor
struct BotDirectoryView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var searchText = ""
    let bots: [TargetOption]
    let openHome: (TargetOption) -> Void
    let newSideChat: (TargetOption) -> Void

    private var filteredBots: [TargetOption] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return bots }
        return bots.filter { bot in
            [bot.name, bot.detail ?? "", bot.preview ?? ""].contains {
                $0.localizedStandardContains(query)
            }
        }
    }

    var body: some View {
        let pinned = filteredBots.filter(\.pinned)
        let remaining = filteredBots.filter { !$0.pinned }
        NavigationStack {
            List {
                if bots.isEmpty {
                    ContentUnavailableView("No bots yet", systemImage: "bubble.left.and.bubble.right", description:
                        Text("Your bots will appear here when they are available."))
                        .listRowBackground(Color.clear)
                } else if filteredBots.isEmpty {
                    ContentUnavailableView.search
                        .listRowBackground(Color.clear)
                } else {
                    if !pinned.isEmpty {
                        Section {
                            ForEach(pinned) { bot in
                                BotDirectoryRow(bot: bot, openHome: openHome, newSideChat: newSideChat)
                            }
                        } header: {
                            Label("Pinned", systemImage: "pin.fill")
                        }
                    }
                    if !remaining.isEmpty {
                        Section(pinned.isEmpty ? "All bots" : "More bots") {
                            ForEach(remaining) { bot in
                                BotDirectoryRow(bot: bot, openHome: openHome, newSideChat: newSideChat)
                            }
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(PortalTheme.background)
            .navigationTitle("Bots")
            .navigationBarTitleDisplayMode(.large)
            .searchable(text: $searchText, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search bots")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done", action: dismiss.callAsFunction)
                }
            }
        }
    }
}
