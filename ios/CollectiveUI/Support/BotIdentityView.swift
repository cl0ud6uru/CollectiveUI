import SwiftUI
import UIKit
import ImageIO
import CollectiveKit

/// Native rendering of the same effective pet (or blob) used by the website.
@MainActor
struct BotIdentityView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.displayScale) private var displayScale
    @Environment(\.scenePhase) private var scenePhase
    let botId: String?
    let icon: String?
    var size: CGFloat = 28
    var activity: BotActivity = .idle
    @State private var atlas: UIImage?
    @State private var atlasRows = 9

    private var pet: PetAppearance? { botId.flatMap { app.shell?.pets[$0] } }
    private var spriteURL: String? { botId.flatMap { pet?.avatarPath(for: $0) } }
    private var loadKey: String {
        [app.serverURL?.absoluteString ?? "", app.shell?.user?.id ?? "", spriteURL ?? "", String(pet?.spriteVersionNumber ?? 0)].joined(separator: "|")
    }
    private var animates: Bool {
        size > 32 && !reduceMotion && scenePhase == .active && pet?.motion != "still" && activity != .unavailable
    }

    var body: some View {
        Group {
            if let pet, pet.enabled, pet.appearance == "moss" || pet.appearance == "ember" {
                SeedlingView(ember: pet.appearance == "ember")
                    .frame(width: size, height: size * 104 / 96)
            } else if let atlas, spriteURL != nil {
                TimelineView(.animation(minimumInterval: activity.duration / Double(activity.frameCount), paused: !animates)) { context in
                    let frame = animates ? Int(context.date.timeIntervalSinceReferenceDate / activity.duration * Double(activity.frameCount)) % activity.frameCount : 0
                    let height = size * 208 / 192
                    Canvas { context, canvasSize in
                        context.clip(to: Path(CGRect(origin: .zero, size: canvasSize)))
                        context.draw(Image(uiImage: atlas), in: CGRect(
                            x: -CGFloat(frame) * size, y: -CGFloat(activity.atlasRow) * height,
                            width: size * 8, height: height * CGFloat(atlasRows)
                        ))
                    }
                    .frame(width: size, height: height)
                }
            } else { AvatarView(icon: icon, size: size) }
        }
        // Draw into a cell-sized canvas: the full atlas must never expand the
        // layout, accessibility frame, or hit region into nearby controls.
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .task(id: loadKey) { await loadAtlas() }
    }

    private func loadAtlas() async {
        atlas = nil
        guard let spriteURL, let api = app.api else { return }
        for attempt in 0..<2 {
            do {
                let data = try await api.loadData(from: spriteURL)
                guard !Task.isCancelled, data.count <= 4 * 1024 * 1024,
                      let source = CGImageSourceCreateWithData(data as CFData, nil),
                      let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
                      let width = properties[kCGImagePropertyPixelWidth] as? Int,
                      let height = properties[kCGImagePropertyPixelHeight] as? Int,
                      width == 1536, [1872, 2288].contains(height) else { return }
                let rows = height / 208
                guard pet?.spriteVersionNumber == nil || rows == (pet?.spriteVersionNumber == 2 ? 11 : 9) else { return }
                let longestSide = max(size * 8, size * 208 / 192 * CGFloat(rows)) * displayScale
                guard let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                    kCGImageSourceCreateThumbnailFromImageAlways: true,
                    kCGImageSourceThumbnailMaxPixelSize: Int(longestSide),
                    kCGImageSourceShouldCacheImmediately: true,
                ] as CFDictionary) else { return }
                atlasRows = rows
                atlas = UIImage(cgImage: thumbnail)
                return
            } catch {
                if Task.isCancelled || error.isCancellation || error.isUnauthorized { return }
                if attempt == 0 { try? await Task.sleep(for: .milliseconds(500)) }
            }
        }
    }

}

/// The website's original Seedling artwork drawn with native vectors, not a web view.
private struct SeedlingView: View {
    let ember: Bool
    var body: some View {
        Canvas { context, size in
            context.scaleBy(x: size.width / 96, y: size.height / 104)
            func fill(_ path: Path, _ moss: String, _ warm: String) {
                context.fill(path, with: .color(Color(hex: ember ? warm : moss)))
            }
            func stroke(_ path: Path, _ moss: String, _ warm: String, _ width: CGFloat) {
                context.stroke(path, with: .color(Color(hex: ember ? warm : moss)), style: StrokeStyle(lineWidth: width, lineCap: .round))
            }
            context.fill(Path(ellipseIn: CGRect(x: 23, y: 89, width: 50, height: 8)), with: .color(PortalTheme.ink.opacity(0.08)))
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
            for x in [35.0, 56.0] { fill(Path(roundedRect: CGRect(x: x, y: 55, width: 5, height: 9), cornerRadius: 2.5), "f5efd4", "f5efd4") }
            stroke(Path { p in p.move(to: .init(x: 44, y: 65)); p.addQuadCurve(to: .init(x: 52, y: 65), control: .init(x: 48, y: 68)) }, "f5efd4", "f5efd4", 1.5)
            stroke(Path { p in
                p.move(to: .init(x: 18, y: 63)); p.addQuadCurve(to: .init(x: 12, y: 75), control: .init(x: 7, y: 66))
                p.move(to: .init(x: 78, y: 63)); p.addQuadCurve(to: .init(x: 84, y: 75), control: .init(x: 89, y: 66))
            }, "8da581", "c48d5b", 7)
            fill(Path(ellipseIn: CGRect(x: 46, y: 78, width: 4, height: 4)), "547653", "8e482a")
        }
    }
}
