import UIKit
import ImageIO
import CollectiveKit

/// Packs four still frames of the user's authorized pet into bounded ActivityKit attributes.
/// Images stay on device. A 16-color palette avoids a new App Group entitlement or network access in the widget.
@MainActor
enum ActivityPetEncoder {
    static func encode(pet: PetAppearance?, botId: String, api: APIClient?) async -> String {
        guard let path = pet?.avatarPath(for: botId), let api else { return "" }
        do {
            let data = try await api.loadData(from: path)
            guard data.count <= 4 * 1024 * 1024, let source = CGImageSourceCreateWithData(data as CFData, nil),
                let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
                let width = properties[kCGImagePropertyPixelWidth] as? Int, let height = properties[kCGImagePropertyPixelHeight] as? Int,
                width == 1536, [1872, 2288].contains(height),
                let atlas = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return "" }
            let rows = [0, 7, 6, 5]
            var rgba = [UInt8](repeating: 0, count: 24 * 26 * 4 * 4)
            for (pose, row) in rows.enumerated() {
                guard let frame = atlas.cropping(to: CGRect(x: 0, y: row * 208, width: 192, height: 208)) else { return "" }
                let rendered = UIGraphicsImageRenderer(size: CGSize(width: 24, height: 26), format: {
                    let format = UIGraphicsImageRendererFormat(); format.scale = 1; return format
                }()).image { _ in UIImage(cgImage: frame).draw(in: CGRect(x: 0, y: 0, width: 24, height: 26)) }
                guard let cg = rendered.cgImage else { return "" }
                var bytes = [UInt8](repeating: 0, count: 24 * 26 * 4)
                let ok = bytes.withUnsafeMutableBytes { buffer -> Bool in
                    guard let context = CGContext(data: buffer.baseAddress, width: 24, height: 26, bitsPerComponent: 8, bytesPerRow: 24 * 4,
                        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else { return false }
                    context.draw(cg, in: CGRect(x: 0, y: 0, width: 24, height: 26)); return true
                }
                guard ok else { return "" }
                rgba.replaceSubrange((pose * bytes.count)..<((pose + 1) * bytes.count), with: bytes)
            }
            var histogram: [Int: Int] = [:]
            var colors: [Int] = []
            for i in stride(from: 0, to: rgba.count, by: 4) {
                let a = Int(rgba[i + 3]); var key = -1
                if a >= 96 {
                    let r = min(255, Int(rgba[i]) * 255 / max(1, a)) >> 5
                    let g = min(255, Int(rgba[i + 1]) * 255 / max(1, a)) >> 5
                    let b = min(255, Int(rgba[i + 2]) * 255 / max(1, a)) >> 5
                    key = (r << 6) | (g << 3) | b; histogram[key, default: 0] += 1
                }
                colors.append(key)
            }
            let palette = [-1] + histogram.keys.sorted { histogram[$0] == histogram[$1] ? $0 < $1 : histogram[$0]! > histogram[$1]! }.prefix(15)
            var packed = [UInt8](repeating: 0, count: ActivityPetPixels.byteCount)
            func components(_ key: Int) -> [Int] { [(key >> 6 & 7) * 255 / 7, (key >> 3 & 7) * 255 / 7, (key & 7) * 255 / 7] }
            for (i, color) in palette.enumerated() where color >= 0 {
                let rgb = components(color)
                packed[i * 4] = UInt8(rgb[0]); packed[i * 4 + 1] = UInt8(rgb[1]); packed[i * 4 + 2] = UInt8(rgb[2]); packed[i * 4 + 3] = 255
            }
            for (pixel, color) in colors.enumerated() {
                var index = 0
                if color >= 0 {
                    let rgb = components(color)
                    index = (1..<palette.count).min { a, b in
                        let x = components(palette[a]); let y = components(palette[b])
                        return zip(rgb, x).reduce(0) { $0 + ($1.0 - $1.1) * ($1.0 - $1.1) } < zip(rgb, y).reduce(0) { $0 + ($1.0 - $1.1) * ($1.0 - $1.1) }
                    } ?? 0
                }
                packed[64 + pixel / 2] |= UInt8(pixel % 2 == 0 ? index << 4 : index)
            }
            return Data(packed).base64EncodedString()
        } catch { return "" }
    }
}
