import SwiftUI

@MainActor
struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        ZStack(alignment: .top) {
            switch model.phase {
            case .setup:
                ServerSetupView()
            case .signIn:
                SignInView()
            case .main:
                MainView()
            }
            BannerOverlay()
        }
    }
}

/// Transient toast shown at the top of the window for notices and errors.
@MainActor
struct BannerOverlay: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack {
            if let banner = model.banner {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: banner.isError ? "exclamationmark.triangle.fill" : "info.circle.fill")
                        .foregroundStyle(banner.isError ? Color.white : Color.accentColor)
                    Text(banner.text)
                        .font(.subheadline)
                        .foregroundStyle(banner.isError ? Color.white : Color.primary)
                        .multilineTextAlignment(.leading)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .background(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(banner.isError ? AnyShapeStyle(Color.red.opacity(0.92)) : AnyShapeStyle(Material.regularMaterial))
                )
                .shadow(color: Color.black.opacity(0.15), radius: 8, y: 2)
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .frame(maxWidth: 600)
                .transition(.move(edge: .top).combined(with: .opacity))
                .onTapGesture {
                    model.banner = nil
                }
            }
            Spacer(minLength: 0)
        }
        .allowsHitTesting(model.banner != nil)
        .animation(.easeInOut(duration: 0.25), value: model.banner)
        .task(id: model.banner?.id) {
            await autoDismiss()
        }
    }

    private func autoDismiss() async {
        guard let shown = model.banner else { return }
        try? await Task.sleep(nanoseconds: 4_000_000_000)
        if !Task.isCancelled && model.banner?.id == shown.id {
            model.banner = nil
        }
    }
}
