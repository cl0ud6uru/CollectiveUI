import XCTest
import UIKit

/// Runs only against the separately installed QA bundle and offline fixtures.
@MainActor
final class CollectiveUIRegression: XCTestCase {
    private let app = XCUIApplication(bundleIdentifier: "io.collectiveui.qa")

    override func setUp() {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
    }

    override func tearDown() {
        XCUIDevice.shared.orientation = .portrait
        app.terminate()
    }

    private func launch(_ conversation: String = "demo-research", appearance: String = "dark", extra: [String] = [], freshDrafts: Bool = true) {
        app.launchArguments = ["--demo", "--demo-open", conversation, "--demo-appearance", appearance] + extra
        if freshDrafts { app.launchArguments.append("--demo-reset-drafts") }
        app.launch()
        XCTAssertTrue(app.textViews["chatComposer"].waitForExistence(timeout: 15))
    }

    private func tap(_ element: XCUIElement, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(element.waitForExistence(timeout: 5), file: file, line: line)
        XCTAssertTrue(element.isHittable, "Never tap hidden controls or a hidden keyboard preview", file: file, line: line)
        element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    }

    private func capture(_ name: String) {
        let image = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        image.name = name
        image.lifetime = .keepAlways
        add(image)
        let tree = XCTAttachment(string: app.debugDescription)
        tree.name = name + "-hierarchy"
        tree.lifetime = .keepAlways
        add(tree)
    }

    private func settle(_ seconds: TimeInterval) {
        let ready = expectation(description: "Allow UI fixture updates")
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { ready.fulfill() }
        wait(for: [ready], timeout: seconds + 3)
    }

    private func hasVisibleLatestFixtureParagraph(in transcript: XCUIElement) -> Bool {
        let viewport = transcript.frame
        let latest = transcript.staticTexts.matching(NSPredicate(format:
            "identifier == %@ AND label BEGINSWITH %@", "chat.latestReplyParagraph", "QA line ")).element
        guard latest.waitForExistence(timeout: 5) else { return false }
        let deadline = Date().addingTimeInterval(5)
        repeat {
            // Resolve the current tail and its frame together; a separate count can
            // already be overtaken by incoming paragraphs before its frame resolves.
            let frame = latest.frame
            if frame.height > 0 && frame.minY > viewport.minY + 100 && frame.maxY < viewport.maxY {
                return true
            }
            settle(0.2)
        } while Date() < deadline
        return false
    }

    private func enterDraft(_ text: String) {
        let input = app.textViews["chatComposer"]
        XCTAssertEqual(input.value as? String, "", "Each fixture starts with an empty draft")
        tap(input)
        input.typeText(text)
    }

    private func openChat(_ conversationId: String) {
        tap(app.buttons["Open sidebar"])
        let row = app.buttons["conversation." + conversationId]
        for _ in 0..<4 {
            if row.exists && row.isHittable { break }
            if app.collectionViews.firstMatch.exists { app.collectionViews.firstMatch.swipeUp() }
            else if app.tables.firstMatch.exists { app.tables.firstMatch.swipeUp() }
            else { app.swipeUp() }
        }
        print("SIDEBAR_BUTTONS: " + app.buttons.allElementsBoundByIndex.map { $0.label }.joined(separator: " | "))
        capture("sidebar-" + conversationId)
        tap(row)
        XCTAssertTrue(app.textViews["chatComposer"].waitForExistence(timeout: 10))
    }

    func testAdministratorSettingsNavigateToTheRealWebsiteWithoutOpeningTheNetwork() {
        app.launchArguments = ["--demo", "--demo-screen", "settings", "--demo-appearance", "dark"]
        app.launch()
        tap(app.buttons["settings.section.admin"])
        XCTAssertTrue(app.buttons["settings.users"].waitForExistence(timeout: 5))
        capture("parity-admin-destinations")
        tap(app.buttons["settings.users"])
        XCTAssertTrue(app.staticTexts["settings.destinationURL"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["settings.destinationURL"].label, "https://demo.collectiveui.app/admin/users")
        XCTAssertTrue(app.staticTexts["settings.offline"].exists)
        XCTAssertFalse(app.buttons["settings.openWebsite"].exists)
        capture("parity-admin-users-handoff")
    }

    func testMemberSettingsHideAdministrationAndNavigatePersonalSecurity() {
        app.launchArguments = ["--demo", "--demo-screen", "settings", "--demo-role", "member", "--demo-appearance", "light"]
        app.launch()
        XCTAssertTrue(app.buttons["settings.section.account"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.buttons["settings.section.admin"].exists)
        let security = app.buttons["settings.security"]
        for _ in 0..<4 {
            if security.exists && security.isHittable { break }
            app.scrollViews["settings.content"].swipeUp()
        }
        capture("parity-member-settings")
        tap(security)
        XCTAssertTrue(app.staticTexts["settings.destinationURL"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["settings.destinationURL"].label, "https://demo.collectiveui.app/settings?tab=security")
        capture("parity-personal-security-handoff")
    }

    func testWelcomeUsesServerBrandingAndOpensANativeModelConversation() {
        app.launchArguments = ["--demo", "--demo-screen", "welcome", "--demo-appearance", "dark", "--demo-reset-drafts"]
        app.launch()
        XCTAssertTrue(app.staticTexts["home.welcome"].waitForExistence(timeout: 15))
        XCTAssertEqual(app.staticTexts["home.welcome"].label, "Welcome back, Jordan.")
        capture("parity-welcome")
        tap(app.buttons["home.target.app-fast"])
        XCTAssertTrue(app.textViews["chatComposer"].waitForExistence(timeout: 10))
        capture("parity-new-native-model-chat")
    }

    func testChatHeaderNeverOverlapsTheTranscriptViewport() {
        launch("demo-research")
        let header = app.otherElements["chat.header"]
        let transcript = app.scrollViews["chat.transcript"]
        XCTAssertTrue(header.waitForExistence(timeout: 5))
        XCTAssertTrue(transcript.waitForExistence(timeout: 5))
        XCTAssertGreaterThan(header.frame.height, 0)
        XCTAssertGreaterThan(transcript.frame.height, 0)
        XCTAssertGreaterThanOrEqual(transcript.frame.minY, header.frame.maxY)
        capture("parity-readable-chat-header")
    }

    func testDraftsStayWithTheirConversationAndSurviveRelaunch() {
        launch("demo-research")
        let researchDraft = "Research draft\nReturn adds a line"
        let imageDraft = "Chart draft\nKeep separate"
        enterDraft(researchDraft)
        XCTAssertEqual(app.textViews["chatComposer"].value as? String, researchDraft)
        XCTAssertFalse(app.buttons["Stop"].exists, "Newline input must not send")
        openChat("demo-image")
        enterDraft(imageDraft)
        openChat("demo-research")
        XCTAssertEqual(app.textViews["chatComposer"].value as? String, researchDraft)
        capture("draft-restored-after-switch")

        app.terminate()
        launch("demo-research", freshDrafts: false)
        XCTAssertEqual(app.textViews["chatComposer"].value as? String, researchDraft)
        openChat("demo-image")
        XCTAssertEqual(app.textViews["chatComposer"].value as? String, imageDraft)
    }

    func testIncomingChunksRespectScrollAwayAndJumpRestartsFollowing() throws {
        launch("demo-research", extra: ["--demo-stream-scenario", "long"])
        enterDraft("Offline scrolling regression")
        tap(app.buttons["Send"])
        XCTAssertTrue(app.buttons["Stop"].waitForExistence(timeout: 10))
        settle(4)
        let transcript = app.scrollViews["chat.transcript"]
        let paragraphs = transcript.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "QA line "))
        XCTAssertTrue(hasVisibleLatestFixtureParagraph(in: transcript), "The growing reply must render before the reader scrolls")
        // The transcript extends behind the sticky header; start in visible message content.
        let dragStart = transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        let dragEnd = transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.9))
        dragStart.press(forDuration: 0.1, thenDragTo: dragEnd)
        capture("stream-after-reader-gesture")
        XCTAssertTrue(app.buttons["Scroll to latest message"].waitForExistence(timeout: 5))
        capture("stream-scrolled-away")
        // Compare an already-rendered paragraph while new paragraphs arrive below it.
        // Read one public accessibility snapshot rather than making a remote frame
        // query for every offscreen paragraph while the fixture keeps advancing.
        let snapshot = try transcript.snapshot()
        var pending: [any XCUIElementSnapshot] = [snapshot]
        var visible: [any XCUIElementSnapshot] = []
        while let node = pending.popLast() {
            if node.elementType == .staticText, node.label.hasPrefix("QA line "),
               node.frame.height > 0, node.frame.minY > snapshot.frame.minY + 100,
               node.frame.maxY < snapshot.frame.maxY {
                visible.append(node)
            }
            pending.append(contentsOf: node.children)
        }
        guard let reference = visible.min(by: { $0.frame.minY < $1.frame.minY }) else {
            return XCTFail("No visible fixture paragraph after scrolling away")
        }
        let older = paragraphs.matching(NSPredicate(format: "label == %@", reference.label)).element
        let initialY = older.frame.minY
        let latest = transcript.staticTexts["chat.latestReplyParagraph"]
        let initialLatestLabel = latest.label
        settle(2)
        XCTAssertTrue(app.buttons["Stop"].exists, "Fixture must still stream during the assertion")
        XCTAssertNotEqual(latest.label, initialLatestLabel, "New paragraphs must arrive during the viewport assertion")
        XCTAssertTrue(older.exists && older.frame.height > 0, "The visible reply must remain rendered while chunks arrive")
        XCTAssertEqual(older.frame.minY, initialY, accuracy: 6, "Incoming chunks must preserve the reader's viewport")
        capture("stream-scrolled-away-after-updates")
        tap(app.buttons["Scroll to latest message"])
        settle(1)
        XCTAssertFalse(app.buttons["Scroll to latest message"].exists)
        XCTAssertTrue(hasVisibleLatestFixtureParagraph(in: transcript), "Jumping to the latest reply must not leave a blank transcript")
        tap(app.buttons["Stop"])
        capture("stream-after-jump-and-stop")
    }

    func testStoppingBeforeOutputShowsAnExplicitState() {
        launch("demo-research", extra: ["--demo-stream-scenario", "delayed"])
        enterDraft("Offline immediate cancellation regression")
        tap(app.buttons["Send"])
        XCTAssertTrue(app.buttons["Stop"].waitForExistence(timeout: 10))
        tap(app.buttons["Stop"])
        XCTAssertTrue(app.staticTexts["Reply stopped"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["Stop"].exists)
        capture("stopped-before-output")
        openChat("demo-image")
        openChat("demo-research")
        XCTAssertTrue(app.staticTexts["Reply stopped"].waitForExistence(timeout: 10))
    }

    func testLandscapeTranscriptAndComposerStayInsideTheSafeViewport() {
        launch("demo-image")
        enterDraft("Rotation draft\nSecond line\nThird line\nFourth line\nFifth line\nSixth line\nSeventh line")
        let draft = app.textViews["chatComposer"].value as? String
        for orientation in [UIDeviceOrientation.landscapeLeft, .landscapeRight, .portrait] {
            XCUIDevice.shared.orientation = orientation
            settle(1)
            let bounds = app.frame
            let safeLeft = max(bounds.minX, app.buttons["Add attachments or commands"].frame.minX - 16)
            let safeRight = min(bounds.maxX, app.buttons["Send"].frame.maxX + 16)
            let transcript = app.scrollViews["chat.transcript"]
            for text in transcript.staticTexts.allElementsBoundByIndex where text.frame.width > 0 {
                XCTAssertGreaterThanOrEqual(text.frame.minX, safeLeft - 2)
                XCTAssertLessThanOrEqual(text.frame.maxX, safeRight + 2, "Transcript text clips after rotation: " + text.label)
            }
            for image in transcript.images.allElementsBoundByIndex where image.frame.width > 40 {
                XCTAssertGreaterThanOrEqual(image.frame.minX, safeLeft - 2)
                XCTAssertLessThanOrEqual(image.frame.maxX, safeRight + 2)
            }
            XCTAssertTrue(app.buttons["Send"].isHittable)
            XCTAssertLessThanOrEqual(app.buttons["Send"].frame.maxY, bounds.maxY)
            XCTAssertEqual(app.textViews["chatComposer"].value as? String, draft)
            capture("rotation-\(orientation.rawValue)")
        }
    }

    func testVisibleReturnKeyInsertsANewline() throws {
        launch("demo-research", extra: ["--demo-focus"])
        enterDraft("First line")
        let keys = app.keyboards.buttons.matching(NSPredicate(format: "label ==[c] %@", "return"))
        guard let key = keys.allElementsBoundByIndex.first(where: {
            $0.isHittable && $0.frame.maxY <= app.frame.maxY
        }) else {
            capture("software-keyboard-unavailable")
            throw XCTSkip("Simulator software keyboard is hidden; native newline and rotation are covered separately")
        }
        tap(key)
        app.textViews["chatComposer"].typeText("Second line")
        XCTAssertEqual(app.textViews["chatComposer"].value as? String, "First line\nSecond line")
        XCTAssertFalse(app.buttons["Stop"].exists)
        capture("visible-return-newline")
    }

    func testSignInLabelContrastsWithItsFillInBothThemes() {
        for theme in ["dark", "light"] {
            app.launchArguments = ["--demo", "--demo-screen", "signin", "--demo-appearance", theme]
            app.launch()
            let button = app.buttons["Sign in"]
            XCTAssertTrue(button.waitForExistence(timeout: 10))
            XCTAssertTrue(button.isHittable)
            settle(0.5)
            capture("signin-" + theme)
            assertContrastingLabel(in: button)
            app.terminate()
        }
    }

    private func assertContrastingLabel(in button: XCUIElement) {
        guard let cgImage = UIImage(data: app.screenshot().pngRepresentation)?.cgImage else {
            return XCTFail("Couldn't inspect sign-in screenshot")
        }
        let width = cgImage.width, height = cgImage.height
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        guard let context = CGContext(data: &pixels, width: width, height: height, bitsPerComponent: 8,
                                      bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
            return XCTFail("Couldn't decode sign-in screenshot")
        }
        context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
        let scaleX = CGFloat(width) / app.frame.width
        let scaleY = CGFloat(height) / app.frame.height
        let interior = button.frame.insetBy(dx: 48, dy: 10)
        var darkPixels = 0, lightPixels = 0
        for y in Int(interior.minY * scaleY)..<Int(interior.maxY * scaleY) {
            for x in Int(interior.minX * scaleX)..<Int(interior.maxX * scaleX) {
                guard x >= 0, x < width, y >= 0, y < height else { continue }
                let offset = (y * width + x) * 4
                let value = (0.2126 * Double(pixels[offset]) + 0.7152 * Double(pixels[offset + 1])
                             + 0.0722 * Double(pixels[offset + 2])) / 255
                if value < 0.2 { darkPixels += 1 }
                if value > 0.75 { lightPixels += 1 }
            }
        }
        XCTAssertGreaterThan(darkPixels, 20, "Sign-in button must include readable dark/light contrast")
        XCTAssertGreaterThan(lightPixels, 20, "Sign-in button must include readable dark/light contrast")
    }
}
