import SwiftUI
import CollectiveKit

// Shared by the iOS and macOS chats: the running step's ticker and pulse, and a turn's step rail and chip.
// SwiftUI only (no UIKit/AppKit), so the macOS project compiles this file directly.

enum ToolStep {
    /// The one line a running step shows: its command, query or target, whitespace collapsed.
    static func commandLine(_ input: JSONValue?) -> String? {
        guard let input else { return nil }
        guard let object = input.objectValue else { return input.stringValue.flatMap(oneLine) }
        // `preview` is what a Hermes server reports for its own tools (see hermes/mapper.ts).
        for key in ["command", "preview", "code", "query", "url", "pattern", "path", "goal"] {
            if let line = object[key]?.stringValue.flatMap(oneLine) { return line }
        }
        return object.keys.sorted().lazy.compactMap { object[$0]?.stringValue.flatMap(oneLine) }.first
    }

    private static func oneLine(_ text: String) -> String? {
        let line = text.prefix(400).split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return line.isEmpty ? nil : line
    }

    /// "12s", then "1m 5s", matching the website's step timings.
    static func elapsed(_ seconds: Int) -> String {
        seconds < 60 ? "\(seconds)s" : "\(seconds / 60)m \(seconds % 60)s"
    }
}

/// What a tool call does, for its glyph and the collapsed turn chip.
enum ToolKind: Equatable {
    case terminal, web, other

    init(toolName: String) {
        let name = toolName.hasPrefix("hermes__") ? String(toolName.dropFirst("hermes__".count)) : toolName
        switch name {
        case "workspace_bash", "terminal", "process_manage", "execute_code": self = .terminal
        case "web_search", "openai_web_search", "fetch_url", "web_extract": self = .web
        default: self = .other
        }
    }

    var symbol: String {
        switch self {
        case .terminal: "terminal"
        case .web: "globe"
        case .other: "wrench.and.screwdriver"
        }
    }

    /// The word the collapsed chip uses, e.g. "terminal · web · 3 steps".
    var label: String {
        switch self {
        case .terminal: "terminal"
        case .web: "web"
        case .other: "tools"
        }
    }
}

extension MessagePart {
    /// Tool calls and reasoning: what the rail and chip gather.
    var isTurnStep: Bool {
        switch self {
        case .tool: return true
        case .reasoning(let reasoning): return reasoning.state == "streaming" || !reasoning.text.isEmpty
        default: return false
        }
    }
}

extension ToolPart {
    /// Running, including an approved call that has not reported back yet.
    var isRunningStep: Bool {
        phase == .running || (phase == .approvalResponded && approval?.approved != false)
    }
}

/// When each running step was first seen, so its timer survives the card scrolling out and back.
@MainActor
enum ToolRunClock {
    private static var starts: [String: Date] = [:]

    static func start(_ toolCallId: String) -> Date {
        if let date = starts[toolCallId] { return date }
        let now = Date()
        starts[toolCallId] = now
        return now
    }

    static func finish(_ toolCallId: String) {
        starts[toolCallId] = nil
    }
}

/// `$ command`, a blinking cursor and the elapsed time, on one line. The cursor holds still under Reduce Motion.
@MainActor
struct RunningTicker: View {
    let toolCallId: String
    let command: String?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let start = ToolRunClock.start(toolCallId)
        TimelineView(.periodic(from: start, by: reduceMotion ? 1 : 0.5)) { context in
            let running = max(0, context.date.timeIntervalSince(start))
            let cursorOn = reduceMotion || Int(running * 2) % 2 == 0
            let stacked = dynamicTypeSize.isAccessibilitySize
            let layout = stacked
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: 2))
                : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 6))
            layout {
                HStack(spacing: 0) {
                    Text("$ " + (command ?? ""))
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Text("▌")
                        .foregroundStyle(PortalTheme.hermes)
                        .opacity(cursorOn ? 1 : 0)
                }
                if !stacked { Spacer(minLength: 4) }
                Text(ToolStep.elapsed(Int(running)))
                    .monospacedDigit()
            }
            .font(.system(.caption, design: .monospaced))
            .foregroundStyle(PortalTheme.muted)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Running \(command ?? ""), \(Duration.seconds(Int(running)).formatted(.units(width: .wide)))")
        }
    }
}

/// The running card's border: a flat, slow fade between the hairline and Hermes green. Static under Reduce Motion.
@MainActor
struct RunningStroke: View {
    let cornerRadius: CGFloat

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        Group {
            if reduceMotion {
                shape.stroke(PortalTheme.hermes, lineWidth: 1)
            } else {
                shape.stroke(PortalTheme.border, lineWidth: 1)
                    .phaseAnimator([false, true]) { content, lit in
                        content.overlay { shape.stroke(PortalTheme.hermes, lineWidth: 1).opacity(lit ? 1 : 0) }
                    } animation: { _ in
                        .easeInOut(duration: 1.2)
                    }
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

enum StepState: Hashable {
    case done, active, approval, failed, denied

    init(_ part: MessagePart) {
        switch part {
        case .tool(let tool):
            switch tool.phase {
            case .running: self = .active
            case .awaitingApproval: self = .approval
            case .approvalResponded: self = tool.approval?.approved == false ? .denied : .active
            case .completed: self = .done
            case .failed: self = .failed
            case .denied: self = .denied
            }
        case .reasoning(let reasoning):
            self = reasoning.state == "streaming" ? .active : .done
        default:
            self = .done
        }
    }
}

/// A reply's tool calls and reasoning: a rail while the turn works, one chip once it ends.
/// Failed steps stay visible beside the folded chip, never hidden inside it.
@MainActor
struct TurnStepsView<Step: View>: View {
    let message: UIMessage
    let model: ChatModel
    private let step: (MessagePart) -> Step
    @ScaledMetric private var toolDotY: CGFloat
    @ScaledMetric private var reasoningDotY: CGFloat
    @State private var isExpanded = false

    /// `toolDotY`/`reasoningDotY`: distance from a step's top to the middle of its first line.
    init(message: UIMessage, model: ChatModel, toolDotY: CGFloat, reasoningDotY: CGFloat, @ViewBuilder step: @escaping (MessagePart) -> Step) {
        self.message = message
        self.model = model
        self.step = step
        _toolDotY = ScaledMetric(wrappedValue: toolDotY, relativeTo: .subheadline)
        _reasoningDotY = ScaledMetric(wrappedValue: reasoningDotY, relativeTo: .footnote)
    }

    var body: some View {
        let steps = message.parts.enumerated().filter { $0.element.isTurnStep }.map { (offset: $0.offset, element: $0.element) }
        if !steps.isEmpty {
            if isTurnActive(steps) {
                rail(steps)
            } else {
                let failed = steps.filter { StepState($0.element) == .failed }
                StepChip(summary: summary(steps, failed: failed.count), failed: !failed.isEmpty, isExpanded: $isExpanded)
                    .accessibilityIdentifier("chat.steps.\(message.id)")
                if isExpanded {
                    rail(steps)
                } else {
                    ForEach(failed, id: \.offset) { item in step(item.element) }
                }
            }
        }
    }

    /// Open while this reply is live, or while any step still runs or waits for approval.
    private func isTurnActive(_ steps: [(offset: Int, element: MessagePart)]) -> Bool {
        let live = message.id == model.lastAssistantMessageId && (model.isStreaming || model.hasDetachedReply)
        return live || steps.contains { [.active, .approval].contains(StepState($0.element)) }
    }

    /// e.g. "terminal · web · 3 steps · 1 failed · 14s".
    private func summary(_ steps: [(offset: Int, element: MessagePart)], failed: Int) -> String {
        var kinds: [ToolKind] = []
        for case .tool(let tool) in steps.map(\.element) {
            let kind = ToolKind(toolName: tool.toolName)
            if !kinds.contains(kind) { kinds.append(kind) }
        }
        var items = kinds.map(\.label)
        items.append("\(steps.count) \(steps.count == 1 ? "step" : "steps")")
        if failed > 0 { items.append("\(failed) failed") }
        if let start = message.metadata?["startedAt"]?.doubleValue ?? message.metadata?["createdAt"]?.doubleValue,
           let end = message.metadata?["finishedAt"]?.doubleValue, end >= start {
            items.append(ToolStep.elapsed(max(1, Int(((end - start) / 1000).rounded()))))
        }
        return items.joined(separator: " · ")
    }

    private func rail(_ steps: [(offset: Int, element: MessagePart)]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(steps.enumerated()), id: \.element.offset) { index, item in
                let dotY: CGFloat = { if case .tool = item.element { return toolDotY }; return reasoningDotY }()
                let isLast = index == steps.count - 1
                HStack(alignment: .top, spacing: 10) {
                    StepDot(state: StepState(item.element))
                        .frame(width: 10, height: 10)
                        .padding(.top, dotY - 5)
                    step(item.element)
                        .padding(.bottom, isLast ? 0 : 8)
                }
                .background(alignment: .leading) {
                    VStack(spacing: 0) {
                        Rectangle().fill(index == 0 ? Color.clear : PortalTheme.border).frame(height: dotY)
                        Rectangle().fill(isLast ? Color.clear : PortalTheme.border)
                    }
                    .frame(width: 1.5)
                    .padding(.leading, 4.25)
                    .accessibilityHidden(true)
                }
            }
        }
    }
}

/// Finished: solid. Active: pulsing Hermes green. Failed: red.
@MainActor
private struct StepDot: View {
    let state: StepState
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Image(systemName: "circle.fill")
            .font(.system(size: 9))
            .foregroundStyle(color)
            .symbolEffect(.pulse, isActive: state == .active && !reduceMotion)
            .accessibilityHidden(true)
    }

    private var color: Color {
        switch state {
        case .done: PortalTheme.muted
        case .active: PortalTheme.hermes
        case .approval: PortalTheme.warning
        case .failed: PortalTheme.danger
        case .denied: PortalTheme.subtle
        }
    }
}

/// The finished turn folded into one line; tap to show the rail.
@MainActor
private struct StepChip: View {
    let summary: String
    let failed: Bool
    @Binding var isExpanded: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 14, style: .continuous)
        Button {
            withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.2)) { isExpanded.toggle() }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: failed ? "exclamationmark.circle.fill" : "checkmark")
                Text(summary).multilineTextAlignment(.leading)
                Image(systemName: isExpanded ? "chevron.up" : "chevron.down").font(.caption2)
            }
            .font(.footnote)
            .foregroundStyle(failed ? PortalTheme.danger : PortalTheme.muted)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(shape.fill(PortalTheme.surfaceSecondary))
            .overlay(shape.strokeBorder(failed ? PortalTheme.danger.opacity(0.6) : PortalTheme.border, lineWidth: 1))
            .contentShape(shape)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(summary)
        .accessibilityValue(isExpanded ? "Expanded" : "Collapsed")
        .accessibilityHint(isExpanded ? "Hides the steps" : "Shows the steps")
    }
}
