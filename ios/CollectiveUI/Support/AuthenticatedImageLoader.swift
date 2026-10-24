import SwiftUI
import Observation
import CollectiveKit

@MainActor
@Observable
final class AuthenticatedImageLoader {
    private(set) var request: AuthenticatedImageRequest?
    private(set) var image: UIImage?
    private(set) var failed = false
    @ObservationIgnored private var attempt = UUID()
    @ObservationIgnored private let cache: ImageCache

    init(cache: ImageCache? = nil) { self.cache = cache ?? .shared }

    func load(resource: String, app: AppModel) async {
        let current = AuthenticatedImageRequest(app: app, resource: resource)
        let attempt = UUID()
        self.attempt = attempt
        request = current
        image = nil
        failed = false
        guard !Task.isCancelled else { return }
        guard let api = app.api, api.token != nil else { failed = true; return }
        if let cached = cache.image(for: current) { image = cached; return }
        do {
            let data = try await api.loadData(from: resource)
            guard !Task.isCancelled, self.attempt == attempt, app.api === api,
                  app.settingsAccess.generation == current.generation else { return }
            guard let loaded = UIImage(data: data) else { failed = true; return }
            cache.store(loaded, for: current)
            image = loaded
        } catch {
            guard !Task.isCancelled, self.attempt == attempt, app.api === api,
                  app.settingsAccess.generation == current.generation else { return }
            if !error.isCancellation { failed = true }
        }
    }
}
