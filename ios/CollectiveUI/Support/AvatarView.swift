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

    var outline: AnyShape {
        switch shape {
        case "triangle":
            return AnyShape(BlobTriangle())
        case "egg":
            return AnyShape(BlobEgg())
        case "hexagon":
            return AnyShape(BlobHexagon())
        case "ghost":
            return AnyShape(BlobGhost())
        case "drop":
            return AnyShape(BlobDrop())
        case "pill":
            return AnyShape(BlobPill())
        default:
            return AnyShape(Circle())
        }
    }

    /// Vertical offset of the eyes, as a fraction of the avatar size.
    var eyeOffset: CGFloat {
        switch shape {
        case "triangle":
            return 0.12
        case "drop":
            return 0.12
        default:
            return 0.0
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
                HStack(spacing: size * 0.16) {
                    Circle()
                        .fill(Color.white)
                        .frame(width: size * 0.13, height: size * 0.13)
                    Circle()
                        .fill(Color.white)
                        .frame(width: size * 0.13, height: size * 0.13)
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

struct BlobTriangle: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let inset = rect.width * 0.06
        path.move(to: CGPoint(x: rect.midX, y: rect.minY + inset))
        path.addLine(to: CGPoint(x: rect.maxX - inset, y: rect.maxY - inset * 1.5))
        path.addLine(to: CGPoint(x: rect.minX + inset, y: rect.maxY - inset * 1.5))
        path.closeSubpath()
        return path
    }
}

struct BlobEgg: Shape {
    func path(in rect: CGRect) -> Path {
        let eggRect = rect.insetBy(dx: rect.width * 0.12, dy: rect.height * 0.02)
        return Path(ellipseIn: eggRect)
    }
}

struct BlobPill: Shape {
    func path(in rect: CGRect) -> Path {
        let pillRect = rect.insetBy(dx: rect.width * 0.2, dy: rect.height * 0.04)
        return Path(roundedRect: pillRect, cornerRadius: pillRect.width / 2)
    }
}

struct BlobHexagon: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let center = CGPoint(x: rect.midX, y: rect.midY)
        let radius = min(rect.width, rect.height) / 2
        for index in 0..<6 {
            let angle = Double(index) * Double.pi / 3.0 - Double.pi / 2.0
            let point = CGPoint(
                x: center.x + radius * CGFloat(cos(angle)),
                y: center.y + radius * CGFloat(sin(angle))
            )
            if index == 0 {
                path.move(to: point)
            } else {
                path.addLine(to: point)
            }
        }
        path.closeSubpath()
        return path
    }
}

struct BlobGhost: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let width = rect.width * 0.8
        let left = rect.midX - width / 2
        let right = rect.midX + width / 2
        let top = rect.minY + rect.height * 0.06
        let bottom = rect.maxY - rect.height * 0.06
        let radius = width / 2
        let wave = rect.height * 0.1

        path.move(to: CGPoint(x: left, y: bottom))
        path.addLine(to: CGPoint(x: left, y: top + radius))
        path.addQuadCurve(to: CGPoint(x: rect.midX, y: top), control: CGPoint(x: left, y: top))
        path.addQuadCurve(to: CGPoint(x: right, y: top + radius), control: CGPoint(x: right, y: top))
        path.addLine(to: CGPoint(x: right, y: bottom))
        let step = width / 3
        path.addQuadCurve(to: CGPoint(x: right - step, y: bottom), control: CGPoint(x: right - step / 2, y: bottom - wave))
        path.addQuadCurve(to: CGPoint(x: right - step * 2, y: bottom), control: CGPoint(x: right - step * 1.5, y: bottom - wave))
        path.addQuadCurve(to: CGPoint(x: left, y: bottom), control: CGPoint(x: left + step / 2, y: bottom - wave))
        path.closeSubpath()
        return path
    }
}

struct BlobDrop: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let top = CGPoint(x: rect.midX, y: rect.minY + rect.height * 0.04)
        let bottomY = rect.maxY - rect.height * 0.04
        let radius = rect.width * 0.36
        let sideY = bottomY - radius
        let rightPoint = CGPoint(x: rect.midX + radius, y: sideY)
        let leftPoint = CGPoint(x: rect.midX - radius, y: sideY)
        let bottom = CGPoint(x: rect.midX, y: bottomY)

        path.move(to: top)
        path.addQuadCurve(to: rightPoint, control: CGPoint(x: rect.midX + radius * 0.45, y: rect.minY + rect.height * 0.3))
        path.addQuadCurve(to: bottom, control: CGPoint(x: rect.midX + radius, y: bottomY))
        path.addQuadCurve(to: leftPoint, control: CGPoint(x: rect.midX - radius, y: bottomY))
        path.addQuadCurve(to: top, control: CGPoint(x: rect.midX - radius * 0.45, y: rect.minY + rect.height * 0.3))
        path.closeSubpath()
        return path
    }
}
