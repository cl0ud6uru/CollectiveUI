import SwiftUI
import CollectiveKit

@MainActor
struct DesktopChatView: View {
    @Environment(DesktopWorkspace.self) private var workspace
    @State private var model: ChatModel

    init(app: AppModel, conversationId: String, target: TargetOption?) {
        _model = State(initialValue: ChatModel(app: app, conversationId: conversationId, newChatTarget: target))
    }

    var body: some View {
        @Bindable var workspace = workspace
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                BotIdentityView(botId: model.target?.kind == "bot" ? model.target?.id : nil,
                    icon: model.assistantIcon, size: 36, activity: model.avatarActivity)
                VStack(alignment: .leading, spacing: 4) {
                    Text(model.assistantName).font(.headline)
                    Text(model.statusLabel).font(.callout).foregroundStyle(PortalTheme.muted)
                }
                Spacer()
                if model.isStreaming {
                    ProgressView().controlSize(.small).accessibilityLabel(model.statusLabel)
                }
            }.padding(.horizontal, DesktopLayout.pageInset).padding(.vertical, 14)
            DesktopTranscriptView(model: model)
            DesktopRecoveryView(model: model)
            DesktopComposerView(model: model)
        }
        .background(PortalTheme.background).foregroundStyle(PortalTheme.ink)
        .navigationTitle(model.displayTitle)
        .inspector(isPresented: $workspace.showInspector) {
            DesktopInspectorView(model: model).inspectorColumnWidth(min: 220, ideal: 280, max: 380)
        }
        .task {
            workspace.chat = model
            await model.activate()
            await model.refreshDelegatedApprovals()
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(5)) } catch { break }
                await model.refreshDelegatedApprovals()
            }
        }
        .onDisappear {
            model.deactivate()
            if workspace.chat === model { workspace.chat = nil }
        }
        .background {
            DesktopWindowObserver {
                model.deactivate()
                if workspace.chat === model { workspace.chat = nil }
            }
        }
    }

}
