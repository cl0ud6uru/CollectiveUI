import Observation

@MainActor
@Observable
final class DesktopWorkspace {
    var showNewChat = false
    var showInspector = false
    var chat: ChatModel?
}
