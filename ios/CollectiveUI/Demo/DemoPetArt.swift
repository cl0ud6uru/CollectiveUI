#if DEBUG
import Foundation
import CoreGraphics
import ImageIO

/// Synthetic atlas for the authenticated native image path on both Apple platforms.
/// These are offline transport fixtures, independent of the user's pet choices.
enum DemoPetArt {
    static func atlasPNG(version: Int) -> Data {
        let rows = version == 2 ? 11 : 9
        guard let context = CGContext(data: nil, width: 1536, height: rows * 208,
            bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return Data() }
        context.translateBy(x: 0, y: CGFloat(rows * 208))
        context.scaleBy(x: 1, y: -1)
        for row in 0..<rows {
            for column in 0..<8 {
                context.saveGState()
                context.translateBy(x: CGFloat(column * 192), y: CGFloat(row * 208))
                let color = version == 2 ? CGColor(red: 0.55, green: 0.36, blue: 0.97, alpha: 1)
                    : CGColor(red: 0.12, green: 0.7, blue: 0.6, alpha: 1)
                func rounded(_ rect: CGRect, radius: CGFloat, color: CGColor) {
                    context.setFillColor(color)
                    context.addPath(CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil))
                    context.fillPath()
                }
                rounded(CGRect(x: 49, y: 58, width: 94, height: 114), radius: 29, color: color)
                rounded(CGRect(x: 92, y: 32, width: 8, height: 33), radius: 4, color: color)
                rounded(CGRect(x: 37, y: 107, width: 20, height: 43), radius: 10, color: color)
                rounded(CGRect(x: 135, y: 107, width: 20, height: 43), radius: 10, color: color)
                rounded(CGRect(x: 61, y: 161, width: 23, height: 23), radius: 9, color: color)
                rounded(CGRect(x: 108, y: 161, width: 23, height: 23), radius: 9, color: color)
                rounded(CGRect(x: 61, y: 81, width: 70, height: 51), radius: 18,
                    color: CGColor(red: 0.13, green: 0.10, blue: 0.22, alpha: 1))
                for x in [77, 107] {
                    rounded(CGRect(x: x, y: 94, width: 8, height: column == 5 ? 4 : 17), radius: 4,
                        color: CGColor(gray: 1, alpha: 1))
                }
                context.restoreGState()
            }
        }
        guard let image = context.makeImage() else { return Data() }
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, "public.png" as CFString, 1, nil) else { return Data() }
        CGImageDestinationAddImage(destination, image, nil)
        return CGImageDestinationFinalize(destination) ? data as Data : Data()
    }
}
#endif
