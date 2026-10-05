#if DEBUG
import UIKit

/// Draws the bar chart served as `/api/files/demo-image` in demo mode.
@MainActor
enum DemoArt {
    static let weeklySignups: [CGFloat] = [610, 655, 640, 700, 735, 760, 1240, 790, 820, 690, 670, 860, 905]

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
