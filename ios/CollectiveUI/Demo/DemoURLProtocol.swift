#if DEBUG
import Foundation
import CollectiveKit

/// A response from the in-memory demo server.
enum DemoResponse {
    case immediate(status: Int, contentType: String?, body: Data)
    case stream([DemoStreamEvent])
}

/// One piece of a streamed (SSE) body, sent `delay` seconds after the previous one.
struct DemoStreamEvent {
    let delay: TimeInterval
    let payload: String
    var record: DemoStreamRecord? = nil
}

struct DemoStreamRecord {
    let conversationId: String
    let messageId: String
    let chunk: JSONValue
}

/// Delivers streamed chunks on the URL loading thread's run loop and remembers cancellation.
final class DemoDelivery: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    private weak var target: DemoURLProtocol?
    let runLoop: CFRunLoop

    init(target: DemoURLProtocol, runLoop: CFRunLoop) {
        self.target = target
        self.runLoop = runLoop
    }

    var isCancelled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return cancelled
    }

    func cancel() {
        lock.lock()
        cancelled = true
        lock.unlock()
    }

    func deliver(_ data: Data, finish: Bool, record: DemoStreamRecord?) {
        guard !isCancelled, let target else { cancel(); return }
        if let record, !DemoServer.shared.recordDelivery(record) { cancel(); return }
        target.emit(data, finish: finish)
    }

    func schedule(_ events: [DemoStreamEvent], startingAt index: Int = 0) {
        guard !isCancelled, events.indices.contains(index) else { return }
        let event = events[index]
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + event.delay) { [weak self] in
            guard let self, !self.isCancelled else { return }
            CFRunLoopPerformBlock(self.runLoop, CFRunLoopMode.defaultMode.rawValue, {
                // Schedule the next event only after this callback has reached the
                // loading thread. Concurrent timers can otherwise reorder chunks.
                self.deliver(Data(event.payload.utf8), finish: index == events.count - 1, record: event.record)
                self.schedule(events, startingAt: index + 1)
            })
            CFRunLoopWakeUp(self.runLoop)
        }
    }
}

/// Answers every request to `DemoMode.host` from `DemoServer`.
final class DemoURLProtocol: URLProtocol {
    private var delivery: DemoDelivery?

    override class func canInit(with request: URLRequest) -> Bool {
        return request.url?.host == DemoMode.host
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        return request
    }

    override func startLoading() {
        guard let url = request.url else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL))
            return
        }
        let reply = DemoServer.shared.handle(request)
        switch reply {
        case .immediate(let status, let contentType, let body):
            var headers: [String: String] = [:]
            if let contentType {
                headers["Content-Type"] = contentType
            }
            if let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers) {
                client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            }
            if !body.isEmpty {
                client?.urlProtocol(self, didLoad: body)
            }
            client?.urlProtocolDidFinishLoading(self)
        case .stream(let events):
            let headers = [
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
            ]
            if let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers) {
                client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            }
            schedule(events)
        }
    }

    override func stopLoading() {
        delivery?.cancel()
    }

    /// Called on the loading thread's run loop.
    func emit(_ data: Data, finish: Bool) {
        if !data.isEmpty {
            client?.urlProtocol(self, didLoad: data)
        }
        if finish {
            client?.urlProtocolDidFinishLoading(self)
        }
    }

    private func schedule(_ events: [DemoStreamEvent]) {
        guard !events.isEmpty else {
            client?.urlProtocolDidFinishLoading(self)
            return
        }
        // URLProtocol clients expect callbacks on the thread that started loading, so each chunk is
        // handed back to that thread's run loop after its delay.
        let delivery = DemoDelivery(target: self, runLoop: CFRunLoopGetCurrent())
        self.delivery = delivery
        delivery.schedule(events)
    }
}
#endif
