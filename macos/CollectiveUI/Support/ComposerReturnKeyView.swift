import AppKit

@MainActor
final class ComposerReturnKeyView: NSView {
    var onReturn: @MainActor () -> Bool
    private var monitor: Any?

    init(onReturn: @escaping @MainActor () -> Bool) {
        self.onReturn = onReturn
        super.init(frame: .zero)
    }

    required init?(coder: NSCoder) { return nil }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        stopMonitoring()
        guard window != nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            // AppKit delivers local monitors on the main thread, before text input.
            MainActor.assumeIsolated {
                guard let self else { return event }
                return self.handle(event)
            }
        }
    }

    func stopMonitoring() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
    }

    func handle(_ event: NSEvent) -> NSEvent? {
        guard let window, event.windowNumber == window.windowNumber,
              event.type == .keyDown,
              [36, 76].contains(event.keyCode), // Return and keypad Enter.
              event.modifierFlags.intersection([.shift, .command, .option, .control]).isEmpty,
              let editor = window.firstResponder as? NSTextView,
              editor.isEditable, !editor.isFieldEditor,
              editor.accessibilityIdentifier() == "chat.composer",
              !editor.hasMarkedText() else { return event }

        // Leave composition and Shift+Enter to the native editor. Consume repeats
        // even when Send is unavailable so holding Enter cannot submit twice or
        // unexpectedly append newlines to the next draft.
        if event.isARepeat { return nil }
        return onReturn() ? nil : event
    }
}
