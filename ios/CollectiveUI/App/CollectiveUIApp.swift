import SwiftUI

@main
@MainActor
struct CollectiveUIApp: App {
    @AppStorage("appearance") private var appearance: AppAppearance = .system
    @Environment(\.scenePhase) private var scenePhase
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
                .onOpenURL { url in Task { await model.liveActivities.open(url) } }
                .onChange(of: scenePhase) { _, phase in model.liveActivities.foreground(phase == .active) }
                .preferredColorScheme(appearance.colorScheme)
                .background(PortalTheme.background.ignoresSafeArea())
                .tint(PortalTheme.ink)
                .foregroundStyle(PortalTheme.ink)
        }
    }
}
