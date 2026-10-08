import SwiftUI
import UIKit
import AVFAudio
import PhotosUI
import UniformTypeIdentifiers
import CollectiveKit

@MainActor
struct ComposerView: View {
    @Bindable var model: ChatModel
    @Environment(AppModel.self) private var app
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @State private var dictation = ComposerDictation()
    @State private var showCommands = false
    @State private var focusRequest = 0


    @State private var showPhotoPicker: Bool = false
    @State private var showFileImporter: Bool = false
    @State private var photoItems: [PhotosPickerItem] = []

    var body: some View {
        VStack(spacing: 8) {
            if dictation.isListening || dictation.isPreparing {
                HStack(spacing: 8) {
                    Image(systemName: "waveform").foregroundStyle(PortalTheme.danger)
                    Text(dictation.isPreparing ? "Preparing dictation…" : dictation.transcript.isEmpty ? "Listening…" : dictation.transcript)
                        .font(.footnote).lineLimit(3).frame(maxWidth: .infinity, alignment: .leading)
                    Button("Stop") { dictation.stop() }.font(.footnote.weight(.medium))
                }.padding(.horizontal, 22).accessibilityElement(children: .contain)
            }
            if let error = dictation.errorMessage {
                Text(error).font(.footnote).foregroundStyle(PortalTheme.danger).padding(.horizontal, 22)
            }
            if !model.attachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(model.attachments) { attachment in
                            AttachmentChip(attachment: attachment) {
                                model.removeAttachment(id: attachment.id)
                            }
                        }
                    }
                    .padding(.horizontal, 12)
                }
            }

            Group {
                if dynamicTypeSize.isAccessibilitySize {
                    VStack(spacing: 0) {
                        messageInput.padding(.horizontal, 16)
                        HStack(spacing: 0) {
                            attachmentButton
                            Spacer(minLength: 0)
                            dictationButton
                            if showsSendButton { sendButton }
                        }
                    }
                } else {
                    HStack(alignment: .bottom, spacing: 0) {
                        attachmentButton
                        messageInput.padding(.horizontal, 4)
                        dictationButton
                        if showsSendButton { sendButton }
                    }
                }
            }
            .padding(2)
            .background(PortalTheme.surface, in: RoundedRectangle(cornerRadius: 26))
            .overlay(RoundedRectangle(cornerRadius: 26).strokeBorder(PortalTheme.border, lineWidth: 1))
            .shadow(color: .black.opacity(0.05), radius: 8, y: 3)
            .padding(.horizontal, 12)
        }
        .frame(maxWidth: 840)
        .padding(.top, 6)
        .padding(.bottom, 8)
        .frame(maxWidth: .infinity)
        .popover(isPresented: $showCommands, attachmentAnchor: .rect(.bounds), arrowEdge: .bottom) {
            commandsPicker
                .presentationCompactAdaptation(.popover)
                .presentationBackground(PortalTheme.surface)
        }
        .onChange(of: model.composerText) { _, text in
            if text == "/" { showCommands = true }
        }
        .task {
            #if DEBUG
            if DemoMode.isEnabled && model.app.isDemoSession {
                if let draft = DemoMode.value(after: "--demo-draft") { model.composerText = draft }
                if ProcessInfo.processInfo.arguments.contains("--demo-focus") { focusRequest += 1 }
                if ProcessInfo.processInfo.arguments.contains("--demo-commands") { showCommands = true }
            }
            #endif
        }
        .onDisappear { dictation.stop() }
        .onChange(of: scenePhase) { _, phase in if phase == .background { dictation.stop() } }
        .onReceive(NotificationCenter.default.publisher(for: AVAudioSession.interruptionNotification)) { _ in dictation.stop() }
        .photosPicker(isPresented: $showPhotoPicker, selection: $photoItems, maxSelectionCount: 6, matching: .images)
        .fileImporter(isPresented: $showFileImporter, allowedContentTypes: [UTType.item], allowsMultipleSelection: true) { result in
            handleImport(result)
        }
        .onChange(of: photoItems) { _, items in
            handlePhotos(items)
        }
    }

    private var messageInput: some View {
        ZStack(alignment: .topLeading) {
            if model.composerText.isEmpty {
                Text(model.target?.kind == "bot" ? "Message " + model.assistantName : "Ask anything")
                    .font(.body)
                    .foregroundStyle(PortalTheme.muted)
                    .padding(.top, 11)
                    .allowsHitTesting(false)
            }
            MultilineComposer(text: $model.composerText, focusRequest: focusRequest,
                              maximumLines: verticalSizeClass == .compact ? 2 : 6)
                .accessibilityLabel("Message")
                .accessibilityHint("Return adds a new line. Use Send to send your message.")
        }
    }

    private var attachmentButton: some View {
        Menu {
            Button { showCommands = true } label: {
                Label("Commands", systemImage: "command")
            }
            .disabled(model.isExecutingCommand || model.isReadOnly || model.isUnavailable)
            Button { showPhotoPicker = true } label: {
                Label("Photo Library", systemImage: "photo.on.rectangle")
            }
            Button { showFileImporter = true } label: {
                Label("Choose File", systemImage: "doc")
            }
        } label: {
            Image(systemName: "plus").font(.system(size: 20))
                .frame(width: 44, height: 44)
                .foregroundStyle(PortalTheme.muted)
        }
        .disabled(model.isStreaming)
        .accessibilityLabel("Add attachments or commands")
    }

    private var showsSendButton: Bool {
        model.isStreaming || model.isUploading || model.isExecutingCommand || !model.composerText.isEmpty || !model.attachments.isEmpty
    }

    private var dictationButton: some View {
        Button {
            if dictation.isListening || dictation.isPreparing { dictation.stop() }
            else {
                Task {
                    await dictation.start { words in
                        if !model.composerText.isEmpty && model.composerText.last?.isWhitespace == false { model.composerText += " " }
                        model.composerText += words
                    }
                }
            }
        } label: {
            Image(systemName: dictation.isListening ? "waveform" : "mic")
                .font(.system(size: 19)).frame(width: 44, height: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(dictation.isListening ? PortalTheme.danger : PortalTheme.ink)
        .disabled(model.isExecutingCommand)
        .accessibilityLabel(dictation.isListening ? "Stop dictation" : "Dictate message")
    }

    private var sendButton: some View {
        Button {
            if model.isStreaming { model.stop() } else { send() }
        } label: {
            Group {
                if model.isUploading || model.isStopping || model.isExecutingCommand {
                    ProgressView().tint(PortalTheme.onInk)
                } else {
                    Image(systemName: model.isStreaming ? "stop.fill" : "arrow.up")
                        .font(.system(size: model.isStreaming ? 13 : 18, weight: .semibold))
                }
            }
            .foregroundStyle(sendColors.foreground)
            .frame(width: 34, height: 34)
            .background(sendColors.background.opacity(model.isStreaming || model.canSend ? 1 : 0.3), in: Circle())
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(model.isStreaming ? model.isStopping : !model.canSend)
        .accessibilityLabel(model.isStreaming ? "Stop" : "Send")
    }

    private var sendColors: (background: Color, foreground: Color) {
        model.usesBubbles ? PortalTheme.bubbleTint(model.assistantIcon) : (PortalTheme.ink, PortalTheme.onInk)
    }

    private var commandsPicker: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Commands").font(.subheadline.weight(.semibold))
                Spacer()
                Button { showCommands = false } label: {
                    Image(systemName: "xmark").font(.caption).frame(width: 44, height: 44)
                }.buttonStyle(.plain).accessibilityLabel("Close commands")
            }.padding(.leading, 14)
            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    if model.commands.isEmpty {
                        Text("No commands are available in this chat. Bots can offer skills here, and Hermes bots offer chat controls.")
                            .font(.subheadline).foregroundStyle(PortalTheme.muted).padding(10)
                    } else {
                        ForEach([false, true], id: \.self) { skills in
                            let options = model.commands.filter { $0.isSkill == skills }
                            if !options.isEmpty {
                                Text(skills ? "Skills for this bot" : model.target?.hermes == true ? "Hermes controls" : "Commands")
                                    .font(.caption.weight(.medium)).foregroundStyle(PortalTheme.subtle)
                                    .padding(.horizontal, 10).padding(.top, 4)
                                ForEach(options) { command in
                                    Button {
                                        model.composerText = ComposerCommands.inserting(command.value, into: model.composerText)
                                        showCommands = false
                                        focusRequest += 1
                                    } label: {
                                        VStack(alignment: .leading, spacing: 4) {
                                            Text(command.value).font(.system(.subheadline, design: .monospaced))
                                            Text(command.description).font(.caption).foregroundStyle(PortalTheme.muted)
                                        }.frame(maxWidth: .infinity, alignment: .leading).padding(10).contentShape(Rectangle())
                                    }.buttonStyle(.plain)
                                }
                            }
                        }
                    }
                    Text("Adds to your draft. Tap Send to run; Return adds a new line.")
                        .font(.caption).foregroundStyle(PortalTheme.muted).padding(10)
                    if let warning = model.commandCatalog?.capabilityWarning { Text(warning).font(.caption).foregroundStyle(PortalTheme.muted).padding(10) }
                }.padding(.horizontal, 4)
            }
            .frame(maxHeight: 380)
        }
        .frame(idealWidth: 320, maxWidth: 360)
        .background(PortalTheme.surface)
    }

    private func send() {
        dictation.stop()
        guard model.canSend else { return }
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        model.send()
    }

    private func handlePhotos(_ items: [PhotosPickerItem]) {
        guard !items.isEmpty else { return }
        photoItems = []
        for (index, item) in items.enumerated() {
            Task {
                do {
                    guard let data = try await item.loadTransferable(type: Data.self) else { return }
                    let jpeg = UIImage(data: data)?.jpegData(compressionQuality: 0.85)
                    let name = items.count > 1 ? "photo-\(index + 1).jpg" : "photo.jpg"
                    if let jpeg {
                        model.addAttachment(data: jpeg, filename: name, mediaType: "image/jpeg")
                    } else {
                        model.addAttachment(data: data, filename: "image", mediaType: "application/octet-stream")
                    }
                } catch {
                    app.showBanner("Couldn't load the photo: \(error.localizedDescription)", isError: true)
                }
            }
        }
    }

    private func handleImport(_ result: Result<[URL], Error>) {
        switch result {
        case .success(let urls):
            for url in urls {
                model.importFile(at: url)
            }
        case .failure(let error):
            app.showBanner(error.localizedDescription, isError: true)
        }
    }
}

/// UITextView preserves native selection, dictation, IME composition and multiline Return.
/// Submission belongs exclusively to the explicit Send button above.
@MainActor
private struct MultilineComposer: UIViewRepresentable {
    @Binding var text: String
    var focusRequest: Int
    var maximumLines: Int
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    func makeUIView(context: Context) -> UITextView {
        let view = FocusableComposerTextView()
        view.delegate = context.coordinator
        view.accessibilityIdentifier = "chatComposer"
        view.backgroundColor = .clear
        view.font = .preferredFont(forTextStyle: .body)
        view.adjustsFontForContentSizeCategory = true
        view.textContainerInset = UIEdgeInsets(top: 11, left: 0, bottom: 11, right: 0)
        view.textContainer.lineFragmentPadding = 0
        view.returnKeyType = .default
        view.enablesReturnKeyAutomatically = false
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        context.coordinator.parent = self
        if view.text != text && view.markedTextRange == nil { view.text = text }
        view.font = .preferredFont(forTextStyle: .body)
        view.textColor = UIColor(PortalTheme.ink)
        view.tintColor = UIColor(PortalTheme.ink)
        view.keyboardAppearance = colorScheme == .dark ? .dark : .light
        if context.coordinator.lastFocusRequest != focusRequest {
            context.coordinator.lastFocusRequest = focusRequest
            (view as? FocusableComposerTextView)?.requestFocus()
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
        guard let width = proposal.width, width > 0 else { return nil }
        let natural = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
        let maximum = min(220, (uiView.font?.lineHeight ?? 20) * CGFloat(maximumLines) + 22)
        uiView.isScrollEnabled = natural > maximum
        return CGSize(width: width, height: min(maximum, max(44, natural)))
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }
    final class Coordinator: NSObject, UITextViewDelegate {
        var lastFocusRequest = 0
        var parent: MultilineComposer
        init(_ parent: MultilineComposer) { self.parent = parent }
        func textViewDidChange(_ textView: UITextView) {
            parent.text = textView.text
            textView.invalidateIntrinsicContentSize()
        }
    }
}

/// Honor focus after UIKit attaches the input, instead of consuming a request before its window exists.
@MainActor
private final class FocusableComposerTextView: UITextView {
    private var focusPending = false
    func requestFocus() {
        focusPending = true
        focusIfAttached()
    }
    override func didMoveToWindow() {
        super.didMoveToWindow()
        focusIfAttached()
    }
    private func focusIfAttached() {
        guard focusPending, window != nil else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self, self.focusPending, self.window != nil else { return }
            self.focusPending = !self.becomeFirstResponder()
        }
    }
}

@MainActor
struct AttachmentChip: View {
    let attachment: ComposerAttachment
    let onRemove: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            thumbnail
            VStack(alignment: .leading, spacing: 3) {
                Text(attachment.filename)
                    .font(.caption)
                    .lineLimit(1)
                if let errorText = attachment.errorText {
                    Text(errorText)
                        .font(.caption2)
                        .foregroundStyle(Color.red)
                        .lineLimit(1)
                } else if attachment.isUploading {
                    ProgressView(value: attachment.progress)
                        .frame(width: 80)
                } else {
                    Text("Ready")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            Button(action: onRemove) {
                Image(systemName: "xmark.circle.fill")
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Remove attachment")
        }
        .padding(6)
        .frame(maxWidth: 230)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color(uiColor: .secondarySystemBackground))
        )
    }

    @ViewBuilder
    private var thumbnail: some View {
        if let data = attachment.previewData, let image = UIImage(data: data) {
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
                .frame(width: 36, height: 36)
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        } else {
            Image(systemName: "doc")
                .font(.title3)
                .foregroundStyle(.secondary)
                .frame(width: 36, height: 36)
        }
    }
}
