import SwiftUI
import CollectiveKit

/// Uses the same persisted member order as the web UI: the first member leads.
struct GroupChatHeader: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let group: TargetOption
    @State private var showMembers = false

    var body: some View {
        Button { showMembers = true } label: {
            VStack(alignment: .leading, spacing: 3) {
                Text(group.name).font(.subheadline.weight(.medium)).lineLimit(2)
                if let lead = group.members.first {
                    HStack(spacing: 6) {
                        leadBadge
                        Text(lead.name).font(.caption).foregroundStyle(PortalTheme.muted).lineLimit(2)
                    }
                }
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Group members: " + group.name)
        .accessibilityValue(group.members.first.map { "Lead: " + $0.name } ?? "")
        .accessibilityIdentifier("chat.groupMembers")
        .sheet(isPresented: $showMembers) {
            NavigationStack {
                List {
                    Section {
                        ForEach(group.members) { member in
                            let layout = dynamicTypeSize.isAccessibilitySize
                                ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
                                : AnyLayout(HStackLayout(spacing: 12))
                            layout {
                                BotIdentityView(botId: member.id, icon: member.icon, size: 32)
                                    .accessibilityHidden(true)
                                Text(member.name)
                                if !dynamicTypeSize.isAccessibilitySize { Spacer(minLength: 4) }
                                if member.id == group.members.first?.id { leadBadge }
                            }
                            .accessibilityElement(children: .combine)
                        }
                    } footer: {
                        Text("Messages without an @mention go to the lead bot. Use @mentions to address other members.")
                    }
                }
                .scrollContentBackground(.hidden)
                .background(PortalTheme.background)
                .navigationTitle("Group members")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) { Button("Done") { showMembers = false } }
                }
            }
        }
    }

    private var leadBadge: some View {
        Text("Lead")
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 8).padding(.vertical, 2)
            .background(PortalTheme.surfaceSecondary, in: Capsule())
            .fixedSize()
    }
}
