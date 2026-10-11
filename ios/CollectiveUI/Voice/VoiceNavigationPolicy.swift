import WebKit

struct VoiceNavigationPolicy: WebPage.NavigationDeciding {
    func decidePolicy(for action: WebPage.NavigationAction, preferences: inout WebPage.NavigationPreferences) async -> WKNavigationActionPolicy {
        action.request.url == VoiceSessionModel.engineURL ? .allow : .cancel
    }
}
