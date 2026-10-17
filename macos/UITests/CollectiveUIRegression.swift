import XCTest

/// Uses only the separately built QA bundle and its in-memory fixture server.
@MainActor
final class CollectiveUIRegression: XCTestCase {
    private let appURL = URL(fileURLWithPath: ProcessInfo.processInfo.environment["COLLECTIVE_MACOS_QA_APP"]
        ?? "/tmp/collectiveui-macos-polish/Build/Products/Debug/CollectiveUI.app")
    private lazy var app = XCUIApplication(url: appURL)
    private var composer: XCUIElement { app.textViews["chat.composer"] }
    private var isFixtureBundle: Bool { Bundle(url: appURL)?.bundleIdentifier == "io.collectiveui.macos.polish" }

    override func setUp() {
        continueAfterFailure = false
        XCTAssertEqual(Bundle(url: appURL)?.bundleIdentifier, "io.collectiveui.macos.polish",
            "UI automation must never terminate or relaunch the owner's signed-in QA app")
    }

    override func tearDown() {
        guard isFixtureBundle else { return }
        let tree = XCTAttachment(string: app.windows.firstMatch.exists
            ? app.windows.firstMatch.debugDescription : "No application windows")
        tree.name = name + "-hierarchy"
        tree.lifetime = .keepAlways
        add(tree)
        if app.state == .runningForeground, app.windows.firstMatch.exists {
            let screenshot = XCTAttachment(screenshot: app.windows.firstMatch.screenshot())
            screenshot.name = name
            screenshot.lifetime = .keepAlways
            add(screenshot)
        }
        app.terminate()
    }

    private func launch(_ conversation: String = "demo-research", scenario: String? = nil, reset: Bool = true, appearance: String? = nil) {
        app.launchArguments = ["--demo", "--demo-open", conversation]
        if let scenario { app.launchArguments += ["--demo-stream-scenario", scenario] }
        if reset { app.launchArguments.append("--demo-reset-drafts") }
        if let appearance { app.launchArguments += ["-desktopAppearance", appearance] }
        app.launch()
        app.activate()
        XCTAssertTrue(composer.waitForExistence(timeout: 15))
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 5), "The isolated native fixture must activate before interaction")
        // TextEditor can report disabled while still accepting input. Draft helpers
        // verify actual typed text; visibility is the useful prerequisite here.
        XCTAssertTrue(composer.isHittable, "The native editor must be visible before interaction")
    }

    private func enterDraft(_ text: String) {
        composer.click()
        composer.typeKey("a", modifierFlags: .command)
        for (index, line) in text.components(separatedBy: "\n").enumerated() {
            if index > 0 { composer.typeKey(.return, modifierFlags: .shift) }
            if !line.isEmpty { composer.typeText(line) }
        }
        XCTAssertEqual(composer.value as? String, text)
    }

    private func openChat(_ id: String) {
        let row = app.descendants(matching: .any)["sidebar.chat." + id].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        row.click()
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
    }

    func testDraftsSurviveRepeatedNavigationAndRelaunch() {
        launch()
        let first = "Native research draft\nShift Enter inserts a new line"
        let second = "Independent chart draft"
        enterDraft(first)
        XCTAssertFalse(app.buttons["chat.stop"].exists)
        openChat("demo-image")
        enterDraft(second)
        for _ in 0..<3 {
            openChat("demo-research")
            XCTAssertEqual(composer.value as? String, first)
            openChat("demo-image")
            XCTAssertEqual(composer.value as? String, second)
        }
        app.terminate()
        launch(reset: false)
        XCTAssertEqual(composer.value as? String, first)
        openChat("demo-image")
        XCTAssertEqual(composer.value as? String, second)
    }

    func testClosingMainWindowAndRelaunchPreservesDraft() {
        launch()
        let draft = "Draft saved when the main window closes"
        enterDraft(draft)
        app.typeKey("w", modifierFlags: .command)
        // SwiftUI's single Window scene exits when its last window closes.
        XCTAssertTrue(app.wait(for: .notRunning, timeout: 5))
        launch(reset: false)
        XCTAssertEqual(composer.value as? String, draft)
    }

    func testCommandReturnSendsAndImmediateStopPersists() {
        launch(scenario: "delayed")
        enterDraft("Offline native cancellation check")
        composer.typeKey(.return, modifierFlags: .command)
        let stop = app.buttons["chat.stop"]
        XCTAssertTrue(stop.waitForExistence(timeout: 5))
        stop.click()
        XCTAssertTrue(app.staticTexts["Reply stopped"].waitForExistence(timeout: 10))
        XCTAssertFalse(stop.exists)
        openChat("demo-image")
        openChat("demo-research")
        XCTAssertTrue(app.staticTexts["Reply stopped"].waitForExistence(timeout: 5))
    }

    func testEnterSendsOnceAndShiftEnterKeepsNewlineAndNextDraft() {
        launch(scenario: "delayed")
        composer.click()
        composer.typeText("Keyboard send first line")
        composer.typeKey(.return, modifierFlags: .shift)
        composer.typeText("Keyboard send second line")
        let message = "Keyboard send first line\nKeyboard send second line"
        XCTAssertEqual(composer.value as? String, message)
        XCTAssertFalse(app.buttons["chat.stop"].exists, "Shift Enter must not send")
        composer.typeKey(.return, modifierFlags: [])
        XCTAssertTrue(app.buttons["chat.stop"].waitForExistence(timeout: 5))
        XCTAssertEqual(composer.value as? String, "")
        composer.click()
        composer.typeText("Next draft stays unsent")
        composer.typeKey(.return, modifierFlags: [])
        XCTAssertEqual(composer.value as? String, "Next draft stays unsent")
        let sent = app.scrollViews["chat.transcript"].staticTexts.matching(
            NSPredicate(format: "value == %@ OR label == %@", message, message))
        XCTAssertEqual(sent.count, 1, "One Return press must create exactly one user message")
        app.buttons["chat.stop"].click()
        XCTAssertTrue(app.staticTexts["Reply stopped"].waitForExistence(timeout: 10))
        XCTAssertEqual(composer.value as? String, "Next draft stays unsent")
    }

    func testApprovalDecisionSettlesAcrossNavigation() {
        launch("demo-approval")
        let approve = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "approval.approve.")).firstMatch
        XCTAssertTrue(approve.waitForExistence(timeout: 10))
        approve.click()
        XCTAssertTrue(approve.waitForNonExistence(timeout: 10))
        openChat("demo-research")
        openChat("demo-approval")
        XCTAssertFalse(approve.exists)
    }

    func testEnterAfterNavigationSendsOnlyTheCurrentChat() {
        launch(scenario: "delayed")
        let retainedDraft = "Research draft must stay local"
        let submittedDraft = "Send only the selected image chat"
        enterDraft(retainedDraft)
        openChat("demo-image")
        enterDraft(submittedDraft)
        openChat("demo-research")
        XCTAssertEqual(composer.value as? String, retainedDraft)
        openChat("demo-image")
        XCTAssertEqual(composer.value as? String, submittedDraft)
        composer.click()
        composer.typeKey(.return, modifierFlags: [])
        XCTAssertTrue(app.buttons["chat.stop"].waitForExistence(timeout: 5))
        let sent = app.scrollViews["chat.transcript"].staticTexts.matching(
            NSPredicate(format: "value == %@ OR label == %@", submittedDraft, submittedDraft))
        XCTAssertEqual(sent.count, 1)
        app.buttons["chat.stop"].click()
        XCTAssertTrue(app.staticTexts["Reply stopped"].waitForExistence(timeout: 10))
        openChat("demo-research")
        XCTAssertEqual(composer.value as? String, retainedDraft)
        XCTAssertFalse(app.buttons["chat.stop"].exists)
    }

    func testVisibleSendButtonAndMultilineEditorKeepDraftWhileStopping() {
        launch(scenario: "delayed")
        let originalHeight = composer.frame.height
        composer.click()
        composer.typeText("First line")
        composer.typeKey(.return, modifierFlags: .shift)
        composer.typeText("Second line")
        composer.typeKey(.return, modifierFlags: .shift)
        composer.typeText("Third line")
        XCTAssertEqual(composer.value as? String, "First line\nSecond line\nThird line")
        XCTAssertGreaterThan(composer.frame.height, originalHeight)
        app.buttons["chat.send"].click()
        XCTAssertTrue(app.buttons["chat.stop"].waitForExistence(timeout: 5))
        composer.click()
        composer.typeText("Next draft stays here")
        app.buttons["chat.stop"].click()
        XCTAssertTrue(app.staticTexts["Reply stopped"].waitForExistence(timeout: 10))
        XCTAssertEqual(composer.value as? String, "Next draft stays here")
    }

    func testServerFailureHasReadOnlyRecoveryAndRetainsNextDraft() {
        launch(scenario: "server-error")
        enterDraft("Offline failure check")
        app.buttons["chat.send"].click()
        let error = app.staticTexts["chat.replyError"]
        XCTAssertTrue(error.waitForExistence(timeout: 10))
        XCTAssertTrue((error.value as? String ?? error.label).contains("DEMO-REPLY-001"))
        enterDraft("Draft after server failure")
        let refresh = app.buttons["chat.refresh"]
        XCTAssertTrue(refresh.isEnabled)
        for _ in 0..<3 {
            refresh.click()
            XCTAssertTrue(app.buttons["chat.send"].isEnabled)
            XCTAssertEqual(composer.value as? String, "Draft after server failure")
        }
        app.buttons["chat.dismissError"].click()
        XCTAssertTrue(error.waitForNonExistence(timeout: 5))
        XCTAssertEqual(composer.value as? String, "Draft after server failure")
    }

    func testNativeAppearanceAndCompactLongDraftRemainUsable() {
        launch(appearance: "light")
        let transcript = app.scrollViews["chat.transcript"]
        let paragraph = transcript.staticTexts.matching(NSPredicate(format: "value CONTAINS %@ OR label CONTAINS %@", "At 2M vectors", "At 2M vectors")).firstMatch
        XCTAssertTrue(paragraph.exists, "Message text must retain its own accessible content")
        captureWindow("native-after-light")
        app.terminate()
        launch(appearance: "dark")
        captureWindow("native-after-dark")
        let window = app.windows["main"]
        let rightEdge = window.coordinate(withNormalizedOffset: CGVector(dx: 0.999, dy: 0.5))
        rightEdge.press(forDuration: 0.2, thenDragTo: rightEdge.withOffset(CGVector(dx: 760 - window.frame.width, dy: 0)))
        let bottomEdge = window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.999))
        bottomEdge.press(forDuration: 0.2, thenDragTo: bottomEdge.withOffset(CGVector(dx: 0, dy: 600 - window.frame.height)))
        XCTAssertLessThan(window.frame.width, 820)
        XCTAssertLessThan(window.frame.height, 650)
        let draft = (1...20).map { "Draft line \($0): keep this multiline text." }.joined(separator: "\n")
        enterDraft(draft)
        XCTAssertLessThan(composer.frame.height, 180)
        XCTAssertTrue(app.buttons["chat.send"].isHittable)
        captureWindow("native-after-dark-compact-draft")
        app.terminate()
        launch(reset: false, appearance: "dark")
        XCTAssertEqual(composer.value as? String, draft)
    }

    private func captureWindow(_ title: String) {
        let attachment = XCTAttachment(screenshot: app.windows["main"].screenshot())
        attachment.name = title
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func testSettingsKeepsMainWindowRecoverable() {
        launch()
        let draft = "Draft retained while Settings stays open"
        enterDraft(draft)
        app.typeKey(",", modifierFlags: .command)
        XCTAssertTrue(app.buttons["settings.signout"].waitForExistence(timeout: 5))
        let main = app.windows["main"]
        main.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.02)).click()
        main.typeKey("w", modifierFlags: .command)
        XCTAssertTrue(main.waitForNonExistence(timeout: 5))
        app.typeKey("0", modifierFlags: .command)
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        XCTAssertEqual(composer.value as? String, draft)
    }

    func testStreamingPreservesScrollAwayAndJumpResumesFollowing() async throws {
        launch(scenario: "long")
        enterDraft("Offline native scroll check")
        app.buttons["chat.send"].click()
        let stop = app.buttons["chat.stop"]
        XCTAssertTrue(stop.waitForExistence(timeout: 5))
        try await Task.sleep(for: .seconds(5))
        let transcript = app.scrollViews["chat.transcript"]
        XCTAssertTrue(transcript.exists)
        transcript.scroll(byDeltaX: 0, deltaY: 600)
        let jump = app.buttons["Jump to Latest"]
        XCTAssertTrue(jump.waitForExistence(timeout: 5))
        let visible = try visibleParagraphs(in: transcript)
        let reference = try XCTUnwrap(visible.first)
        let label = reference.value as? String ?? reference.label
        let initialY = reference.frame.minY
        let count = transcript.staticTexts.count
        try await Task.sleep(for: .seconds(2))
        XCTAssertTrue(stop.exists)
        XCTAssertGreaterThan(transcript.staticTexts.count, count, "Chunks must arrive while checking the viewport")
        let older = transcript.descendants(matching: .any).matching(
            NSPredicate(format: "label == %@ OR value == %@", label, label)).firstMatch
        XCTAssertEqual(older.frame.minY, initialY, accuracy: 6)
        jump.click()
        XCTAssertTrue(jump.waitForNonExistence(timeout: 5))
        let jumped = try XCTUnwrap(visibleParagraphs(in: transcript).last)
        try await Task.sleep(for: .seconds(2))
        let followed = try XCTUnwrap(visibleParagraphs(in: transcript).last)
        XCTAssertNotEqual(jumped.value as? String ?? jumped.label, followed.value as? String ?? followed.label,
            "The visible tail must advance as chunks arrive after Jump")
        XCTAssertFalse(jump.exists)
        XCTAssertTrue(stop.exists)
        stop.click()
        XCTAssertTrue(stop.waitForNonExistence(timeout: 10))
    }

    private func visibleParagraphs(in transcript: XCUIElement) throws -> [any XCUIElementSnapshot] {
        let snapshot = try transcript.snapshot()
        var pending: [any XCUIElementSnapshot] = [snapshot]
        var visible: [any XCUIElementSnapshot] = []
        while let node = pending.popLast() {
            let text = node.value as? String ?? node.label
            if text.hasPrefix("QA line "),
               node.frame.minY > snapshot.frame.minY + 30, node.frame.maxY < snapshot.frame.maxY {
                visible.append(node)
            }
            pending.append(contentsOf: node.children)
        }
        return visible.sorted { $0.frame.minY < $1.frame.minY }
    }
}
