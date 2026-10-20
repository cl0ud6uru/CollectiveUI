import XCTest
import CollectiveKit
@testable import CollectiveUI

@MainActor
final class BotArtworkTests: XCTestCase {
    override func tearDown() { FixtureProtocol.handler = { _ in .init() } }

    func testBothAtlasVersionsDecodeToBoundedNativeThumbnails() throws {
        for (version, rows) in [(1, 9), (2, 11)] {
            let artwork = try XCTUnwrap(BotArtworkCache.decode(DemoPetArt.atlasPNG(version: version),
                version: version, cellSize: 64))
            XCTAssertEqual(artwork.rows, rows)
            XCTAssertLessThanOrEqual(max(artwork.image.width, artwork.image.height), 763)
        }
    }

    func testInvalidOversizedAndMismatchedArtworkFallsBack() {
        XCTAssertNil(BotArtworkCache.decode(Data("not an image".utf8), version: 2, cellSize: 64))
        XCTAssertNil(BotArtworkCache.decode(Data(repeating: 0, count: 4 * 1024 * 1024 + 1), version: 2, cellSize: 64))
        XCTAssertNil(BotArtworkCache.decode(DemoPetArt.atlasPNG(version: 1), version: 2, cellSize: 64))
        XCTAssertNil(BotArtworkCache.decode(DemoPetArt.atlasPNG(version: 2), version: 3, cellSize: 64))
    }

    func testImageRequestsCarrySessionCredentialsAndCoalesceAcrossViews() async throws {
        let data = DemoPetArt.atlasPNG(version: 2)
        var requests = 0
        FixtureProtocol.handler = { request in
            requests += 1
            XCTAssertEqual(request.url?.path, "/api/mobile/v1/bots/sample/pet/avatar")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer fixture")
            return .init(contentType: "image/png", data: data, delay: 0.05)
        }
        let api = APIClient(baseURL: URL(string: "https://fixture.invalid")!, token: "fixture", session: FixtureProtocol.session())
        let cache = BotArtworkCache()
        async let first = cache.load(path: "/api/mobile/v1/bots/sample/pet/avatar?v=1", key: "session-a", version: 2, cellSize: 64, api: api)
        async let second = cache.load(path: "/api/mobile/v1/bots/sample/pet/avatar?v=1", key: "session-a", version: 2, cellSize: 64, api: api)
        let results = await (first, second)
        XCTAssertNotNil(results.0)
        XCTAssertTrue(results.0 === results.1)
        _ = await cache.load(path: "/api/mobile/v1/bots/sample/pet/avatar?v=1", key: "session-a", version: 2, cellSize: 64, api: api)
        XCTAssertEqual(requests, 1)
        _ = await cache.load(path: "/api/mobile/v1/bots/sample/pet/avatar?v=1", key: "session-b", version: 2, cellSize: 64, api: api)
        XCTAssertEqual(requests, 2, "A replacement session never reuses private artwork from the old generation")
    }

    func testTransientImageFailureRetriesAndInvalidBytesDoNotPoisonCache() async {
        let data = DemoPetArt.atlasPNG(version: 1)
        var requests = 0
        FixtureProtocol.handler = { _ in
            requests += 1
            if requests == 1 { return .init(status: 503) }
            return .init(contentType: "image/png", data: data)
        }
        let api = APIClient(baseURL: URL(string: "https://fixture.invalid")!, token: "fixture", session: FixtureProtocol.session())
        let cache = BotArtworkCache()
        let artwork = await cache.load(path: "/api/mobile/v1/bots/sample/pet/avatar?v=1", key: "retry", version: 1, cellSize: 64, api: api)
        XCTAssertNotNil(artwork)
        XCTAssertEqual(requests, 2)
        FixtureProtocol.handler = { _ in .init(data: Data("invalid".utf8)) }
        let invalid = await cache.load(path: "/api/mobile/v1/bots/sample/pet/avatar?v=2", key: "next", version: 1, cellSize: 64, api: api)
        XCTAssertNil(invalid)
        XCTAssertNil(cache.image(for: "next"))
    }
}
