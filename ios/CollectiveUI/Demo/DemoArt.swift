#if DEBUG
import UIKit

/// Draws the bar chart served as `/api/files/demo-image` in demo mode.
@MainActor
enum DemoArt {
    static let weeklySignups: [CGFloat] = [610, 655, 640, 700, 735, 760, 1240, 790, 820, 690, 670, 860, 905]

    /// A synthetic imported-pet atlas exercises the real authenticated image loader, without a server.
    static func petAtlasPNG(version: Int) -> Data {
        let rows = version == 2 ? 11 : 9
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = false
        return UIGraphicsImageRenderer(size: CGSize(width: 1536, height: rows * 208), format: format).pngData { renderer in
            for row in 0..<rows {
                for column in 0..<8 {
                    let context = renderer.cgContext
                    context.saveGState()
                    let bob = sin(Double(column) / 6 * .pi * 2) * 4
                    context.translateBy(x: CGFloat(column * 192), y: CGFloat(row * 208) + bob)
                    let color = version == 2 ? UIColor(red: 0.55, green: 0.36, blue: 0.97, alpha: 1) : UIColor(red: 0.12, green: 0.7, blue: 0.6, alpha: 1)
                    UIColor.black.withAlphaComponent(0.10).setFill()
                    UIBezierPath(ovalIn: CGRect(x: 48, y: 182, width: 96, height: 9)).fill()
                    color.setFill()
                    UIBezierPath(roundedRect: CGRect(x: 49, y: 58, width: 94, height: 114), cornerRadius: 29).fill()
                    UIBezierPath(roundedRect: CGRect(x: 37, y: 107, width: 20, height: 43), cornerRadius: 10).fill()
                    UIBezierPath(roundedRect: CGRect(x: 135, y: 107, width: 20, height: 43), cornerRadius: 10).fill()
                    UIBezierPath(roundedRect: CGRect(x: 61, y: 161, width: 23, height: 23), cornerRadius: 9).fill()
                    UIBezierPath(roundedRect: CGRect(x: 108, y: 161, width: 23, height: 23), cornerRadius: 9).fill()
                    UIBezierPath(roundedRect: CGRect(x: 92, y: 32, width: 8, height: 33), cornerRadius: 4).fill()
                    UIBezierPath(ovalIn: CGRect(x: 86, y: 21, width: 20, height: 20)).fill()
                    UIColor(red: 0.13, green: 0.10, blue: 0.22, alpha: 1).setFill()
                    UIBezierPath(roundedRect: CGRect(x: 61, y: 81, width: 70, height: 51), cornerRadius: 18).fill()
                    UIColor.white.setFill()
                    for x in [77, 107] {
                        UIBezierPath(roundedRect: CGRect(x: x, y: column == 5 ? 103 : 94, width: 8, height: column == 5 ? 4 : 17), cornerRadius: 4).fill()
                    }
                    context.restoreGState()
                }
            }
        }
    }

    static func chartPNG() -> Data {
        let size = CGSize(width: 600, height: 600)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        let purple = UIColor(red: 0.545, green: 0.361, blue: 0.965, alpha: 1)
        let pink = UIColor(red: 0.925, green: 0.282, blue: 0.6, alpha: 1)
        let values = weeklySignups
        return renderer.pngData { context in
            UIColor.white.setFill()
            context.fill(CGRect(origin: .zero, size: size))

            let titleAttributes: [NSAttributedString.Key: Any] = [
                .font: UIFont.systemFont(ofSize: 30, weight: .semibold),
                .foregroundColor: UIColor(white: 0.15, alpha: 1),
            ]
            ("Weekly sign-ups, Q3" as NSString).draw(at: CGPoint(x: 40, y: 34), withAttributes: titleAttributes)
            let subtitleAttributes: [NSAttributedString.Key: Any] = [
                .font: UIFont.systemFont(ofSize: 20, weight: .regular),
                .foregroundColor: UIColor(white: 0.45, alpha: 1),
            ]
            ("10,075 sign-ups · up 18% on Q2" as NSString).draw(at: CGPoint(x: 40, y: 76), withAttributes: subtitleAttributes)

            let chart = CGRect(x: 40, y: 140, width: 520, height: 380)
            let maxValue: CGFloat = 1300
            UIColor(white: 0.9, alpha: 1).setStroke()
            for step in 0...4 {
                let y = chart.maxY - CGFloat(step) * chart.height / 4
                let line = UIBezierPath()
                line.move(to: CGPoint(x: chart.minX, y: y))
                line.addLine(to: CGPoint(x: chart.maxX, y: y))
                line.lineWidth = 1
                line.stroke()
            }

            let slot = chart.width / CGFloat(values.count)
            let barWidth = slot * 0.64
            let labelAttributes: [NSAttributedString.Key: Any] = [
                .font: UIFont.systemFont(ofSize: 15, weight: .medium),
                .foregroundColor: UIColor(white: 0.5, alpha: 1),
            ]
            for (index, value) in values.enumerated() {
                let height = chart.height * value / maxValue
                let bar = CGRect(
                    x: chart.minX + slot * CGFloat(index) + (slot - barWidth) / 2,
                    y: chart.maxY - height,
                    width: barWidth,
                    height: height
                )
                (index == 6 ? pink : purple).setFill()
                UIBezierPath(roundedRect: bar, cornerRadius: 6).fill()
                if index % 2 == 0 {
                    ("W\(index + 1)" as NSString).draw(at: CGPoint(x: bar.minX - 2, y: chart.maxY + 12), withAttributes: labelAttributes)
                }
            }
        }
    }
}
#endif
