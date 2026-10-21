import SwiftUI
import CollectiveKit

@MainActor
struct DesktopMessageView: View {
    let message: UIMessage
    let model: ChatModel

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            if message.role == .user { Spacer(minLength: 64) }
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contextMenu {
            Button("Copy", systemImage: "doc.on.doc") { DesktopClipboard.copy(message.plainText) }
            if message.id == model.lastAssistantMessageId && model.canRegenerate {
                Button("Regenerate", systemImage: "arrow.clockwise") { model.regenerate(assistantMessageId: message.id) }
            }
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 10) {
            if message.role != .user {
                HStack(spacing: 8) {
                    BotIdentityView(botId: model.target?.kind == "bot" ? model.target?.id : nil,
                        icon: model.assistantIcon, size: 24)
                    Text(model.assistantName).font(.callout.weight(.semibold))
                }
            }
            if model.conversationState.showsStoppedPlaceholder(for: message) {
                Label("Reply stopped", systemImage: "stop.circle").foregroundStyle(.secondary)
                    .accessibilityIdentifier("chat.stopped." + message.id)
            }
            TurnStepsView(message: message, model: model, toolDotY: 21, reasoningDotY: 9) { step in part(step) }
            ForEach(Array(message.parts.enumerated()), id: \.offset) { item in
                if !item.element.isTurnStep { part(item.element) }
            }
        }
        .lineSpacing(4)
        .textSelection(.enabled)
        .padding(message.role == .user ? 14 : 0)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(message.role == .user ? PortalTheme.surfaceSecondary : .clear, in: .rect(cornerRadius: 18))
    }

    @ViewBuilder
    private func part(_ part: MessagePart) -> some View {
        switch part {
        case .text(let value): DesktopMarkdownView(text: value.text)
        case .reasoning(let value):
            DisclosureGroup(value.state == "streaming" ? "Thinking…" : "Thinking") {
                Text(value.text).font(.callout).foregroundStyle(.secondary)
            }
        case .tool(let tool): DesktopToolView(part: tool, messageId: message.id, model: model)
        case .file(let value): Label(value.filename ?? "Attachment", systemImage: "paperclip")
        case .sourceURL(let value):
            if let url = URL(string: value.url), ["https", "http"].contains(url.scheme?.lowercased() ?? "") {
                Link(value.title ?? value.url, destination: url)
            }
        case .sourceDocument(let value): Label(value.title, systemImage: "doc.text")
        case .data(let value):
            if value.name == "run-error" || value.name == "bot-error" {
                Label(value.data["message"]?.stringValue ?? "The run failed.", systemImage: "exclamationmark.triangle").foregroundStyle(.red)
            } else if value.name == "speaker" { Text(value.data["name"]?.stringValue ?? "Bot").font(.headline) }
        case .stepStart, .unknown: EmptyView()
        }
    }
}
