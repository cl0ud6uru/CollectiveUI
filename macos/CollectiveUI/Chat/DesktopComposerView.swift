import SwiftUI

@MainActor
struct DesktopComposerView: View {
    @Bindable var model: ChatModel
    @FocusState private var isFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if model.isReadOnly || model.isUnavailable {
                Text(model.unavailableReason ?? "This delegated conversation is read only.")
                    .foregroundStyle(PortalTheme.muted)
            } else {
                ForEach(model.attachments) { attachment in
                    HStack {
                        Label(attachment.filename, systemImage: "paperclip")
                        if let error = attachment.errorText { Text(error).foregroundStyle(PortalTheme.danger) }
                        Spacer()
                        Button("Remove Attachment", systemImage: "xmark") { model.removeAttachment(id: attachment.id) }
                            .labelStyle(.iconOnly)
                    }
                }
                VStack(alignment: .leading, spacing: 10) {
                    // Measuring text grows the native editor to seven lines; longer drafts scroll.
                    Text(model.composerText.isEmpty ? " " : model.composerText + "\n")
                        .font(.body).lineLimit(1...7).padding(5)
                        .frame(maxWidth: .infinity, minHeight: 42, alignment: .topLeading)
                        .hidden().accessibilityHidden(true)
                        .overlay(alignment: .topLeading) {
                            ZStack(alignment: .topLeading) {
                                TextEditor(text: $model.composerText)
                                    .font(.body).scrollContentBackground(.hidden)
                                    .focused($isFocused)
                                    .accessibilityLabel(placeholder)
                                    .accessibilityHint("Return inserts a new line. Command Return sends your message.")
                                    .accessibilityIdentifier("chat.composer")
                                if model.composerText.isEmpty {
                                    Text(placeholder).foregroundStyle(PortalTheme.muted).padding(5)
                                        .allowsHitTesting(false).accessibilityHidden(true)
                                }
                            }
                        }
                    HStack {
                        Text("Return for a new line · ⌘Return to send")
                            .font(.caption).foregroundStyle(PortalTheme.muted)
                        Spacer(minLength: 8)
                        if model.isStreaming {
                            Button(model.isStopping ? "Stopping reply" : "Stop reply", systemImage: "stop.fill", action: model.stop)
                                .labelStyle(.iconOnly).buttonStyle(.plain)
                                .frame(width: 36, height: 36)
                                .background(PortalTheme.ink, in: Circle())
                                .foregroundStyle(PortalTheme.onInk)
                                .disabled(model.isStopping)
                                .help("Stop reply (⌘.)").accessibilityIdentifier("chat.stop")
                        } else {
                            Button("Send message", systemImage: "arrow.up") {
                                model.send()
                                isFocused = true
                            }
                            .labelStyle(.iconOnly).buttonStyle(.plain)
                            .font(.title3.weight(.semibold)).frame(width: 36, height: 36)
                            .background(model.canSend ? PortalTheme.ink : PortalTheme.surfaceSecondary, in: Circle())
                            .foregroundStyle(model.canSend ? PortalTheme.onInk : PortalTheme.muted)
                            .disabled(!model.canSend).help("Send message (⌘Return)")
                            .accessibilityIdentifier("chat.send")
                        }
                    }
                }
                .padding(14)
                .background(PortalTheme.surface, in: .rect(cornerRadius: DesktopLayout.composerRadius))
                .overlay {
                    RoundedRectangle(cornerRadius: DesktopLayout.composerRadius)
                        .strokeBorder(isFocused ? PortalTheme.muted : PortalTheme.border, lineWidth: 1)
                        .allowsHitTesting(false)
                }
            }
        }
        .frame(maxWidth: DesktopLayout.transcriptWidth)
        .padding(.horizontal, DesktopLayout.pageInset).padding(.top, 10).padding(.bottom, 18)
        .frame(maxWidth: .infinity)
    }

    private var placeholder: String {
        model.target?.kind == "bot" ? "Message \(model.assistantName)" : "Ask anything"
    }
}
