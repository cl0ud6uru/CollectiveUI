import SwiftUI

/// Keeps the standard TextEditor and its input-method, selection and undo handling.
@MainActor
struct DesktopComposerKeyHandler: NSViewRepresentable {
    var onReturn: @MainActor () -> Bool

    func makeNSView(context: Context) -> ComposerReturnKeyView {
        ComposerReturnKeyView(onReturn: onReturn)
    }

    func updateNSView(_ view: ComposerReturnKeyView, context: Context) {
        view.onReturn = onReturn
    }

    static func dismantleNSView(_ view: ComposerReturnKeyView, coordinator: ()) {
        view.stopMonitoring()
    }
}
