import SwiftUI
import CollectiveKit

@MainActor
struct DesktopConversationView: View {
    @Environment(AppModel.self) private var app
    @Environment(DesktopWorkspace.self) private var workspace

    var body: some View {
        Group {
            switch app.selection {
            case .conversation(let id):
                DesktopChatView(app: app, conversationId: id, target: nil).id(id)
            case .newChat(let id, let target):
                DesktopChatView(app: app, conversationId: id, target: target).id(id)
            case .bot(let id, let kind, let nonce):
                DesktopBotOpener(botId: id, kind: kind).id(id + kind + nonce)
            case nil:
                VStack(spacing: 16) {
                    PortalMark(size: 56)
                    Text(app.shell?.branding.welcomeText ?? "What can I help with?").font(.title)
                    Button("New Chat", systemImage: "square.and.pencil") { workspace.showNewChat = true }
                        .buttonStyle(.bordered)
                    Text("Choose a bot in the sidebar or start a conversation with a model.").foregroundStyle(.secondary)
                }
                .padding().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(PortalTheme.background).foregroundStyle(PortalTheme.ink)
    }
}
