#if DEBUG
import Foundation
import CollectiveKit

/// Debug-only demo mode, enabled with the `--demo` launch argument.
///
/// Every request to `demo.collectiveui.app` is answered in memory by `DemoURLProtocol`, so the app
/// can be explored (and screenshotted) without a server.
///
/// Launch arguments:
/// - `--demo`: enable demo mode (signed in as a demo user).
/// - `--demo-open <conversationId>`: open a conversation on launch.
/// - `--demo-send "<text>"`: type and send a message in the opened conversation after ~1 s.
/// - `--demo-screen <inbox|settings|newchat|search|setup|signin>`: show that screen.
/// - `--demo-sidebar-collapsed`: on iPad, show only the detail column.
enum DemoMode {
    static let host = "demo.collectiveui.app"
    static let token = "cui_m_demo"
    static let isEnabled: Bool = ProcessInfo.processInfo.arguments.contains("--demo")

    static var baseURL: URL {
        return URL(string: "https://demo.collectiveui.app") ?? URL(fileURLWithPath: "/")
    }

    static var info: MobileInfo {
        return MobileInfo(enabled: true, appName: "CollectiveUI", logoEmoji: "✨", apiVersion: 1)
    }

    /// The argument that follows `flag`, if any.
    static func value(after flag: String) -> String? {
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: flag), index + 1 < arguments.count else {
            return nil
        }
        let value = arguments[index + 1]
        if value.hasPrefix("--") {
            return nil
        }
        return value
    }

    static var openConversationId: String? {
        return value(after: "--demo-open")
    }

    static var sendText: String? {
        return value(after: "--demo-send")
    }

    static var screen: String? {
        return value(after: "--demo-screen")
    }

    static var sidebarCollapsed: Bool {
        return ProcessInfo.processInfo.arguments.contains("--demo-sidebar-collapsed")
    }

    /// URLSession whose requests are served by `DemoURLProtocol`.
    static let session: URLSession = {
        let configuration = APIClient.makeConfiguration()
        configuration.protocolClasses = [DemoURLProtocol.self]
        return URLSession(configuration: configuration)
    }()
}

/// One-shot flags so launch options are applied only once per process.
@MainActor
enum DemoRuntime {
    static var launchOptionsApplied = false
    static var searchApplied = false
    static var sendConsumed = false
}
#endif
