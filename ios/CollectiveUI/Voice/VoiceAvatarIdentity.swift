import Foundation
import ImageIO
import CollectiveKit

/// Effective chat identity only. Device tokens and server URLs never enter the engine.
enum VoiceAvatarIdentity {
    static func metadata(botId: String?, icon: String?, pet: PetAppearance?) -> [String: Any] {
        var result: [String: Any] = ["icon": icon ?? "🤖"]
        if let botId { result["botId"] = botId }
        if let pet, pet.enabled {
            var appearance: [String: Any] = ["enabled": true, "appearance": pet.appearance, "motion": pet.motion]
            if let version = pet.spriteVersionNumber { appearance["spriteVersionNumber"] = version }
            result["pet"] = appearance
        }
        return result
    }

    static func addingAtlas(_ data: Data, to identity: [String: Any], version: Int) throws -> [String: Any] {
        guard data.count <= 4 * 1024 * 1024, [1, 2].contains(version),
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              CGImageSourceGetType(source) as String? == "public.png",
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              properties[kCGImagePropertyPixelWidth] as? Int == 1536,
              properties[kCGImagePropertyPixelHeight] as? Int == (version == 2 ? 2288 : 1872),
              var pet = identity["pet"] as? [String: Any] else { throw APIError.invalidResponse }
        pet["spriteUrl"] = "data:image/png;base64," + data.base64EncodedString()
        var result = identity
        result["pet"] = pet
        return result
    }
}
