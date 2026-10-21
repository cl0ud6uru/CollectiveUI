import SwiftUI

@MainActor
struct DesktopRecoveryView: View {
    let model: ChatModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let error = model.inlineError {
                VStack(alignment: .leading, spacing: 8) {
                    Label("This reply needs attention", systemImage: "exclamationmark.triangle")
                        .font(.callout.weight(.semibold)).foregroundStyle(PortalTheme.danger)
                    Text(error).textSelection(.enabled).accessibilityIdentifier("chat.replyError")
                    Text("Your conversation and draft are kept. Refresh checks the saved reply without sending your message again.")
                        .font(.callout).foregroundStyle(PortalTheme.muted)
                    HStack {
                        Button(model.isRefreshingConversation ? "Refreshing…" : "Refresh Conversation", systemImage: "arrow.clockwise") {
                            Task { await model.refreshConversation() }
                        }
                        .disabled(!model.canRefreshConversation).accessibilityIdentifier("chat.refresh")
                        if !model.needsMessageStatusCheck && !model.hasDetachedReply && !model.isStreaming {
                            Button("Dismiss", action: model.dismissReplyError).accessibilityIdentifier("chat.dismissError")
                        }
                    }
                }
                .padding(14).frame(maxWidth: .infinity, alignment: .leading)
                .background(PortalTheme.surfaceSecondary, in: .rect(cornerRadius: 14))
            }
            if let error = model.commandError { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red) }
            if let result = model.commandResult { Text(([result.title] + result.lines).joined(separator: "\n")).textSelection(.enabled) }
            if model.needsMessageStatusCheck && !model.isStreaming {
                Button(model.isCheckingMessageStatus ? "Checking…" : "Check Message Status") {
                    Task { await model.checkMessageStatus() }
                }
                .disabled(model.isCheckingMessageStatus).accessibilityIdentifier("chat.checkStatus")
            }
            if model.canRetryOriginalMessage {
                Button("Retry Original Message", action: model.retryOriginalMessage).accessibilityIdentifier("chat.retryOriginal")
            }
            if model.hasDetachedReply {
                Button("Reconnect to Reply", action: model.resume).accessibilityIdentifier("chat.reconnect")
            }
            if let error = model.delegateApprovalError { Text(error).foregroundStyle(.red) }
            ForEach(model.delegatedApprovals) { request in DesktopDelegatedApprovalView(request: request, model: model) }
        }
        .frame(maxWidth: DesktopLayout.transcriptWidth, alignment: .leading)
        .padding(.horizontal, DesktopLayout.pageInset)
        .padding(.vertical, model.inlineError != nil || model.needsMessageStatusCheck || model.hasDetachedReply ||
                 model.commandResult != nil || model.commandError != nil || !model.delegatedApprovals.isEmpty ||
                 model.delegateApprovalError != nil ? 12 : 0)
        .frame(maxWidth: .infinity)
    }
}
