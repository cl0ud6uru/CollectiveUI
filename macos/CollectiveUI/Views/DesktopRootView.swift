import SwiftUI

@MainActor
struct DesktopRootView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        Group {
            switch app.phase {
            case .setup: DesktopServerSetupView()
            case .signIn: DesktopSignInView()
            case .main: DesktopMainView().id(app.settingsAccess.generation)
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            if let banner = app.banner {
                HStack {
                    Label(banner.text, systemImage: banner.isError ? "exclamationmark.triangle" : "info.circle")
                        .textSelection(.enabled)
                    Spacer()
                    Button("Dismiss", systemImage: "xmark") { app.banner = nil }
                        .labelStyle(.iconOnly).buttonStyle(.plain)
                }
                .padding(12)
                .background(.regularMaterial)
                .accessibilityIdentifier("app.banner")
            }
        }
        .onDisappear {
            app.cancelSignIn()
            app.conversationStates.flush()
        }
        .background {
            DesktopWindowObserver {
                app.cancelSignIn()
                app.conversationStates.flush()
            }
        }
    }
}
