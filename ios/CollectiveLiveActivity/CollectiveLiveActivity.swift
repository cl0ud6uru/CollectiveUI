import ActivityKit
import SwiftUI
import WidgetKit
import CollectiveKit

@main
struct CollectiveLiveActivityBundle: WidgetBundle {
    var body: some Widget { CollectiveRunLiveActivity() }
}

struct CollectiveRunLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: CollectiveRunAttributes.self) { context in
            RunActivityCard(attributes: context.attributes, state: context.state, isStale: context.isStale)
                .widgetURL(context.attributes.chatURL)
                .activityBackgroundTint(.black.opacity(0.85))
                .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    RunActivityPet(attributes: context.attributes, phase: context.state.phase, size: 36)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    RunActivityGlyph(phase: context.isStale && !context.state.phase.isTerminal ? .reconnecting : context.state.phase)
                        .padding(.top, 8)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(context.isStale && !context.state.phase.isTerminal ? "Open chat for latest status" : context.state.phase.label)
                            .font(.headline).lineLimit(2)
                        Text(context.state.phase == .attention ? "Open chat to respond" : "Tap to open chat")
                            .font(.caption).foregroundStyle(.secondary)
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 6)
                }
            } compactLeading: {
                RunActivityPet(attributes: context.attributes, phase: context.state.phase, size: 22)
            } compactTrailing: {
                RunActivityGlyph(phase: context.isStale && !context.state.phase.isTerminal ? .reconnecting : context.state.phase)
            } minimal: {
                ZStack(alignment: .bottomTrailing) {
                    RunActivityPet(attributes: context.attributes, phase: context.state.phase, size: 22)
                    Circle().fill(context.state.phase == .completed ? Color.green : (context.state.phase == .attention || context.state.phase == .failed ? Color.orange : Color.white))
                        .frame(width: 5, height: 5)
                }.accessibilityLabel(context.state.phase.label)
            }
            .widgetURL(context.attributes.chatURL)
            .keylineTint(.white.opacity(0.6))
        }
    }
}

#if DEBUG
#Preview("Run status", as: .content, using: CollectiveRunAttributes(scope: "preview", conversationId: "chat", botId: "bot", runId: "run", pet: "moss")) {
    CollectiveRunLiveActivity()
} contentStates: {
    RunActivityContent(phase: .working, updatedAt: 0)
    RunActivityContent(phase: .attention, updatedAt: 0)
    RunActivityContent(phase: .completed, updatedAt: 0)
    RunActivityContent(phase: .failed, updatedAt: 0)
}
#endif
