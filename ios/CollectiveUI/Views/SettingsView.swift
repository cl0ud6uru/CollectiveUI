import SwiftUI
import CollectiveKit

@MainActor
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("appearance") private var appearance: AppAppearance = .system
    @State private var section = "General"
    @State private var path: [SettingsDestination] = []
    @State private var browser: BrowserDestination?
    @State private var isSigningOut = false
    @State private var isOpening = false
    @State private var confirmSignOut = false
    @State private var openingError: String?

    private struct BrowserDestination: Identifiable {
        let id = UUID()
        let destination: SettingsDestination
        let url: URL
    }
    private var user: User? { model.sessionInfo?.user ?? model.shell?.user }
    private var destinations: [SettingsDestination] {
        SettingsDestination.available(isAdmin: model.settingsAccess.isAdmin)
            .filter { section == "Admin" ? $0.isAdminOnly : !$0.isAdminOnly }
    }

    var body: some View {
        NavigationStack(path: $path) {
            VStack(spacing: 0) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        sectionButton("General", symbol: "slider.horizontal.3")
                        sectionButton("Account", symbol: "person.crop.circle")
                        if model.settingsAccess.isAdmin { sectionButton("Admin", symbol: "shield") }
                    }.padding(.horizontal, 20).padding(.vertical, 10)
                }
                ScrollView {
                    VStack(alignment: .leading, spacing: 24) {
                        if section == "General" {
                            card("Appearance", detail: "Choose how this device looks.") {
                                Picker("Color scheme", selection: $appearance) {
                                    ForEach(AppAppearance.allCases) { Text($0.label).tag($0) }
                                }.pickerStyle(.segmented)
                            }
                            card("Live Activities", detail: "Private task status on your Lock Screen and Dynamic Island.") {
                                Toggle("Show bot status", isOn: Binding(get: { model.liveActivities.enabled }, set: { value in
                                    Task { await model.liveActivities.setEnabled(value) }
                                }))
                                Text("Shows your pet and generic status only. Task text stays private.")
                                    .font(.footnote).foregroundStyle(PortalTheme.muted)
                                Text(model.liveActivities.availability).font(.footnote).foregroundStyle(PortalTheme.muted)
                            }
                        }
                        if section == "Account" {
                            card("Signed in", detail: "Your native app session") {
                                accountFact("Name", user?.name ?? "—")
                                accountFact("Email", user?.email ?? "—")
                                accountFact("Server", model.serverURL?.absoluteString ?? "—")
                                accountFact("Device", model.sessionInfo?.deviceName ?? "—")
                                accountFact("Expires", model.sessionInfo?.expiresAt?.formatted(date: .abbreviated, time: .shortened) ?? "—")
                                Text("Signing out here does not sign out the website browser. It may use a different account.")
                                    .font(.footnote).foregroundStyle(PortalTheme.muted)
                                Button("Sign out", role: .destructive) { confirmSignOut = true }
                                    .frame(minHeight: 44).disabled(isSigningOut)
                            }
                        } else {
                            VStack(alignment: .leading, spacing: 8) {
                                Text(section == "Admin" ? "Organization" : "Website settings").font(.headline)
                                Text("Web sign-in may be required. These controls open on your configured server; the website checks your account and permissions.")
                                    .font(.footnote).foregroundStyle(PortalTheme.muted)
                            }
                            VStack(spacing: 0) {
                                ForEach(destinations) { destination in
                                    NavigationLink(value: destination) {
                                        destinationRow(destination)
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityIdentifier("settings." + destination.id)
                                    if destination != destinations.last { Divider().overlay(PortalTheme.border).padding(.leading, 50) }
                                }
                            }
                            .background(PortalTheme.surface, in: RoundedRectangle(cornerRadius: 16))
                            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(PortalTheme.border, lineWidth: 1))
                        }
                        if !model.settingsAccess.isValidated {
                            VStack(alignment: .leading, spacing: 8) {
                                Text("Administrator access requires a current session check.").font(.footnote).foregroundStyle(PortalTheme.muted)
                                Button("Refresh access") { Task { await model.loadSessionInfo() } }.frame(minHeight: 44)
                            }
                        }
                        Text(versionText).font(.caption).foregroundStyle(PortalTheme.subtle)
                    }
                    .frame(maxWidth: 720, alignment: .leading)
                    .padding(20).frame(maxWidth: .infinity)
                }
                .accessibilityIdentifier("settings.content")
            }
            .background(PortalTheme.background)
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .navigationDestination(for: SettingsDestination.self) { destination in
                destinationDetail(destination)
            }
        }
        .tint(PortalTheme.ink)
        .fullScreenCover(item: $browser, onDismiss: refreshAfterBrowser) { target in
            SettingsBrowser(url: target.url).ignoresSafeArea()
        }
        .task {
            await model.loadSessionInfo()
            #if DEBUG
            if model.isDemoSession, DemoMode.value(after: "--demo-settings-section") == "admin", model.settingsAccess.isAdmin {
                section = "Admin"
            }
            #endif
        }
        .onChange(of: model.settingsAccess.generation) { _, _ in
            browser = nil; path = []; section = "General"; openingError = nil
        }
        .onChange(of: model.settingsAccess.isAdmin) { _, isAdmin in
            if !isAdmin && !isOpening {
                if section == "Admin" { section = "General" }
                if path.contains(where: \.isAdminOnly) { path = [] }
                if browser?.destination.isAdminOnly == true { browser = nil }
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { refreshAfterBrowser() }
        }
        .confirmationDialog("Sign out of this app?", isPresented: $confirmSignOut, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) {
                isSigningOut = true
                Task { await model.signOut(); isSigningOut = false; dismiss() }
            }
        } message: { Text("Your device session and local drafts will be removed. Website sessions are separate.") }
    }

    private func sectionButton(_ title: String, symbol: String) -> some View {
        Button { section = title } label: {
            Label(title, systemImage: symbol).font(.subheadline.weight(section == title ? .semibold : .regular))
                .padding(.horizontal, 14).frame(minHeight: 44)
                .background(section == title ? PortalTheme.surfaceSecondary : Color.clear, in: RoundedRectangle(cornerRadius: 10))
        }.buttonStyle(.plain).accessibilityIdentifier("settings.section." + title.lowercased())
            .accessibilityAddTraits(section == title ? [.isSelected] : [])
    }

    private func card<Content: View>(_ title: String, detail: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                Text(title).font(.headline)
                Text(detail).font(.footnote).foregroundStyle(PortalTheme.muted)
            }
            content()
        }.frame(maxWidth: .infinity, alignment: .leading).padding(18)
            .background(PortalTheme.surface, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(PortalTheme.border, lineWidth: 1))
    }

    private func accountFact(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.caption).foregroundStyle(PortalTheme.muted)
            Text(value).font(.subheadline).textSelection(.enabled)
        }
    }

    private func destinationRow(_ destination: SettingsDestination) -> some View {
        HStack(alignment: .center, spacing: 14) {
            Image(systemName: destination.symbol).font(.body).frame(width: 22).foregroundStyle(PortalTheme.muted)
            VStack(alignment: .leading, spacing: 4) {
                Text(destination.title).font(.subheadline.weight(.medium))
                Text(destination.detail).font(.caption).foregroundStyle(PortalTheme.muted).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 4)
            Image(systemName: "chevron.right").font(.caption).foregroundStyle(PortalTheme.subtle)
        }.padding(16).frame(minHeight: 64).contentShape(Rectangle())
    }

    private func destinationDetail(_ destination: SettingsDestination) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Image(systemName: destination.symbol).font(.largeTitle).foregroundStyle(PortalTheme.muted).accessibilityHidden(true)
                Text(destination.title).font(.title2.weight(.semibold))
                Text(destination.detail).foregroundStyle(PortalTheme.muted)
                if let server = model.serverURL, let url = destination.url(server: server, isAdmin: model.settingsAccess.isAdmin) {
                    card("On your website", detail: "Web sign-in may be required") {
                        Text(url.absoluteString).font(.footnote).textSelection(.enabled).accessibilityIdentifier("settings.destinationURL")
                        Text("The browser may be signed in as a different account. Check the website account before making changes. Your app session is not transferred.")
                            .font(.footnote).foregroundStyle(PortalTheme.muted)
                        if model.isDemoSession {
                            Text("Offline demo — website controls are unavailable. No browser or network request will be opened.")
                                .font(.footnote).accessibilityIdentifier("settings.offline")
                        } else {
                            Button { Task { await openWebsite(destination) } } label: {
                                Label(isOpening ? "Checking access…" : "Open website", systemImage: "arrow.up.right.square")
                                    .frame(maxWidth: .infinity).frame(minHeight: 44)
                            }.buttonStyle(.borderedProminent).tint(PortalTheme.ink).foregroundStyle(PortalTheme.onInk)
                                .disabled(isOpening).accessibilityIdentifier("settings.openWebsite")
                        }
                    }
                } else { Text("This destination is not available for the current session.").foregroundStyle(PortalTheme.muted) }
                if let openingError { Text(openingError).font(.footnote).foregroundStyle(PortalTheme.danger) }
            }.frame(maxWidth: 720, alignment: .leading).padding(24).frame(maxWidth: .infinity)
        }.background(PortalTheme.background).navigationBarTitleDisplayMode(.inline)
    }

    private func openWebsite(_ destination: SettingsDestination) async {
        guard !isOpening, !model.isDemoSession else { return }
        isOpening = true; openingError = nil
        defer { isOpening = false }
        let generation = model.settingsAccess.generation
        // Admin controls require a fresh role, even if their row was visible earlier.
        if destination.isAdminOnly { await model.loadSessionInfo() }
        guard model.settingsAccess.generation == generation, model.token != nil,
              let server = model.serverURL,
              let url = destination.url(server: server, isAdmin: model.settingsAccess.isAdmin) else {
            openingError = "Access could not be verified. Refresh your session and try again."
            return
        }
        browser = BrowserDestination(destination: destination, url: url)
    }

    private func refreshAfterBrowser() {
        Task { await model.loadSessionInfo(); await model.refreshShell() }
    }

    private var versionText: String {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "1.0"
        let build = info?["CFBundleVersion"] as? String ?? "1"
        return "CollectiveUI for iOS \(version) (\(build))"
    }
}
