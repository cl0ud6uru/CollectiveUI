import SwiftUI
import UIKit
import CollectiveKit

/// Loads `/api/files/<id>` (or a data: URL) through the API client so the Authorization header is sent.
@MainActor
struct AuthenticatedImage: View {
    @Environment(AppModel.self) private var app
    let url: String
    var contentMode: ContentMode = .fill

    @State private var loader = AuthenticatedImageLoader()

    var body: some View {
        let request = AuthenticatedImageRequest(app: app, resource: url)
        ZStack {
            if loader.request == request, let image = loader.image {
                Image(uiImage: image)
                    .resizable()
                    .aspectRatio(contentMode: contentMode)
            } else if loader.request == request, loader.failed {
                Image(systemName: "photo")
                    .font(.title2)
                    .foregroundStyle(.secondary)
            } else {
                ProgressView()
            }
        }
        .task(id: request) {
            await loader.load(resource: url, app: app)
        }
    }
}

/// A file attached to a message: image thumbnail or a document chip.
@MainActor
struct FileAttachmentView: View {
    @Environment(AppModel.self) private var app
    let file: FilePart
    @State private var showFullImage = false

    var body: some View {
        if file.isImage {
            AuthenticatedImage(url: file.url)
                .frame(width: 180, height: 180)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .contentShape(Rectangle())
                .onTapGesture {
                    showFullImage = true
                }
                .sheet(isPresented: $showFullImage) {
                    ImagePreviewSheet(url: file.url)
                        .environment(app)
                }
        } else {
            Label(file.filename ?? "Attachment", systemImage: "doc")
                .font(.footnote)
                .lineLimit(1)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(Capsule().fill(Color(uiColor: .secondarySystemBackground)))
        }
    }
}

@MainActor
struct ImagePreviewSheet: View {
    let url: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            AuthenticatedImage(url: url, contentMode: .fit)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color.black)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") {
                            dismiss()
                        }
                    }
                }
        }
    }
}
