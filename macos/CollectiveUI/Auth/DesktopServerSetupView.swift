import SwiftUI
import CollectiveKit

@MainActor
struct DesktopServerSetupView: View {
    @Environment(AppModel.self) private var app
    @State private var address = ""
    @State private var checking = false
    @State private var errorText: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Label("CollectiveUI", systemImage: "bubble.left.and.bubble.right")
                    .font(.largeTitle)
                Text("Connect to your server").font(.title2)
                Text("Enter the address you use in your browser. HTTPS is added automatically.")
                    .foregroundStyle(.secondary)
                TextField("Server address", text: $address, prompt: Text("ai.example.com"))
                    .textFieldStyle(.roundedBorder).onSubmit(connect)
                    .accessibilityIdentifier("setup.address")
                if let errorText { Label(errorText, systemImage: "exclamationmark.triangle").foregroundStyle(.red) }
                HStack {
                    if checking { ProgressView().controlSize(.small) }
                    Button(checking ? "Checking…" : "Continue", action: connect)
                        .buttonStyle(.borderedProminent)
                        .disabled(checking || address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .padding(32).frame(maxWidth: 500).frame(maxWidth: .infinity)
        }
        .onAppear { address = app.lastServerAddress ?? "" }
    }

    private func connect() {
        guard !checking else { return }
        checking = true
        errorText = nil
        let input = address
        Task {
            defer { checking = false }
            do {
                let (url, info) = try await app.checkServer(input)
                guard !Task.isCancelled, app.phase == .setup else { return }
                guard info.enabled else {
                    errorText = "Native sign-in is disabled. Ask your administrator to enable MOBILE_APP_ENABLED."
                    return
                }
                app.useServer(url, info: info)
            } catch { errorText = error.localizedDescription }
        }
    }
}
