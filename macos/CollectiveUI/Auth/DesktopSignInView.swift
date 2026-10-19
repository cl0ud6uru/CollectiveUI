import SwiftUI

@MainActor
struct DesktopSignInView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text(app.appName).font(.largeTitle)
                Text("Sign in to your server").font(.title2)
                Text(app.serverURL?.absoluteString ?? "").textSelection(.enabled).foregroundStyle(.secondary)
                Text("Sign in and approve this Mac in the secure browser. Your server controls account access and tool permissions.")
                HStack {
                    if app.isSigningIn { ProgressView().controlSize(.small) }
                    Button(app.isSigningIn ? "Signing In…" : "Sign In") { Task { await app.signIn() } }
                        .buttonStyle(.borderedProminent).disabled(app.isSigningIn || app.isDemoSession)
                        .accessibilityIdentifier("signin.button")
                    Button("Change Server") { app.changeServer() }
                }
                if app.isDemoSession { Text("Offline sign-in preview. Browser validation uses a controlled local test server.").foregroundStyle(.secondary) }
            }
            .padding(32).frame(maxWidth: 500).frame(maxWidth: .infinity)
        }
        .task { await app.loadServerInfoIfNeeded() }
    }
}
