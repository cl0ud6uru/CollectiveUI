import SwiftUI

struct VoiceInputMeter: View {
    let level: VoiceInputLevel
    let muted: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let weights = [0.25, 0.48, 0.74, 1.0, 0.74, 0.48, 0.25]

    var body: some View {
        HStack(spacing: 6) {
            ForEach(weights.indices, id: \.self) { index in
                Capsule()
                    .fill(muted ? Color.white.opacity(0.25) : Color(red: 0.67, green: 0.87, blue: 1).opacity(0.45 + level.value * 0.55))
                    .frame(width: 5, height: reduceMotion || muted ? 6 : 6 + 32 * level.value * weights[index])
            }
        }
        .frame(height: 44)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: level.value)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Microphone activity")
        .accessibilityValue(muted ? "Muted" : "Listening")
        .accessibilityIdentifier("voice.inputMeter")
    }
}
