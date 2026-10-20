import Foundation
import ImageIO
import CollectiveKit

/// Decoded thumbnails are scoped to one native session generation and artwork revision.
/// No token or persistent image cache is used. Invalid artwork falls back to the bot's blob.
@MainActor
final class BotArtworkCache {
    static let shared = BotArtworkCache()
    private let cache = NSCache<NSString, BotArtwork>()
    private var pending: [String: Task<BotArtwork?, Never>] = [:]

    init() { cache.totalCostLimit = 8 * 1024 * 1024 }

    func image(for key: String) -> BotArtwork? { cache.object(forKey: key as NSString) }

    func store(_ artwork: BotArtwork, for key: String) {
        cache.setObject(artwork, forKey: key as NSString,
            cost: artwork.image.bytesPerRow * artwork.image.height)
    }

    func load(path: String, key: String, version: Int?, cellSize: CGFloat, api: APIClient) async -> BotArtwork? {
        if let cached = image(for: key) { return cached }
        if let task = pending[key] { return await task.value }
        let task = Task { @MainActor in
            for attempt in 0..<2 {
                do {
                    let data = try await api.loadData(from: path)
                    guard !Task.isCancelled else { return nil as BotArtwork? }
                    return Self.decode(data, version: version, cellSize: cellSize)
                } catch {
                    if Task.isCancelled || error.isCancellation || error.isUnauthorized { return nil }
                    if attempt == 0 {
                        do { try await Task.sleep(for: .milliseconds(500)) } catch { return nil }
                    }
                }
            }
            return nil
        }
        pending[key] = task
        let artwork = await task.value
        pending[key] = nil
        if let artwork { store(artwork, for: key) }
        return artwork
    }

    static func decode(_ data: Data, version: Int?, cellSize: CGFloat) -> BotArtwork? {
        guard data.count <= 4 * 1024 * 1024,
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int,
              width == 1536, [1872, 2288].contains(height),
              version == nil || (version == 1 && height == 1872) || (version == 2 && height == 2288)
        else { return nil }
        let rows = height / 208
        let longestSide = max(cellSize * 8, cellSize * 208 / 192 * CGFloat(rows))
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceThumbnailMaxPixelSize: Int(min(max(longestSide, 1), 2288)),
            kCGImageSourceShouldCacheImmediately: true,
        ] as CFDictionary) else { return nil }
        return BotArtwork(image: image, rows: rows)
    }
}
