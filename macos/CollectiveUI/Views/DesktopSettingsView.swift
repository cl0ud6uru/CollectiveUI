import SwiftUI
import CollectiveKit

@MainActor
struct DesktopSettingsView: View {
    @Environment(AppModel.self) private var app
    @AppStorage("desktopAppearance") private var appearance = "system"
    @State private var confirmSignOut = false
    @State private var signingOut = false

    var body: some View {
        Form {
            Section("Appearance on this Mac") {
                Picker("Appearance", selection: $appearance) {
                    Text("System").tag("system")
                    Text("Light").tag("light")
                    Text("Dark").tag("dark")
                }
            }
            Section("Server & Session") {
                LabeledContent("Server", value: app.serverURL?.absoluteString ?? "No server selected").textSelection(.enabled)
                if app.phase == .main {
                    LabeledContent("Account", value: app.sessionInfo?.user?.name ?? "Validating session…")
                    LabeledContent("Device", value: app.sessionInfo?.deviceName ?? "This Mac")
                    if let expires = app.sessionInfo?.expiresAt { LabeledContent("Expires") { Text(expires, format: .dateTime) } }
                    if app.sessionInfo == nil {
                        Text("Session details could not be verified. Reload to try again.").foregroundStyle(.secondary)
                        Button("Reload Session") { Task { await app.loadSessionInfo() } }
                    }
                    Button(signingOut ? "Signing Out…" : "Sign Out", role: .destructive) { confirmSignOut = true }
                        .disabled(signingOut).accessibilityIdentifier("settings.signout")
                } else if app.serverURL != nil { Button("Change Server", action: app.changeServer) }
            }
            Section {
                Text("Account security, permissions, integrations and administration are managed on your server's website.")
                    .foregroundStyle(.secondary)
                if !app.isDemoSession, let server = app.serverURL,
                   let url = SettingsDestination.general.url(server: server, isAdmin: false) {
                    Link("Open Server Settings", destination: url)
                    Text("The website uses its own sign-in session.").font(.caption).foregroundStyle(.secondary)
                }
                if app.isDemoSession { Text("Offline fixture session — production credentials are not accessed.") }
            }
        }
        .formStyle(.grouped).padding().frame(width: 520, height: 480)
        .task(id: app.settingsAccess.generation) { await app.loadSessionInfo() }
        .alert("Sign out of this Mac?", isPresented: $confirmSignOut) {
            Button("Sign Out", role: .destructive) {
                signingOut = true
                Task { await app.signOut(); signingOut = false }
            }
            Button("Cancel", role: .cancel) {}
        } message: { Text("This revokes the native session and clears its saved drafts. Your browser remains signed in.") }
    }
}
