import SwiftUI
import CollectiveKit

@MainActor
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var isSigningOut: Bool = false

    private var user: User? {
        return model.shell?.user ?? model.sessionInfo?.user
    }

    var body: some View {
        NavigationStack {
            Form {
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
