import SwiftUI
import UIKit
import CollectiveKit

/// Compact card for a tool call, with expandable input/output and approval controls.
@MainActor
struct ToolPartView: View {
    let part: ToolPart
    let messageId: String
    let model: ChatModel

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var isExpanded: Bool = false
    @State private var showDenyPrompt: Bool = false
    @State private var denyReason: String = ""
    @State private var downloading = false
    @State private var artifactFile: URL?
    @State private var showArtifact = false
    @State private var artifactError: String?

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
                HStack(alignment: .top, spacing: 8) {
                    stateIcon
                        .font(.subheadline)
                        .padding(.top, 2)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(displayName).font(.subheadline.weight(.medium)).fixedSize(horizontal: false, vertical: true)
                        Text(statusText).font(.caption).foregroundStyle(PortalTheme.muted)
                    }
                    Spacer(minLength: 4)
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
            if part.state == "output-available", let path = WorkspaceArtifact.path(toolName: part.toolName, output: part.output) {
                Button {
                    Task { await downloadArtifact(path) }
                } label: {
                    Label(downloading ? "Downloading…" : "Download \(path.split(separator: "/").last ?? "file")", systemImage: "square.and.arrow.down")
                        .font(.footnote)
                }
                .disabled(downloading)
                if let artifactError { Text(artifactError).font(.caption).foregroundStyle(PortalTheme.danger) }
            }
        }
        .padding(10)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(PortalTheme.surface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(isAwaitingApproval ? PortalTheme.warning.opacity(0.6) : Color.clear, lineWidth: 1)
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
        .sheet(isPresented: $showArtifact, onDismiss: removeArtifact) {
            if let artifactFile { ArtifactShareSheet(file: artifactFile) }
        }
    }

    private func downloadArtifact(_ path: String) async {
        guard let api = model.app.api else { return }
        downloading = true
        artifactError = nil
        defer { downloading = false }
        do {
            let data = try await api.workspaceFile(path: path)
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let file = dir.appendingPathComponent(String(path.split(separator: "/").last ?? "file"))
            try data.write(to: file, options: [.atomic, .completeFileProtection])
            artifactFile = file
            showArtifact = true
        } catch { artifactError = error.localizedDescription }
    }

    private func removeArtifact() {
        if let artifactFile { try? FileManager.default.removeItem(at: artifactFile.deletingLastPathComponent()) }
        artifactFile = nil
    }

    @ViewBuilder
    private var stateIcon: some View {
        switch part.phase {
        case .running:
            ProgressView()
                .controlSize(.small)
        case .awaitingApproval:
            Image(systemName: "shield.lefthalf.filled")
                .foregroundStyle(PortalTheme.warning)
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
                .foregroundStyle(PortalTheme.success)
        case .failed:
            Image(systemName: "xmark.circle.fill")
                .foregroundStyle(PortalTheme.danger)
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
                let layout = dynamicTypeSize.isAccessibilitySize ? AnyLayout(VStackLayout(spacing: 10)) : AnyLayout(HStackLayout(spacing: 10))
                layout {
                    Button {
                        answer(approved: true)
                    } label: {
                        Label("Approve", systemImage: "checkmark")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(PortalTheme.ink)
                    .foregroundStyle(PortalTheme.onInk)

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

private struct ArtifactShareSheet: UIViewControllerRepresentable {
    let file: URL
    func makeUIViewController(context: Context) -> UIActivityViewController { UIActivityViewController(activityItems: [file], applicationActivities: nil) }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
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
                    .fill(PortalTheme.surfaceSecondary)
            )
        }
    }
}
