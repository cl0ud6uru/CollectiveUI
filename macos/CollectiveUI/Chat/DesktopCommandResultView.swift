import SwiftUI
import CollectiveKit

/// Keep control output separate from the transcript and leave the composer reachable.
struct DesktopCommandResultView: View {
    let result: ChatCommandResult
    let dismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 12) {
                Text(result.title).font(.callout.weight(.semibold)).lineLimit(2).help(result.title)
                Spacer(minLength: 8)
                Button("Dismiss command result", systemImage: "xmark", action: dismiss)
                    .labelStyle(.iconOnly)
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("command.result.dismiss")
            }
            ScrollView {
                Text(result.lines.joined(separator: "\n"))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(height: 160)
            .accessibilityLabel("Command output")
            .accessibilityIdentifier("command.result.output")
        }
        .padding(12)
        .background(PortalTheme.surfaceSecondary, in: .rect(cornerRadius: 12))
        .accessibilityIdentifier("command.result")
    }
}
