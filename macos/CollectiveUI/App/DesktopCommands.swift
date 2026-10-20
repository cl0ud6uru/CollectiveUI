import SwiftUI

@MainActor
struct DesktopCommands: Commands {
    @Environment(\.openWindow) private var openWindow
    @FocusedValue(\.desktopWorkspace) private var workspace

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("New Chat…", systemImage: "square.and.pencil") { workspace?.showNewChat = true }
                .keyboardShortcut("n")
                .disabled(workspace == nil)
        }
        SidebarCommands()
        CommandGroup(after: .windowList) {
            Button("Show Main Window") { openWindow(id: "main") }
                .keyboardShortcut("0")
        }
        CommandMenu("Conversation") {
            Button("Send Message") { workspace?.chat?.send() }
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(workspace?.chat?.canSend != true)
            Button("Stop Reply") { workspace?.chat?.stop() }
                .keyboardShortcut(".", modifiers: .command)
                .disabled(workspace?.chat == nil || workspace?.chat?.isStopping == true ||
                    workspace?.chat?.isStreaming != true)
            Button("Check Message Status") {
                if let chat = workspace?.chat { Task { await chat.checkMessageStatus() } }
            }
            .disabled(workspace?.chat?.needsMessageStatusCheck != true || workspace?.chat?.isCheckingMessageStatus == true)
            Divider()
            Button("Show Activity Inspector", systemImage: "sidebar.right") { workspace?.showInspector.toggle() }
                .keyboardShortcut("i", modifiers: [.command, .option])
                .disabled(workspace?.chat == nil)
        }
    }
}
