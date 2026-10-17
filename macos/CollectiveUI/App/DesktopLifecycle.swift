import AppKit

/// Desktop focus changes save drafts without ending a server reply.
@MainActor
final class DesktopLifecycle: NSObject, NSApplicationDelegate {
    weak var app: AppModel?

    func applicationWillResignActive(_ notification: Notification) {
        app?.conversationStates.flush()
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        app?.cancelSignIn()
        app?.conversationStates.flush()
        return .terminateNow
    }
}
