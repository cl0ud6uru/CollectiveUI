import SwiftUI
import CollectiveKit

@MainActor
struct DesktopToolView: View {
    let part: ToolPart
    let messageId: String
    let model: ChatModel
    @State private var showDeny = false
    @State private var reason = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label {
                Text(part.title ?? part.toolName)
            } icon: {
                Image(systemName: part.phase == .awaitingApproval ? "shield.lefthalf.filled" : ToolKind(toolName: part.toolName).symbol)
                    .foregroundStyle(part.isRunningStep ? PortalTheme.hermes : Color.primary)
            }
            .font(.headline)
            if part.isRunningStep {
                RunningTicker(toolCallId: part.toolCallId, command: ToolStep.commandLine(part.input))
            } else {
                Text(status).font(.caption).foregroundStyle(.secondary)
            }
            // A failure's reason stays on the card; Action Details keeps the full text.
            if part.phase == .failed, let error = part.failureText {
                Text(error).font(.callout).foregroundStyle(PortalTheme.danger).lineLimit(4).textSelection(.enabled)
            }
            if part.phase == .awaitingApproval, let input = part.input {
                Text(input.prettyPrinted()).font(.system(.callout, design: .monospaced)).textSelection(.enabled)
            }
            DisclosureGroup("Action Details") {
                if part.phase != .awaitingApproval, let input = part.input { detail("Input", input.prettyPrinted()) }
                if let output = part.output { detail("Output", output.prettyPrinted()) }
                if let error = part.failureText { detail("Error", error) }
                if let reason = part.approval?.reason { detail("Reason", reason) }
            }
            if part.phase == .awaitingApproval, let approval = part.approval {
                if let decision = model.decision(for: approval.id) {
                    Label(decision.approved ? "Approved — waiting for remaining decisions" : "Denied — waiting for remaining decisions",
                          systemImage: decision.approved ? "checkmark" : "hand.raised")
                } else {
                    HStack {
                        Button("Approve", systemImage: "checkmark") {
                            model.decide(approvalId: approval.id, approved: true, reason: nil, messageId: messageId)
                        }.buttonStyle(.borderedProminent).accessibilityIdentifier("approval.approve." + approval.id)
                        Button("Deny", systemImage: "hand.raised") { reason = ""; showDeny = true }
                            .accessibilityIdentifier("approval.deny." + approval.id)
                    }.disabled(!model.canAnswerApprovals)
                }
            }
        }
        .padding(12).frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
        .overlay {
            if part.isRunningStep {
                RunningStroke(cornerRadius: 12)
            } else if part.phase == .failed {
                RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(PortalTheme.danger.opacity(0.6), lineWidth: 1)
            }
        }
        .onChange(of: part.isRunningStep) { _, running in
            if !running { ToolRunClock.finish(part.toolCallId) }
        }
        .alert("Deny this action?", isPresented: $showDeny) {
            TextField("Reason (optional)", text: $reason)
            Button("Deny", role: .destructive) {
                guard let approval = part.approval else { return }
                let trimmed = reason.trimmingCharacters(in: .whitespacesAndNewlines)
                model.decide(approvalId: approval.id, approved: false, reason: trimmed.isEmpty ? nil : trimmed, messageId: messageId)
            }
            Button("Cancel", role: .cancel) {}
        } message: { Text("Your server will receive this decision for this action.") }
    }

    private var status: String {
        switch part.phase {
        case .running: "Running"
        case .awaitingApproval: "Needs your approval"
        case .approvalResponded: part.approval?.approved == false ? "Denied" : "Approved"
        case .completed: "Done"
        case .failed: "Failed"
        case .denied: "Denied"
        }
    }

    private func detail(_ title: String, _ text: String) -> some View {
        VStack(alignment: .leading) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            Text(text).font(.system(.callout, design: .monospaced)).textSelection(.enabled)
        }.padding(.vertical, 4)
    }
}
