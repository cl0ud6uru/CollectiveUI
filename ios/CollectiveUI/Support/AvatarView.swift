import SwiftUI

extension Color {
    /// Creates a color from `#rrggbb` / `rrggbb`. Falls back to grey for invalid input.
    init(hex: String) {
        var text = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.hasPrefix("#") {
            text.removeFirst()
        }
        if text.count == 6, let value = UInt64(text, radix: 16) {
            let red = Double((value >> 16) & 0xFF) / 255.0
            let green = Double((value >> 8) & 0xFF) / 255.0
            let blue = Double(value & 0xFF) / 255.0
            self.init(red: red, green: green, blue: blue)
        } else {
            self.init(red: 0.61, green: 0.64, blue: 0.69)
        }
    }
}

/// Parsed `blob:<shape>:<color>` avatar.
struct BlobAvatar: Equatable {
    let shape: String
    let colorHex: String

    static let palette: [String: String] = [
        "purple": "#8b5cf6",
        "pink": "#ec4899",
        "orange": "#f97316",
        "teal": "#14b8a6",
        "yellow": "#eab308",
        "blue": "#3b82f6",
        "red": "#ef4444",
        "grey": "#9ca3af",
        "gray": "#9ca3af",
        "black": "#18181b",
    ]

    init?(_ icon: String?) {
        guard let icon, icon.hasPrefix("blob:") else { return nil }
        let pieces = icon.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
        let shapeName = pieces.count > 1 ? pieces[1] : "circle"
        let colorName = pieces.count > 2 ? pieces[2] : "purple"
        shape = shapeName.isEmpty ? "circle" : shapeName
        if let known = BlobAvatar.palette[colorName.lowercased()] {
            colorHex = known
        } else if colorName.hasPrefix("#") {
            colorHex = colorName
        } else {
            colorHex = "#8b5cf6"
        }
    }

    var color: Color {
        return Color(hex: colorHex)
    }

    var outline: AnyShape { AnyShape(SiteBlobShape(name: shape)) }

    /// Vertical offset of the eyes, as a fraction of the avatar size.
    var eyeOffset: CGFloat {
        switch shape {
        case "triangle":
            return 0.095
        case "pill":
            return -0.005
        default:
            return 0.015
        }
    }
}

/// Avatar for bots and models: a coloured blob with eyes, or an emoji / short text.
@MainActor
struct AvatarView: View {
    let icon: String?
    var size: CGFloat = 28

    var body: some View {
        if let blob = BlobAvatar(icon) {
            ZStack {
                blob.outline
                    .fill(blob.color)
                HStack(spacing: size * 0.10) {
                    Capsule()
                        .fill(Color.white)
                        .frame(width: size * 0.07, height: size * 0.15)
                        .rotationEffect(.degrees(-14))
                    Capsule()
                        .fill(Color.white)
                        .frame(width: size * 0.07, height: size * 0.15)
                        .rotationEffect(.degrees(-14))
                }
                .offset(y: size * blob.eyeOffset)
            }
            .frame(width: size, height: size)
            .accessibilityHidden(true)
        } else {
            Text(AvatarView.displayText(icon))
                .font(.system(size: size * 0.68))
                .lineLimit(1)
                .minimumScaleFactor(0.5)
                .frame(width: size, height: size)
                .accessibilityHidden(true)
        }
    }

    static func displayText(_ icon: String?) -> String {
        guard let icon else { return "🤖" }
        let trimmed = icon.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty || trimmed.hasPrefix("/") || trimmed.hasPrefix("http") || trimmed.hasPrefix("blob:") {
            return "🤖"
        }
        return String(trimmed.prefix(2))
    }
}

/// Same 100 × 100 artwork coordinates as the website's BlobSvg.
private struct SiteBlobShape: Shape {
    let name: String
    func path(in rect: CGRect) -> Path {
        var p = Path()
        switch name {
        case "triangle":
            p.move(to: .init(x: 50, y: 12))
            p.addCurve(to: .init(x: 61, y: 20), control1: .init(x: 55, y: 12), control2: .init(x: 58, y: 15))
            p.addLine(to: .init(x: 90, y: 70))
            p.addCurve(to: .init(x: 79, y: 88), control1: .init(x: 95, y: 79), control2: .init(x: 89, y: 88))
            p.addLine(to: .init(x: 21, y: 88))
            p.addCurve(to: .init(x: 10, y: 70), control1: .init(x: 11, y: 88), control2: .init(x: 5, y: 79))
            p.addLine(to: .init(x: 39, y: 20))
            p.addCurve(to: .init(x: 50, y: 12), control1: .init(x: 42, y: 15), control2: .init(x: 45, y: 12))
        case "egg": p = Path(ellipseIn: CGRect(x: 14, y: 12, width: 72, height: 84))
        case "pill": p = Path(roundedRect: CGRect(x: 8, y: 24, width: 84, height: 54), cornerRadius: 27)
        case "hexagon":
            p.move(to: .init(x: 50, y: 10))
            for point in [CGPoint(x: 86, y: 30), CGPoint(x: 86, y: 70), CGPoint(x: 50, y: 90), CGPoint(x: 14, y: 70), CGPoint(x: 14, y: 30)] { p.addLine(to: point) }
            p.closeSubpath()
            let outline = p.strokedPath(StrokeStyle(lineWidth: 10, lineJoin: .round))
            p = p.union(outline)
        case "ghost":
            p.move(to: .init(x: 18, y: 48))
            p.addArc(center: .init(x: 50, y: 48), radius: 32, startAngle: .degrees(180), endAngle: .degrees(0), clockwise: false)
            p.addLine(to: .init(x: 82, y: 88))
            p.addCurve(to: .init(x: 66, y: 84), control1: .init(x: 76, y: 88), control2: .init(x: 74, y: 84))
            p.addCurve(to: .init(x: 50, y: 88), control1: .init(x: 58, y: 84), control2: .init(x: 56, y: 88))
            p.addCurve(to: .init(x: 34, y: 84), control1: .init(x: 44, y: 88), control2: .init(x: 42, y: 84))
            p.addCurve(to: .init(x: 18, y: 88), control1: .init(x: 26, y: 84), control2: .init(x: 24, y: 88))
        case "drop":
            p.move(to: .init(x: 50, y: 8))
            p.addCurve(to: .init(x: 84, y: 64), control1: .init(x: 50, y: 8), control2: .init(x: 84, y: 44))
            p.addArc(center: .init(x: 50, y: 64), radius: 34, startAngle: .degrees(0), endAngle: .degrees(180), clockwise: false)
            p.addCurve(to: .init(x: 50, y: 8), control1: .init(x: 16, y: 44), control2: .init(x: 50, y: 8))
        default: p = Path(ellipseIn: CGRect(x: 8, y: 8, width: 84, height: 84))
        }
        p.closeSubpath()
        return p.applying(CGAffineTransform(a: rect.width / 100, b: 0, c: 0, d: rect.height / 100, tx: rect.minX, ty: rect.minY))
    }
}
