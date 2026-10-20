import SwiftUI
import CollectiveKit

@MainActor
struct DesktopMainView: View {
    @Environment(AppModel.self) private var app
    @State private var workspace = DesktopWorkspace()
    @State private var columns = NavigationSplitViewVisibility.all
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        NavigationSplitView(columnVisibility: $columns) {
            DesktopSidebarView()
                .navigationSplitViewColumnWidth(min: 220, ideal: 264, max: 380)
        } detail: {
            DesktopConversationView()
        }
        .environment(workspace)
        .tint(PortalTheme.ink)
        .focusedSceneValue(\.desktopWorkspace, workspace)
        .sheet(isPresented: $workspace.showNewChat) { DesktopNewChatView() }
        .toolbar {
            ToolbarItemGroup {
                Button("New Chat", systemImage: "square.and.pencil") { workspace.showNewChat = true }
                    .help("New chat (⌘N)")
                Button("Activity Inspector", systemImage: "sidebar.right") { workspace.showInspector.toggle() }
                    .disabled(workspace.chat == nil).help("Activity inspector (⌥⌘I)")
            }
        }
        .task {
            await app.refreshShell()
            #if DEBUG
            if app.isDemoSession, let id = DemoMode.openConversationId { app.openConversation(id) }
            #endif
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(15)) } catch { break }
                if scenePhase == .active { await app.refreshBotStatuses() }
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await app.refreshShell() } }
            else { app.conversationStates.flush() }
        }
    }
}
