import Foundation
import WebKit

/// WKUserContentController retains its handlers; the weak model breaks that ownership cycle.
@MainActor
final class VoiceScriptHandler: NSObject, WKScriptMessageHandler, WKScriptMessageHandlerWithReply {
    weak var model: VoiceSessionModel?

    private func trusted(_ message: WKScriptMessage) -> Bool {
        message.frameInfo.isMainFrame && message.frameInfo.securityOrigin.protocol == "https"
            && message.frameInfo.securityOrigin.host == VoiceSessionModel.engineURL.host
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard trusted(message), let event = message.body as? [String: Any] else { return }
        model?.receive(event)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard trusted(message), let request = message.body as? [String: Any], let model else {
            replyHandler(nil, "Voice request denied."); return
        }
        Task {
            do { replyHandler(try await model.request(request), nil) }
            catch { replyHandler(nil, error.localizedDescription) }
        }
    }
}
