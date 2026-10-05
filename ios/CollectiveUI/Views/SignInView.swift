import SwiftUI

@MainActor
struct SignInView: View {
    @Environment(AppModel.self) private var model

    private var emoji: String {
        if let emoji = model.serverInfo?.logoEmoji, !emoji.isEmpty {
            return emoji
        }
        return "✨"
    }

    var body: some View {
        VStack(spacing: 20) {
            Spacer()
            Text(emoji)
                .font(.system(size: 72))
            Text(model.appName)
                .font(.largeTitle.bold())
                .multilineTextAlignment(.center)
            Text(model.serverURL?.host() ?? "")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Spacer()

            Button {
                Task {
                    await model.signIn()
                }
            } label: {
                HStack(spacing: 8) {
                    if model.isSigningIn {
                        ProgressView()
                            .tint(Color.white)
                    }
                    Text("Sign in")
                }
                .font(.headline)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(model.isSigningIn)

            Text("You'll sign in on your server's web page, then approve this device.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            Button("Change server") {
                model.changeServer()
            }
            .disabled(model.isSigningIn)
            .padding(.bottom, 8)
        }
        .padding(24)
        .frame(maxWidth: 480)
        .task {
            await model.loadServerInfoIfNeeded()
        }
    }
}
