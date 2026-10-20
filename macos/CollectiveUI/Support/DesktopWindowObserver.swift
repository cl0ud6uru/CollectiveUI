import SwiftUI

/// Hooks the actual scene window, so closing Settings never cancels the main window.
@MainActor
struct DesktopWindowObserver: NSViewRepresentable {
    var onClose: @MainActor () -> Void

    func makeNSView(context: Context) -> WindowCloseProbe { WindowCloseProbe(onClose: onClose) }
    func updateNSView(_ view: WindowCloseProbe, context: Context) { view.onClose = onClose }
    static func dismantleNSView(_ view: WindowCloseProbe, coordinator: ()) { view.detach() }
}
