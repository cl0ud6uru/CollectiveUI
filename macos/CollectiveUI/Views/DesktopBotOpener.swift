import SwiftUI
import CollectiveKit

@MainActor
struct DesktopBotOpener: View {
    @Environment(AppModel.self) private var app
    let botId: String
    let kind: String
    @State private var conversationId: String?
    @State private var errorText: String?

    var body: some View {
        Group {
            if let conversationId { DesktopChatView(app: app, conversationId: conversationId, target: nil).id(conversationId) }
            else if let errorText {
                ContentUnavailableView {
                    Label("Couldn't open chat", systemImage: "exclamationmark.triangle")
                } description: { Text(errorText) } actions: {
                    Button("Try Again") { Task { await open() } }
                }
            } else { ProgressView("Opening conversation…") }
        }
        .task { if conversationId == nil { await open() } }
    }

    private func open() async {
        guard let api = app.api else { return }
        errorText = nil
        do {
            let id = try await api.openBotChat(botId: botId, kind: BotChatKind(rawValue: kind) ?? .home)
            guard app.api === api, !Task.isCancelled else { return }
            conversationId = id
        } catch {
            guard app.api === api, !Task.isCancelled else { return }
            if !error.isUnauthorized && !error.isCancellation { errorText = error.localizedDescription }
        }
    }
}
