import SwiftUI

struct VoiceMiniBar: View {
    @Bindable var model: VoiceSessionModel

    var body: some View {
        HStack(spacing: 10) {
            Button {
                model.expanded = true
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: model.muted ? "mic.slash" : "waveform")
                    VStack(alignment: .leading, spacing: 2) {
                        Text(model.name).font(.subheadline.weight(.medium))
                        Text(model.statusLabel).font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "arrow.up.left.and.arrow.down.right")
                }.frame(minHeight: 44).contentShape(.rect)
            }
            .buttonStyle(.plain).accessibilityLabel("Open voice with \(model.name)")
            .accessibilityIdentifier("voice.expand")
            Button(model.active ? "End voice" : "Close voice", systemImage: model.active ? "stop.fill" : "xmark") {
                if model.active { Task { await model.end() } }
                else if model.unsaved { model.expanded = true }
                else { model.dismiss() }
            }
            .labelStyle(.iconOnly).frame(width: 44, height: 44)
            .disabled(model.status == "ending")
        }
        .padding(.horizontal, 14).padding(.vertical, 6)
        .background(PortalTheme.surfaceSecondary, in: .rect(cornerRadius: 18))
        .padding(.horizontal, 12).padding(.bottom, 8)
    }
}
