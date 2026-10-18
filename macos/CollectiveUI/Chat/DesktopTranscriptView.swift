import SwiftUI
import CollectiveKit

@MainActor
struct DesktopTranscriptView: View {
    let model: ChatModel
    @State private var scrollPolicy = ChatScrollPolicy()

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    if model.isLoading { ProgressView("Loading conversation…") }
                    if let error = model.loadError {
                        Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red)
                        Button(model.isRefreshingConversation ? "Refreshing…" : "Try Again") {
                            Task { await model.refreshConversation() }
                        }.disabled(!model.canRefreshConversation)
                    }
                    ForEach(model.messages) { message in DesktopMessageView(message: message, model: model) }
                    if model.showsTypingIndicator { ProgressView("Waiting for reply…").controlSize(.small) }
                    Color.clear.frame(height: 1).id("latest")
                        .background { DesktopScrollObserver { distance, userScrolling in
                            scrollPolicy.observe(distanceFromBottom: distance, userIsScrolling: userScrolling)
                        } }
                }
                .frame(maxWidth: DesktopLayout.transcriptWidth, alignment: .leading)
                .padding(DesktopLayout.pageInset).frame(maxWidth: .infinity)
            }
            .accessibilityIdentifier("chat.transcript")
            .onChange(of: model.scrollToken) { _, _ in
                if scrollPolicy.shouldScroll(for: model.scrollReason) { proxy.scrollTo("latest", anchor: .bottom) }
            }
            .overlay(alignment: .bottomTrailing) {
                if !scrollPolicy.followsLatest {
                    Button("Jump to Latest", systemImage: "arrow.down") {
                        scrollPolicy.jumpToLatest()
                        proxy.scrollTo("latest", anchor: .bottom)
                    }
                    .buttonStyle(.bordered).tint(PortalTheme.ink).padding()
                }
            }
        }
    }
}
