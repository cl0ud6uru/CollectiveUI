import UIKit

@MainActor
final class ImageCache {
    static let shared = ImageCache()
    private let cache = NSCache<NSString, UIImage>()

    init() { cache.countLimit = 150 }

    func image(for request: AuthenticatedImageRequest) -> UIImage? {
        cache.object(forKey: request.cacheKey as NSString)
    }

    func store(_ image: UIImage, for request: AuthenticatedImageRequest) {
        cache.setObject(image, forKey: request.cacheKey as NSString)
    }
}
