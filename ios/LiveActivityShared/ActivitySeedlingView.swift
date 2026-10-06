import SwiftUI
import CollectiveKit

// CollectiveUI’s existing Seedling artwork, with one fixed expression per run state.
struct ActivitySeedlingView: View {
    let ember: Bool
    let phase: RunActivityPhase
    var body: some View {
        Canvas { context, size in
            context.scaleBy(x: size.width / 96, y: size.height / 104)
            func fill(_ path: Path, _ moss: String, _ warm: String) {
                context.fill(path, with: .color(activityColor(ember ? warm : moss)))
            }
            func stroke(_ path: Path, _ moss: String, _ warm: String, _ width: CGFloat) {
                context.stroke(path, with: .color(activityColor(ember ? warm : moss)), style: StrokeStyle(lineWidth: width, lineCap: .round))
            }
            context.fill(Path(ellipseIn: CGRect(x: 23, y: 89, width: 50, height: 8)), with: .color(Color.white.opacity(0.08)))
            stroke(Path { p in p.move(to: .init(x: 45, y: 34)); p.addCurve(to: .init(x: 58, y: 16), control1: .init(x: 46, y: 24), control2: .init(x: 52, y: 19)) }, "587958", "9c542b", 4)
            fill(Path { p in
                p.move(to: .init(x: 49, y: 28)); p.addCurve(to: .init(x: 27, y: 10), control1: .init(x: 31, y: 29), control2: .init(x: 26, y: 18)); p.addCurve(to: .init(x: 49, y: 28), control1: .init(x: 41, y: 9), control2: .init(x: 49, y: 15))
            }, "80aa77", "e7a355")
            fill(Path { p in
                p.move(to: .init(x: 51, y: 23)); p.addCurve(to: .init(x: 70, y: 8), control1: .init(x: 50, y: 12), control2: .init(x: 59, y: 7)); p.addCurve(to: .init(x: 51, y: 23), control1: .init(x: 70, y: 18), control2: .init(x: 64, y: 24))
            }, "527c5a", "c5773e")
            fill(Path { p in
                p.move(to: .init(x: 26, y: 78)); p.addLine(to: .init(x: 23, y: 89)); p.addCurve(to: .init(x: 38, y: 88), control1: .init(x: 26, y: 93), control2: .init(x: 34, y: 93)); p.addLine(to: .init(x: 39, y: 80))
                p.move(to: .init(x: 57, y: 80)); p.addLine(to: .init(x: 58, y: 89)); p.addCurve(to: .init(x: 73, y: 89), control1: .init(x: 63, y: 94), control2: .init(x: 71, y: 92)); p.addLine(to: .init(x: 70, y: 78))
            }, "637960", "9f653e")
            fill(Path(roundedRect: CGRect(x: 16, y: 33, width: 64, height: 54), cornerRadius: 23), "b5c5a5", "dfb17d")
            stroke(Path { p in p.move(to: .init(x: 20, y: 54)); p.addCurve(to: .init(x: 43, y: 37), control1: .init(x: 20, y: 42), control2: .init(x: 30, y: 37)) }, "e0e8cb", "f7dbb7", 4)
            fill(Path(roundedRect: CGRect(x: 25, y: 48, width: 46, height: 26), cornerRadius: 12), "354a40", "513c32")
            for x in [35.0, 56.0] { fill(Path(roundedRect: CGRect(x: x, y: phase == .failed ? 60 : 55, width: 5, height: phase == .working ? 5 : (phase == .failed ? 2 : 9)), cornerRadius: 2.5), "f5efd4", "f5efd4") }
            stroke(Path { p in p.move(to: .init(x: 44, y: 65)); p.addQuadCurve(to: .init(x: 52, y: 65), control: .init(x: 48, y: phase == .failed ? 61 : (phase == .attention ? 72 : 68))) }, "f5efd4", "f5efd4", 1.5)
            stroke(Path { p in
                p.move(to: .init(x: 18, y: 63)); p.addQuadCurve(to: .init(x: 12, y: 75), control: .init(x: 7, y: 66))
                p.move(to: .init(x: 78, y: 63)); p.addQuadCurve(to: .init(x: 84, y: 75), control: .init(x: 89, y: 66))
            }, "8da581", "c48d5b", 7)
            fill(Path(ellipseIn: CGRect(x: 46, y: 78, width: 4, height: 4)), "547653", "8e482a")
        }
    }
}

private func activityColor(_ hex: String) -> Color {
    let n = UInt32(hex, radix: 16) ?? 0
    return Color(.sRGB, red: Double((n >> 16) & 255) / 255, green: Double((n >> 8) & 255) / 255, blue: Double(n & 255) / 255)
}
