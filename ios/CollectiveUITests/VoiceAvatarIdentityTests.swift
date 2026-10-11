import XCTest
import CoreGraphics
import ImageIO
import CollectiveKit
@testable import CollectiveUI

final class VoiceAvatarIdentityTests: XCTestCase {
    private func pet() throws -> PetAppearance {
        try JSONDecoder().decode(PetAppearance.self, from: Data("""
        {"enabled":true,"appearance":"catalog","motion":"still","spriteVersionNumber":2,"spriteUrl":"/api/mobile/v1/bots/bot1/pet/avatar?v=r1"}
        """.utf8))
    }
    private func png(width: Int, height: Int) throws -> Data {
        let context = try XCTUnwrap(CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
            bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        let image = try XCTUnwrap(context.makeImage())
        let data = NSMutableData()
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(data, "public.png" as CFString, 1, nil))
        CGImageDestinationAddImage(destination, image, nil)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        return data as Data
    }
    func testKeepsOriginalIconAndPersonalStillPreferenceWithoutServerURL() throws {
        let identity = VoiceAvatarIdentity.metadata(botId: "bot1", icon: "blob:ghost:teal", pet: try pet())
        XCTAssertEqual(identity["icon"] as? String, "blob:ghost:teal")
        let appearance = try XCTUnwrap(identity["pet"] as? [String: Any])
        XCTAssertEqual(appearance["motion"] as? String, "still")
        XCTAssertNil(appearance["spriteUrl"])
    }
    func testAcceptsOnlyBoundedCanonicalPNGAtlasBytes() throws {
        let identity = VoiceAvatarIdentity.metadata(botId: "bot1", icon: "blob:ghost:teal", pet: try pet())
        let bytes = try png(width: 1536, height: 2288)
        let atlas = try VoiceAvatarIdentity.addingAtlas(bytes, to: identity, version: 2)
        let appearance = try XCTUnwrap(atlas["pet"] as? [String: Any])
        XCTAssertTrue((appearance["spriteUrl"] as? String)?.hasPrefix("data:image/png;base64,") == true)
        XCTAssertThrowsError(try VoiceAvatarIdentity.addingAtlas(bytes, to: identity, version: 1))
        XCTAssertThrowsError(try VoiceAvatarIdentity.addingAtlas(Data("invalid".utf8), to: identity, version: 2))
        XCTAssertThrowsError(try VoiceAvatarIdentity.addingAtlas(try png(width: 8, height: 8), to: identity, version: 2))
        XCTAssertThrowsError(try VoiceAvatarIdentity.addingAtlas(Data(count: 4 * 1024 * 1024 + 1), to: identity, version: 2))
    }
}
