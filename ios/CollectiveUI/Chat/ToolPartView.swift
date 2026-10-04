import SwiftUI
import CollectiveKit

/// Compact card for a tool call, with expandable input/output and approval controls.
@MainActor
struct ToolPartView: View {
    let part: ToolPart
    let messageId: String
    let model: ChatModel

    @State private var isExpanded: Bool = false
    @State private var showDenyPrompt: Bool = false
    @State private var denyReason: String = ""

    private static let maxDetailLength = 6000

    private var displayName: String {
        if let title = part.title, !title.isEmpty {
            return title
        }
        return TextUtilities.toolDisplayName(part.toolName)
    }

    private var isAwaitingApproval: Bool {
        return part.state == "approval-requested" && part.approval != nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    isExpanded.toggle()
                }
            } label: {
                HStack(spacing: 8) {
                    stateIcon
                        .frame(width: 18, height: 18)
                    Text(displayName)
                        .font(.subheadline.weight(.medium))
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    Text(statusText)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isExpanded {
                details
            }

            if isAwaitingApproval {
                approvalControls
            }
        }
        .padding(10)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color(uiColor: .secondarySystemBackground))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(isAwaitingApproval ? Color.orange.opacity(0.6) : Color.clear, lineWidth: 1)
        )
        .alert("Deny this action?", isPresented: $showDenyPrompt) {
            TextField("Reason (optional)", text: $denyReason)
            Button("Deny", role: .destructive) {
                answer(approved: false)
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The assistant will be told you declined.")
        }
    }

    @ViewBuilder
    private var stateIcon: some View {
        switch part.phase {
        case .running:
            ProgressView()
                .controlSize(.small)
        case .awaitingApproval:
            Image(systemName: "shield.lefthalf.filled")
                .foregroundStyle(Color.orange)
        case .approvalResponded:
            if part.approval?.approved == false {
                Image(systemName: "hand.raised.fill")
                    .foregroundStyle(Color.secondary)
            } else {
                ProgressView()
                    .controlSize(.small)
            }
        case .completed:
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(Color.green)
        case .failed:
            Image(systemName: "xmark.circle.fill")
                .foregroundStyle(Color.red)
        case .denied:
            Image(systemName: "hand.raised.fill")
                .foregroundStyle(Color.secondary)
        }
    }

    private var statusText: String {
        switch part.phase {
        case .running:
            return "Running"
        case .awaitingApproval:
            return "Needs approval"
        case .approvalResponded:
            return part.approval?.approved == false ? "Denied" : "Approved"
        case .completed:
            return "Done"
        case .failed:
            return "Failed"
        case .denied:
            return "Denied"
        }
    }

    @ViewBuilder
    private var details: some View {
        if let input = part.input {
            DetailBlock(title: "Input", text: ToolPartView.truncate(input.prettyPrinted()))
        } else if let inputText = part.inputText, !inputText.isEmpty {
            DetailBlock(title: "Input", text: ToolPartView.truncate(inputText))
        }
        if let output = part.output {
            DetailBlock(title: "Output", text: ToolPartView.truncate(output.prettyPrinted()))
        }
        if let errorText = part.errorText {
            DetailBlock(title: "Error", text: ToolPartView.truncate(errorText))
        }
        if let reason = part.approval?.reason, !reason.isEmpty {
            DetailBlock(title: "Reason", text: reason)
        }
    }

    @ViewBuilder
    private var approvalControls: some View {
        if let approval = part.approval {
            if let decided = model.decision(for: approval.id) {
                Label(
                    decided.approved ? "Approved — waiting for the other decisions" : "Denied — waiting for the other decisions",
                    systemImage: decided.approved ? "checkmark" : "xmark"
                )
                .font(.footnote)
                .foregroundStyle(.secondary)
            } else {
                HStack(spacing: 10) {
                    Button {
                        answer(approved: true)
                    } label: {
                        Label("Approve", systemImage: "checkmark")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)

                    Button(role: .destructive) {
                        denyReason = ""
                        showDenyPrompt = true
                    } label: {
                        Label("Deny", systemImage: "xmark")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                }
                .controlSize(.regular)
                .disabled(!model.canAnswerApprovals)
            }
        }
    }

    private func answer(approved: Bool) {
        guard let approval = part.approval else { return }
        let trimmed = denyReason.trimmingCharacters(in: .whitespacesAndNewlines)
        let reason: String? = (approved || trimmed.isEmpty) ? nil : trimmed
        model.decide(approvalId: approval.id, approved: approved, reason: reason, messageId: messageId)
    }

    static func truncate(_ text: String) -> String {
        if text.count <= maxDetailLength {
            return text
        }
        return String(text.prefix(maxDetailLength)) + "\n…"
    }
}

@MainActor
private struct DetailBlock: View {
    let title: String
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            ScrollView(.horizontal, showsIndicators: false) {
                Text(text)
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
                    .fixedSize(horizontal: true, vertical: true)
                    .padding(8)
            }
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(Color(uiColor: .tertiarySystemBackground))
            )
        }
    }
}
