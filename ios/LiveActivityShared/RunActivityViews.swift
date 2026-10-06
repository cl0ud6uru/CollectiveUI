import SwiftUI
import CollectiveKit

struct RunActivityPet: View {
    let attributes: CollectiveRunAttributes
    let phase: RunActivityPhase
    var size: CGFloat = 44
    var body: some View {
        Group {
            if let pixels = ActivityPetPixels(base64: attributes.petPixels) {
                Canvas { context, canvas in
                    let w = canvas.width / 24; let h = canvas.height / 26
                    for y in 0..<26 {
                        for x in 0..<24 {
                            let (r, g, b, a) = pixels.rgba(x: x, y: y, pose: phase.poseIndex)
                            if a > 0 {
                                context.fill(Path(CGRect(x: CGFloat(x) * w, y: CGFloat(y) * h, width: w + 0.05, height: h + 0.05)),
                                    with: .color(Color(.sRGB, red: Double(r) / 255, green: Double(g) / 255, blue: Double(b) / 255, opacity: Double(a) / 255)))
                            }
                        }
                    }
                }
            } else if ["moss", "ember"].contains(attributes.pet) {
                ActivitySeedlingView(ember: attributes.pet == "ember", phase: phase)
            } else {
                Image(systemName: "sparkles").resizable().scaledToFit().padding(size * 0.15)
                    .foregroundStyle(.white.opacity(0.85))
            }
        }
        .frame(width: size, height: size * 26 / 24)
        .accessibilityHidden(true)
    }
}

struct RunActivityGlyph: View {
    let phase: RunActivityPhase
    var tint: Color {
        switch phase {
        case .completed: return .green
        case .failed, .attention: return .orange
        case .reconnecting: return .white.opacity(0.65)
        default: return .white
        }
    }
    var body: some View {
        Image(systemName: phase.symbol).font(.system(size: 16, weight: .semibold)).foregroundStyle(tint)
            .accessibilityLabel(phase.label)
    }
}

struct RunActivityCard: View {
    let attributes: CollectiveRunAttributes
    let state: RunActivityContent
    var isStale = false
    private var label: String { isStale && !state.phase.isTerminal ? "Open chat for latest status" : state.phase.label }
    var body: some View {
        HStack(spacing: 14) {
            RunActivityPet(attributes: attributes, phase: state.phase, size: 48)
            VStack(alignment: .leading, spacing: 5) {
                Text("Your bot").font(.caption.weight(.medium)).foregroundStyle(.secondary)
                Text(label).font(.headline).lineLimit(2)
                Text(state.phase == .attention ? "Open chat to respond" : "Tap to open chat")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            RunActivityGlyph(phase: isStale && !state.phase.isTerminal ? .reconnecting : state.phase)
        }
        .padding(16)
        .foregroundStyle(.white)
        .accessibilityElement(children: .combine)
    }
}
