import SwiftUI
import UIKit

/// Native equivalents of src/app/globals.css. Color is reserved for bot identity and activity.
enum PortalTheme {
    static let background = adaptive("ffffff", "181818")
    static let sidebar = adaptive("f9f9f9", "111111")
    static let surface = adaptive("ffffff", "262626")
    static let surfaceSecondary = adaptive("f4f4f4", "2a2a2a")
    static let botBubble = adaptive("f0f0f0", "262626")
    static let ink = adaptive("0d0d0d", "ececec")
    static let onInk = adaptive("ffffff", "111111")
    static let muted = adaptive("5d5d5d", "a8a8a8")
    static let subtle = adaptive("8f8f8f", "7f7f7f")
    static let border = adaptive("e5e5e5", "303030")
    static let working = adaptive("7c3aed", "a78bfa")
    static let warning = adaptive("c2410c", "fbbf24")
    static let success = adaptive("2f7d5e", "4ade80")
    static let danger = adaptive("e02e2a", "f06a66")

    static func adaptive(_ light: String, _ dark: String) -> Color {
        Color(uiColor: UIColor { traits in
            let value = UInt32(traits.userInterfaceStyle == .dark ? dark : light, radix: 16) ?? 0
            return UIColor(red: CGFloat((value >> 16) & 255) / 255,
                           green: CGFloat((value >> 8) & 255) / 255,
                           blue: CGFloat(value & 255) / 255, alpha: 1)
        })
    }

    /// Matches bubbleTint() on the website, including its contrast-adjusted colors.
    static func bubbleTint(_ icon: String?) -> (background: Color, foreground: Color) {
        guard let icon, icon.hasPrefix("blob:"), let name = icon.split(separator: ":").last else {
            return (ink, onInk)
        }
        let colors: [String: (String, String)] = [
            "purple": ("8457ea", "ffffff"), "pink": ("cb3e84", "ffffff"),
            "blue": ("3472d8", "ffffff"), "red": ("d53d3d", "ffffff"),
            "orange": ("f97316", "111111"), "yellow": ("eab308", "111111"),
            "teal": ("14b8a6", "111111"), "grey": ("9ca3af", "111111"),
        ]
        guard let pair = colors[String(name)] else { return (ink, onInk) }
        return (Color(hex: pair.0), Color(hex: pair.1))
    }
}

struct PortalMark: View {
    var size: CGFloat = 28

    var body: some View {
        ZStack {
            Circle().fill(PortalTheme.ink)
            HStack(spacing: size * 0.09) {
                ForEach(0..<2) { _ in
                    Capsule().fill(PortalTheme.onInk)
                        .frame(width: size * 0.09, height: size * 0.2)
                        .rotationEffect(.degrees(-14))
                }
            }
            .offset(y: -size * 0.04)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

struct PortalIconButton: View {
    let label: String
    let symbol: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 18, weight: .regular))
                .frame(width: 44, height: 44)
                .contentShape(RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .foregroundStyle(PortalTheme.muted)
        .accessibilityLabel(label)
        .accessibilityActivationPoint(.center)
    }
}

/// A material surface that also respects Reduce Transparency on older supported iOS versions.
struct ChatGlass: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    var cornerRadius: CGFloat = 24

    func body(content: Content) -> some View {
        content
            .background {
                if reduceTransparency {
                    RoundedRectangle(cornerRadius: cornerRadius).fill(PortalTheme.surfaceSecondary)
                } else {
                    RoundedRectangle(cornerRadius: cornerRadius).fill(.thinMaterial)
                }
            }
            .overlay {
                RoundedRectangle(cornerRadius: cornerRadius)
                    .strokeBorder(PortalTheme.ink.opacity(0.16), lineWidth: 0.5)
                    .allowsHitTesting(false)
            }
    }
}
