import SwiftUI
import CollectiveKit

@MainActor
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @AppStorage("appearance") private var appearance: AppAppearance = .system
    @State private var isSigningOut: Bool = false

    private var user: User? {
        return model.shell?.user ?? model.sessionInfo?.user
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Appearance") {
                    Picker("Color scheme", selection: $appearance) {
                        ForEach(AppAppearance.allCases) { Text($0.label).tag($0) }
                    }
                    .pickerStyle(.segmented)
                }

                Section("Live Activities") {
                    Toggle("Show bot status", isOn: Binding(get: { model.liveActivities.enabled }, set: { value in
                        Task { await model.liveActivities.setEnabled(value) }
                    }))
                    Text("Shows your selected pet and a generic task status on the Lock Screen and Dynamic Island. Task text stays private. Tap to open its chat.")
                        .font(.footnote).foregroundStyle(.secondary)
                    Text(model.liveActivities.availability).font(.footnote).foregroundStyle(.secondary)
                }

                Section("Account") {
                    LabeledContent("Name", value: user?.name ?? "—")
                    LabeledContent("Email", value: user?.email ?? "—")
                    if user?.isAdmin == true {
                        LabeledContent("Role", value: "Administrator")
                    }
                }

                Section("Server") {
                    LabeledContent("Address", value: model.serverURL?.absoluteString ?? "—")
                    LabeledContent("Name", value: model.appName)
                    if let shell = model.shell, !shell.hasPetMetadata {
                        Text("Update your CollectiveUI server to display custom pet avatars in the app.")
                            .font(.footnote).foregroundStyle(PortalTheme.muted)
                    }
                }

                Section("This device") {
                    LabeledContent("Device", value: deviceName)
                    LabeledContent("Session expires", value: expiryText)
                }

                Section {
                    Button(role: .destructive) {
                        signOut()
                    } label: {
                        HStack {
                            Text("Sign out")
                            Spacer()
                            if isSigningOut {
                                ProgressView()
                            }
                        }
                    }
                    .disabled(isSigningOut)
                }

                Section {
                    Text(versionText)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .scrollContentBackground(.hidden)
            .background(PortalTheme.sidebar)
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        dismiss()
                    }
                }
            }
        }
        .task {
            await model.loadSessionInfo()
        }
    }

    private var deviceName: String {
        if let name = model.sessionInfo?.deviceName, !name.isEmpty {
            return name
        }
        return "—"
    }

    private var expiryText: String {
        guard let date = model.sessionInfo?.expiresAt else { return "—" }
        return date.formatted(date: .abbreviated, time: .shortened)
    }

    private var versionText: String {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "1.0"
        let build = info?["CFBundleVersion"] as? String ?? "1"
        return "CollectiveUI for iOS \(version) (\(build))"
    }

    private func signOut() {
        isSigningOut = true
        Task {
            await model.signOut()
            isSigningOut = false
            dismiss()
        }
    }
}
