import SwiftUI
import WebKit

/// The engine stays mounted when minimized, preserving the microphone and conversation.
struct VoiceModeView: View {
    @Bindable var model: VoiceSessionModel
    @Environment(\.dynamicTypeSize) private var typeSize
    @ScaledMetric(relativeTo: .title3) private var controlSize: CGFloat = 56
    @ScaledMetric(relativeTo: .body) private var headerControlSize: CGFloat = 48
    @State private var stageHeight: CGFloat = 0
    @AccessibilityFocusState private var headerFocused: Bool
    private let background = Color(red: 0.035, green: 0.055, blue: 0.10)

    var body: some View {
        ZStack {
            background.ignoresSafeArea()
            GeometryReader { viewport in
                VStack(spacing: 0) {
                    ScrollView {
                        VStack(spacing: 16) {
                            header
                            Spacer(minLength: 0)
                            WebView(model.page)
                                .webViewContentBackground(.hidden)
                                .allowsHitTesting(false)
                                .accessibilityHidden(true)
                                .frame(height: max(120, min(520, viewport.size.height - (typeSize.isAccessibilitySize ? 460 : 290))))
                            Spacer(minLength: 0)
                            if let notice = model.notice {
                                Text(notice).font(.callout).multilineTextAlignment(.center)
                                    .foregroundStyle(.white.opacity(0.85))
                                    .padding(14).frame(maxWidth: .infinity)
                                    .background(.black.opacity(0.5), in: .rect(cornerRadius: 16))
                                    .accessibilityIdentifier("voice.notice")
                            }
                            if model.unsaved {
                                Button("Retry save") { Task { await model.retrySave() } }
                                    .buttonStyle(.bordered).disabled(model.saving)
                                    .accessibilityIdentifier("voice.retry")
                            }
                        }
                        .frame(minHeight: max(0, stageHeight - 24))
                        .padding(.horizontal, 24).padding(.top, 24)
                    }
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { stageHeight = $0 }
                    .scrollIndicators(.hidden)
                    .scrollBounceBehavior(.basedOnSize)
                    VoiceInputMeter(level: model.inputLevel, muted: model.muted || !model.active)
                    controls.padding(.top, 12).padding(.horizontal, 24)
                    if !typeSize.isAccessibilitySize {
                        Text("Same bot. Same conversation.")
                            .font(.footnote).foregroundStyle(.white.opacity(0.65))
                            .padding(.top, 16)
                    }
                }
                .padding(.bottom, 24)
                .frame(maxWidth: 700)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .foregroundStyle(.white)
        .preferredColorScheme(model.expanded ? .dark : nil)
        .opacity(model.expanded ? 1 : 0.001)
        .allowsHitTesting(model.expanded)
        .accessibilityHidden(!model.expanded)
        .task { await model.load() }
        .task(id: model.expanded) {
            await model.setVisible()
            if model.expanded { headerFocused = true }
        }
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 16) {
            VStack(alignment: .leading, spacing: 6) {
                Text(model.name).font(.title2.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 6) {
                    if model.status == "connecting" || model.status == "ending" { ProgressView().tint(.white) }
                    Text(model.statusLabel).font(.subheadline).foregroundStyle(.white.opacity(0.75)).fixedSize(horizontal: false, vertical: true)
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityFocused($headerFocused)
            .accessibilityIdentifier("voice.status")
            Spacer(minLength: 0)
            Button("Back to chat", systemImage: "arrow.down.right.and.arrow.up.left") { model.expanded = false }
                .labelStyle(.iconOnly).dynamicTypeSize(...DynamicTypeSize.xxxLarge)
                .frame(width: min(headerControlSize, 72), height: min(headerControlSize, 72))
                .background(.white.opacity(0.10), in: .circle)
                .accessibilityIdentifier("voice.minimize")
        }
    }

    private var controls: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 16) { muteButton; endButton }
            VStack(spacing: 12) {
                muteButton
                endButton
            }
        }
    }

    private var muteButton: some View {
        Button(model.muted ? "Unmute microphone" : "Mute microphone", systemImage: model.muted ? "mic.slash.fill" : "mic.fill") {
            Task { await model.setMuted(!model.muted) }
        }
        .labelStyle(.iconOnly).font(.title3).dynamicTypeSize(...DynamicTypeSize.xxxLarge)
        .frame(width: min(controlSize, 80), height: min(controlSize, 80))
        .background(.white.opacity(model.muted ? 0.22 : 0.10), in: .circle)
        .disabled(model.status != "connected")
        .accessibilityIdentifier("voice.mute")
    }

    private var endButton: some View {
        Button {
            if model.active { Task { await model.end() } }
            else { model.dismiss() }
        } label: {
            Label(model.active ? "End voice" : "Back to chat", systemImage: model.active ? "stop.fill" : "text.bubble")
                .font(.headline).padding(.horizontal, 22).padding(.vertical, 18)
                .frame(minHeight: 56)
        }
        .foregroundStyle(.black).background(.white, in: .capsule)
        .disabled(model.status == "ending" || model.saving)
        .accessibilityIdentifier("voice.end")
    }
}
