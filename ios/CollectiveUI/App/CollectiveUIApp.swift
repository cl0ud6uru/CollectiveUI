import SwiftUI

@main
@MainActor
struct CollectiveUIApp: App {
    @AppStorage("appearance") private var appearance: AppAppearance = .system
    @State private var model: AppModel

    init() {
        #if DEBUG
        if DemoMode.isEnabled, let value = DemoMode.value(after: "--demo-appearance"), AppAppearance(rawValue: value) != nil {
            UserDefaults.standard.set(value, forKey: "appearance")
        }
        #endif
        _model = State(initialValue: AppModel())
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .preferredColorScheme(appearance.colorScheme)
                .background(PortalTheme.background.ignoresSafeArea())
                .tint(PortalTheme.ink)
                .foregroundStyle(PortalTheme.ink)
        }
    }
}
