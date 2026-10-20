import AppKit

@MainActor
final class ScrollProbe: NSView {
    var observe: @MainActor (Double, Bool) -> Void
    private weak var scrollView: NSScrollView?
    private var liveScrolling = false
    private var eventMonitor: Any?
    private var settleInput: Task<Void, Never>?

    init(observe: @escaping @MainActor (Double, Bool) -> Void) {
        self.observe = observe
        super.init(frame: .zero)
    }

    required init?(coder: NSCoder) { return nil }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        attach()
    }

    override func viewDidMoveToSuperview() {
        super.viewDidMoveToSuperview()
        attach()
    }

    private func attach() {
        guard window != nil else { detach(); return }
        guard enclosingScrollView !== scrollView else { return }
        detach()
        guard let scrollView = enclosingScrollView else { return }
        self.scrollView = scrollView
        scrollView.contentView.postsBoundsChangedNotifications = true
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(boundsChanged), name: NSView.boundsDidChangeNotification, object: scrollView.contentView)
        center.addObserver(self, selector: #selector(startedScrolling), name: NSScrollView.willStartLiveScrollNotification, object: scrollView)
        center.addObserver(self, selector: #selector(endedScrolling), name: NSScrollView.didEndLiveScrollNotification, object: scrollView)
        eventMonitor = NSEvent.addLocalMonitorForEvents(matching: [.scrollWheel, .keyDown]) { [weak self] event in
            // AppKit delivers local event monitors on the main thread.
            MainActor.assumeIsolated { self?.observeInput(event) }
            return event
        }
    }

    func detach() {
        NotificationCenter.default.removeObserver(self)
        if let eventMonitor { NSEvent.removeMonitor(eventMonitor) }
        eventMonitor = nil
        settleInput?.cancel()
        settleInput = nil
        scrollView = nil
        liveScrolling = false
    }

    private var distance: Double {
        guard let scrollView, let document = scrollView.documentView else { return 0 }
        let visible = scrollView.documentVisibleRect
        return max(0, Double(document.isFlipped
            ? document.bounds.maxY - visible.maxY : visible.minY - document.bounds.minY))
    }

    private func observeInput(_ event: NSEvent) {
        guard let scrollView, event.window === scrollView.window else { return }
        switch event.type {
        case .scrollWheel:
            guard scrollView.bounds.contains(scrollView.convert(event.locationInWindow, from: nil)) else { return }
        case .keyDown:
            // Composer typing and menu shortcuts must never pause transcript following.
            guard [115, 116, 119, 121, 125, 126].contains(event.keyCode),
                  event.modifierFlags.intersection([.command, .control]).isEmpty,
                  let responder = scrollView.window?.firstResponder as? NSView,
                  responder.isDescendant(of: scrollView) else { return }
        default: return
        }
        observe(distance, true)
        settleInput?.cancel()
        settleInput = Task { [weak self] in
            await Task.yield()
            guard !Task.isCancelled, let self, self.scrollView != nil else { return }
            self.observe(self.distance, self.liveScrolling)
        }
    }

    @objc private func startedScrolling(_ notification: Notification) {
        liveScrolling = true
        observe(distance, true)
    }

    @objc private func endedScrolling(_ notification: Notification) {
        liveScrolling = false
        observe(distance, false)
    }

    @objc private func boundsChanged(_ notification: Notification) {
        observe(distance, liveScrolling)
    }
}
