import SwiftUI
import CollectiveKit

@MainActor
struct DesktopInspectorView: View {
    let model: ChatModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Agent & Activity").font(.title2)
                Text(model.assistantName).font(.headline)
                Text(model.statusLabel).foregroundStyle(.secondary)
                if let detail = model.target?.detail { Text(detail) }
                LabeledContent("Conversation", value: model.conversationId).textSelection(.enabled)
                if model.needsMessageStatusCheck { Label("Message acceptance needs confirmation", systemImage: "exclamationmark.triangle") }
                Divider()
                ForEach(model.messages) { message in
                    ForEach(Array(message.parts.enumerated()), id: \.offset) { item in
                        if case .tool(let tool) = item.element {
                            Label(tool.title ?? tool.toolName, systemImage: symbol(tool.phase))
                        }
                    }
                }
                if !model.app.bots.isEmpty {
                    Divider()
                    Text("Bot Activity").font(.headline)
                    ForEach(model.app.bots) { bot in
                        LabeledContent(bot.name, value: bot.status ?? "Ready")
                    }
                }
            }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityIdentifier("chat.inspector")
    }

    private func symbol(_ phase: ToolPhase) -> String {
        switch phase {
        case .awaitingApproval: "shield.lefthalf.filled"
        case .completed: "checkmark.circle"
        case .failed: "exclamationmark.triangle"
        case .denied: "hand.raised"
        case .running, .approvalResponded: "clock"
        }
    }
}
