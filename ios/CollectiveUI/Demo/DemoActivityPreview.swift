#if DEBUG
import ActivityKit
import SwiftUI
import CollectiveKit

/// Offline QA surface uses the same views as the widget. It never registers an APNs token.
struct DemoActivityPreview: View {
    @State private var nativeStatus = ""
    @State private var nativeActivity: Activity<CollectiveRunAttributes>?
    private let attributes = CollectiveRunAttributes(scope: "offline-preview", conversationId: "home-bot-atlas", botId: "bot-atlas", runId: "offline-run", pet: "moss")
    private var phase: RunActivityPhase { RunActivityPhase(rawValue: DemoMode.value(after: "--demo-activity-phase") ?? "working") ?? .working }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text("Live Activities").font(.largeTitle.bold()).padding(.top, 12)
                Text("Offline preview · static pet poses")
                    .font(.subheadline).foregroundStyle(.secondary)
                if !nativeStatus.isEmpty { Text(nativeStatus).font(.caption).foregroundStyle(.secondary) }
                HStack {
                    RunActivityPet(attributes: attributes, phase: phase, size: 22)
                    Spacer().frame(width: 100)
                    RunActivityGlyph(phase: phase)
                    Spacer()
                    ZStack(alignment: .bottomTrailing) {
                        RunActivityPet(attributes: attributes, phase: .attention, size: 22)
                        Circle().fill(.orange).frame(width: 5, height: 5)
                    }
                }.padding(.horizontal, 14).padding(.vertical, 10).background(.black, in: Capsule())
                Text("Lock Screen").font(.headline)
                ForEach([RunActivityPhase.working, .attention, .completed, .failed, .cancelled], id: \.rawValue) { state in
                    RunActivityCard(attributes: attributes, state: .init(phase: state, updatedAt: Int(Date.now.timeIntervalSince1970)))
                        .background(Color(white: 0.12), in: RoundedRectangle(cornerRadius: 24))
                }
                RunActivityCard(attributes: attributes, state: .init(phase: .working, updatedAt: 0), isStale: true)
                    .background(Color(white: 0.12), in: RoundedRectangle(cornerRadius: 24))
                Text("Task text stays private. Tap opens the exact chat after sign-in and permission checks.")
                    .font(.footnote).foregroundStyle(.secondary)
            }.padding(20)
        }.background(Color(white: 0.06)).foregroundStyle(.white).preferredColorScheme(.dark)
            .task { await startNativePreview() }
    }
    private func startNativePreview() async {
        guard ProcessInfo.processInfo.arguments.contains("--demo-native-activity") else { return }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { nativeStatus = "ActivityKit unavailable or disabled"; return }
        // This simulator-only fixture has no pushType, device registration, credentials, or external server.
        for old in Activity<CollectiveRunAttributes>.activities { await old.end(nil, dismissalPolicy: .immediate) }
        do {
            nativeActivity = try Activity.request(attributes: attributes, content: .init(state: .init(phase: phase, updatedAt: Int(Date.now.timeIntervalSince1970)), staleDate: .now + 180), pushType: nil)
            nativeStatus = "ActivityKit fixture started · local only"
            if phase.isTerminal, let nativeActivity {
                await nativeActivity.end(.init(state: .init(phase: phase, updatedAt: Int(Date.now.timeIntervalSince1970)), staleDate: nil), dismissalPolicy: .after(.now + 300))
            }
        } catch { nativeStatus = "ActivityKit fixture could not start" }
    }
}
#endif
