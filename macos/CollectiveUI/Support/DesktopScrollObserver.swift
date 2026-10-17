import SwiftUI
import AppKit

/// Observes native scrolling on macOS 14, including wheel, trackpad, keyboard, and scrollbar.
@MainActor
struct DesktopScrollObserver: NSViewRepresentable {
    var observe: @MainActor (Double, Bool) -> Void

    func makeNSView(context: Context) -> ScrollProbe {
        ScrollProbe(observe: observe)
    }

    func updateNSView(_ view: ScrollProbe, context: Context) { view.observe = observe }

    static func dismantleNSView(_ view: ScrollProbe, coordinator: ()) { view.detach() }
}
