import SwiftUI
import UIKit
import CollectiveKit

/// In-memory cache for images fetched with the bearer token.
final class ImageCache: @unchecked Sendable {
    static let shared = ImageCache()

    private let cache = NSCache<NSString, UIImage>()

    init() {
        cache.countLimit = 150
    }

    func image(for key: String) -> UIImage? {
        return cache.object(forKey: key as NSString)
    }

    func store(_ image: UIImage, for key: String) {
        cache.setObject(image, forKey: key as NSString)
    }
}

/// Loads `/api/files/<id>` (or a data: URL) through the API client so the Authorization header is sent.
@MainActor
struct AuthenticatedImage: View {
    @Environment(AppModel.self) private var app
    let url: String
    var contentMode: ContentMode = .fill

    @State private var image: UIImage? = nil
    @State private var failed = false

    var body: some View {
        ZStack {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .aspectRatio(contentMode: contentMode)
            } else if failed {
                Image(systemName: "photo")
                    .font(.title2)
                    .foregroundStyle(.secondary)
            } else {
                ProgressView()
            }
        }
        .task(id: url) {
            await load()
        }
    }

    private func load() async {
        if let cached = ImageCache.shared.image(for: url) {
            image = cached
            return
        }
        guard let api = app.api else {
            failed = true
            return
        }
        do {
            let data = try await api.loadData(from: url)
            if let loaded = UIImage(data: data) {
                ImageCache.shared.store(loaded, for: url)
                image = loaded
            } else {
                failed = true
            }
        } catch {
            if !error.isCancellation {
                failed = true
            }
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
