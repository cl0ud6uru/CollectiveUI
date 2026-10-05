import SwiftUI
import CollectiveKit

@MainActor
struct ServerSetupView: View {
    @Environment(AppModel.self) private var model
    @State private var address: String = ""
    @State private var isChecking: Bool = false
    @State private var errorText: String? = nil
    @FocusState private var fieldFocused: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(spacing: 10) {
                        Image(systemName: "bubble.left.and.bubble.right.fill")
                            .font(.system(size: 44))
                            .foregroundStyle(Color.accentColor)
                        Text("Connect to your CollectiveUI server")
                            .font(.headline)
                            .multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .listRowBackground(Color.clear)
                }

                Section {
                    TextField("ai.example.com", text: $address)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.go)
                        .focused($fieldFocused)
                        .onSubmit {
                            connect()
                        }
                } header: {
                    Text("Server address")
                } footer: {
                    Text("Use the address you open CollectiveUI with in a browser. https:// is added automatically.")
                }

                if let errorText {
                    Section {
                        Label(errorText, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                    }
                }

                Section {
                    Button {
                        connect()
                    } label: {
                        HStack {
                            Spacer()
                            if isChecking {
                                ProgressView()
                            } else {
                                Text("Continue")
                                    .bold()
                            }
                            Spacer()
                        }
                    }
                    .disabled(isChecking || address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .navigationTitle("Welcome")
        }
        .onAppear {
            if address.isEmpty, let last = model.lastServerAddress {
                address = last
            }
            fieldFocused = address.isEmpty
        }
    }

    private func connect() {
        guard !isChecking else { return }
        let input = address
        errorText = nil
        isChecking = true
        Task {
            do {
                let result = try await model.checkServer(input)
                if result.1.enabled {
                    model.useServer(result.0, info: result.1)
                } else {
                    errorText = "Mobile sign-in is turned off on this server. Ask your administrator to set MOBILE_APP_ENABLED=true."
                }
            } catch {
                errorText = ServerSetupView.describe(error)
            }
            isChecking = false
        }
    }

    static func describe(_ error: Error) -> String {
        if let apiError = error as? APIError {
            switch apiError {
            case .invalidURL:
                return "Enter a server address such as ai.example.com."
            case .server(let status, _, _) where status == 404:
                return "This server doesn't support the mobile app. It may need a newer version of CollectiveUI."
            case .decoding:
                return "No CollectiveUI server was found at that address."
            default:
                return apiError.localizedDescription
            }
        }
        return error.localizedDescription
    }
}
