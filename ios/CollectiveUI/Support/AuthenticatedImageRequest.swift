import Foundation

/// A relative attachment URL is meaningful only within the server and credential session that supplied it.
struct AuthenticatedImageRequest: Hashable {
    let generation: UUID
    let server: URL?
    let resource: String

    @MainActor
    init(app: AppModel, resource: String) {
        generation = app.settingsAccess.generation
        server = app.api?.baseURL
        self.resource = resource
    }

    var cacheKey: String { generation.uuidString + "\0" + (server?.absoluteString ?? "") + "\0" + resource }
}
