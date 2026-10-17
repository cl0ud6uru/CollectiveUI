import CoreGraphics

final class BotArtwork {
    let image: CGImage
    let rows: Int

    init(image: CGImage, rows: Int) {
        self.image = image
        self.rows = rows
    }
}
