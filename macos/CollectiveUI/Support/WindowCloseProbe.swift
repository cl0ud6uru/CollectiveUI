import AppKit

@MainActor
final class WindowCloseProbe: NSView {
    var onClose: @MainActor () -> Void

    init(onClose: @escaping @MainActor () -> Void) {
        self.onClose = onClose
        super.init(frame: .zero)
    }

    required init?(coder: NSCoder) { return nil }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        detach()
        if let window {
            NotificationCenter.default.addObserver(self, selector: #selector(windowClosing),
                name: NSWindow.willCloseNotification, object: window)
        }
    }

    func detach() { NotificationCenter.default.removeObserver(self) }

    @objc private func windowClosing(_ notification: Notification) { onClose() }
}
