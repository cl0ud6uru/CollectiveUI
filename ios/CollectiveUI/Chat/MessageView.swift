import SwiftUI
import UIKit
import CollectiveKit

@MainActor
struct MessageView: View {
    let message: UIMessage
    let model: ChatModel
    var marksLatestParagraph = false
    @State private var showWork = false

    var body: some View {
        Group {
            if message.role == .user {
                userBubble
            } else {
                assistantBody
            }
        }
        .contextMenu {
            Button {
                UIPasteboard.general.string = message.plainText
            } label: {
                Label("Copy", systemImage: "doc.on.doc")
            }
            if canRegenerate {
                Button {
                    model.regenerate(assistantMessageId: message.id)
                } label: {
                    Label("Regenerate", systemImage: "arrow.clockwise")
                }
            }
        }
    }

    private var canRegenerate: Bool {
        return message.role == .assistant
            && message.id == model.lastAssistantMessageId
            && model.canRegenerate
    }

    private var userBubble: some View {
        HStack(alignment: .bottom) {
            Spacer(minLength: 48)
            VStack(alignment: .trailing, spacing: 6) {
                ForEach(Array(message.files.enumerated()), id: \.offset) { item in
                    FileAttachmentView(file: item.element)
                }
                if !message.plainText.isEmpty {
                    Text(message.plainText)
                        .foregroundStyle(model.usesBubbles ? PortalTheme.bubbleTint(model.assistantIcon).foreground : PortalTheme.ink)
                        .textSelection(.enabled)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(
                            RoundedRectangle(cornerRadius: 18, style: .continuous)
                                .fill(model.usesBubbles ? PortalTheme.bubbleTint(model.assistantIcon).background : PortalTheme.surfaceSecondary)
                        )
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }

    private var assistantBody: some View {
        let latestTextPartIndex = marksLatestParagraph ? message.parts.lastIndex {
            if case .text(let text) = $0 { return !text.text.isEmpty }
            return false
        } : nil
        return VStack(alignment: .leading, spacing: 8) {
            if !model.usesBubbles {
                Text(model.assistantName).font(.caption.weight(.medium)).foregroundStyle(PortalTheme.muted)
            }
            if model.conversationState.showsStoppedPlaceholder(for: message) {
                Label("Reply stopped", systemImage: "stop.circle")
                    .font(.footnote).foregroundStyle(PortalTheme.muted)
                    .accessibilityIdentifier("chat.stopped.\(message.id)")
            }
            if !completedWork.isEmpty {
                DisclosureGroup(isExpanded: $showWork) {
                    ForEach(Array(completedWork.enumerated()), id: \.offset) { item in
                        MessagePartView(part: item.element, messageId: message.id, model: model)
                    }
                } label: {
                    Label("\(completedWork.count) completed \(completedWork.count == 1 ? "step" : "steps")", systemImage: "checkmark")
                        .font(.footnote).foregroundStyle(PortalTheme.muted)
                }
                .tint(PortalTheme.muted)
            }
            ForEach(Array(message.parts.enumerated()), id: \.offset) { item in
                if !isCompletedWork(item.element) {
                    // Approvals, failures and running tools always remain visible.
                    MessagePartView(part: item.element, messageId: message.id, model: model,
                        marksLatestParagraph: item.offset == latestTextPartIndex)
                }
            }
        }
        .padding(model.usesBubbles ? 14 : 0)
        .background(model.usesBubbles ? PortalTheme.botBubble : Color.clear, in: RoundedRectangle(cornerRadius: 18))
        .padding(.trailing, model.usesBubbles ? 28 : 0)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var completedWork: [MessagePart] { message.parts.filter(isCompletedWork) }
    private func isCompletedWork(_ part: MessagePart) -> Bool {
        switch part {
        case .tool(let tool): return tool.phase == .completed
        case .reasoning(let reasoning): return reasoning.state != "streaming" && !reasoning.text.isEmpty
        default: return false
        }
    }

}

@MainActor
struct MessagePartView: View {
    let part: MessagePart
    let messageId: String
    let model: ChatModel
    var marksLatestParagraph = false

    var body: some View {
        switch part {
        case .text(let text):
            if !text.text.isEmpty {
                MarkdownText(text: text.text, marksLatestParagraph: marksLatestParagraph)
            }
        case .reasoning(let reasoning):
            if !reasoning.text.isEmpty || reasoning.state == "streaming" {
                ReasoningView(text: reasoning.text, isStreaming: reasoning.state == "streaming")
            }
        case .tool(let tool):
            ToolPartView(part: tool, messageId: messageId, model: model)
        case .file(let file):
            FileAttachmentView(file: file)
        case .sourceURL(let source):
            SourceLinkView(title: source.title ?? source.url, url: source.url)
        case .sourceDocument(let document):
            Label(document.title, systemImage: "doc.text")
                .font(.footnote)
                .foregroundStyle(.secondary)
        case .data(let dataPart):
            DataPartView(part: dataPart)
        case .stepStart, .unknown:
            EmptyView()
        }
    }
}

@MainActor
struct ReasoningView: View {
    let text: String
    let isStreaming: Bool
    @State private var isExpanded: Bool = false

    var body: some View {
        DisclosureGroup(isExpanded: $isExpanded) {
            Text(text)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 4)
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "lightbulb")
                Text(isStreaming ? "Thinking…" : "Thinking")
            }
            .font(.footnote.weight(.medium))
            .foregroundStyle(.secondary)
        }
        .tint(Color.secondary)
    }
}

@MainActor
struct SourceLinkView: View {
    let title: String
    let url: String

    var body: some View {
        if let destination = URL(string: url) {
            Link(destination: destination) {
                Label(title, systemImage: "link")
                    .font(.footnote)
                    .lineLimit(1)
            }
        } else {
            Label(title, systemImage: "link")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }
}

@MainActor
struct DataPartView: View {
    let part: DataPart

    var body: some View {
        switch part.name {
        case "run-error", "bot-error":
            InlineErrorView(text: part.data["message"]?.stringValue ?? "Something went wrong.")
        case "speaker":
            HStack(spacing: 8) {
                BotIdentityView(botId: part.data["botId"]?.stringValue, icon: part.data["avatar"]?.stringValue, size: 22)
                Text(part.data["name"]?.stringValue ?? "Bot")
                    .font(.subheadline.weight(.semibold))
            }
            .padding(.top, 4)
        default:
            EmptyView()
        }
    }
}
