import SwiftUI

@main
@MainActor
struct CollectiveUIApp: App {
    @NSApplicationDelegateAdaptor(DesktopLifecycle.self) private var lifecycle
    @State private var app: AppModel
    @State private var requestedInitialWindow = false
    @Environment(\.openWindow) private var openWindow
    @Environment(\.scenePhase) private var scenePhase
    private let preferences: UserDefaults
    @AppStorage("desktopAppearance") private var appearance = "system"

    init() {
        #if DEBUG
        let defaults = DemoMode.isEnabled
            ? UserDefaults(suiteName: "io.collectiveui.macos.demo") ?? .standard : .standard
        preferences = defaults
        _appearance = AppStorage(wrappedValue: "system", "desktopAppearance", store: defaults)
        _app = State(initialValue: AppModel(defaults: defaults))
        #else
        preferences = .standard
        _appearance = AppStorage(wrappedValue: "system", "desktopAppearance", store: .standard)
        _app = State(initialValue: AppModel())
        #endif
    }

    var body: some Scene {
        Window("CollectiveUI", id: "main") {
            DesktopRootView()
                .environment(app)
                .defaultAppStorage(preferences)
                .preferredColorScheme(colorScheme)
                .onAppear { lifecycle.app = app }
                .frame(minWidth: 760, minHeight: 520)
        }
        .defaultSize(width: 1180, height: 780)
        .windowResizability(.contentMinSize)
        .commands { DesktopCommands() }
        .onChange(of: scenePhase, initial: true) {
            // A restored single-window scene can launch with no window. Request it
            // once per process; later window closure must remain the user's choice.
            guard !requestedInitialWindow else { return }
            requestedInitialWindow = true
            openWindow(id: "main")
        }

        Settings {
            DesktopSettingsView()
                .environment(app)
                .defaultAppStorage(preferences)
                .preferredColorScheme(colorScheme)
        }
    }

    private var colorScheme: ColorScheme? {
        switch appearance {
        case "light": .light
        case "dark": .dark
        default: nil
        }
    }
}
