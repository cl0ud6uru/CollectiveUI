import SwiftUI
import UIKit
import PhotosUI
import UniformTypeIdentifiers
import CollectiveKit

@MainActor
struct ComposerView: View {
    @Bindable var model: ChatModel
    @Environment(AppModel.self) private var app

    @State private var showPhotoPicker: Bool = false
    @State private var showFileImporter: Bool = false
    @State private var photoItems: [PhotosPickerItem] = []
    @FocusState private var isFocused: Bool

    var body: some View {
        VStack(spacing: 8) {
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

            HStack(alignment: .bottom, spacing: 8) {
                Menu {
                    Button {
                        showPhotoPicker = true
                    } label: {
                        Label("Photo Library", systemImage: "photo.on.rectangle")
                    }
                    Button {
                        showFileImporter = true
                    } label: {
                        Label("Choose File", systemImage: "doc")
                    }
                } label: {
                    Image(systemName: "plus.circle.fill")
                        .font(.system(size: 28))
                        .foregroundStyle(Color.accentColor)
                }
                .disabled(model.isStreaming)
                .accessibilityLabel("Attach")

                TextField("Message", text: $model.composerText, axis: .vertical)
                    .lineLimit(1...6)
                    .focused($isFocused)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(
                        RoundedRectangle(cornerRadius: 20, style: .continuous)
                            .fill(Color(uiColor: .secondarySystemBackground))
                    )

                if model.isStreaming {
                    Button {
                        model.stop()
                    } label: {
                        Image(systemName: "stop.circle.fill")
                            .font(.system(size: 30))
                    }
                    .disabled(model.isStopping)
                    .accessibilityLabel("Stop")
                } else {
                    Button {
                        send()
                    } label: {
                        if model.isUploading {
                            ProgressView()
                                .frame(width: 30, height: 30)
                        } else {
                            Image(systemName: "arrow.up.circle.fill")
                                .font(.system(size: 30))
                        }
                    }
                    .disabled(!model.canSend)
                    .accessibilityLabel("Send")
                }
            }
            .padding(.horizontal, 12)
        }
        .padding(.vertical, 8)
        .background(.bar)
        .photosPicker(isPresented: $showPhotoPicker, selection: $photoItems, maxSelectionCount: 6, matching: .images)
        .fileImporter(isPresented: $showFileImporter, allowedContentTypes: [UTType.item], allowsMultipleSelection: true) { result in
            handleImport(result)
        }
        .onChange(of: photoItems) { _, items in
            handlePhotos(items)
        }
    }

    private func send() {
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
