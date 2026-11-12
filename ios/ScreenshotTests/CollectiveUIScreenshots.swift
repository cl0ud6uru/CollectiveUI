import XCTest
import UIKit

/// Screenshot-only checks against the separate offline QA app, not the user's app.
@MainActor
final class CollectiveUIScreenshots: XCTestCase {
    private let app = XCUIApplication(bundleIdentifier: "io.collectiveui.qa")

    override func setUp() {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
    }

    override func tearDown() {
        app.terminate()
    }

    func testIPadResearchScreenshots() {
        XCTAssertEqual(UIDevice.current.userInterfaceIdiom, .pad)
        captureResearch(appearance: "light", name: "ipad-01-research-chat")
        captureResearch(appearance: "dark", name: "ipad-dark-01-research-chat")
    }

    private func captureResearch(appearance: String, name: String) {
        app.launchArguments = ["--demo", "--demo-open", "demo-research",
                               "--demo-appearance", appearance, "--demo-reset-drafts"]
        app.launch()

        // Launch can return while the shell is still loading on a cold simulator.
        // Wait for content unique to this conversation, not its sidebar label.
        let transcript = app.scrollViews["chat.transcript"]
        let paragraph = transcript.staticTexts["chat.latestReplyParagraph"]
        XCTAssertTrue(paragraph.waitForExistence(timeout: 60), "The research transcript must finish loading")
        XCTAssertEqual(paragraph.label, "With pgvector, start with an HNSW index:")
        XCTAssertTrue(paragraph.wait(for: \.isHittable, toEqual: true, timeout: 10))
        XCTAssertTrue(app.textViews["chatComposer"].wait(for: \.isHittable, toEqual: true, timeout: 10))
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 5))
        let visibleTranscript = transcript.frame.intersection(app.frame)
        let visibleParagraph = paragraph.frame.intersection(visibleTranscript)
        XCTAssertFalse(visibleParagraph.isNull || visibleParagraph.isEmpty,
                       "Research content must be on screen before taking the screenshot")

        // Capture before XCTest tears down the app; a later simctl shot could show Home.
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
