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

    func testVoiceModeControlsAndChatContinuity() {
        app.launchArguments = ["--demo", "--demo-open", "demo-research", "--demo-voice", "--demo-reset-drafts"]
        app.launch()
        XCTAssertTrue(app.buttons["voice.end"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["Preview · mic off"].waitForExistence(timeout: 15))
        capture("voice-fullscreen")
        tap(app.buttons["voice.mute"])
        // Muting awaits the web engine; app idleness does not guarantee that acknowledgment has arrived.
        XCTAssertTrue(app.buttons["voice.mute"].wait(for: \.label, toEqual: "Unmute microphone", timeout: 5))
        XCTAssertFalse(app.buttons["voice.captions"].exists)
        XCTAssertEqual(app.descendants(matching: .any)["voice.inputMeter"].value as? String, "Muted")
        tap(app.buttons["voice.mute"])
        XCTAssertTrue(app.buttons["voice.mute"].wait(for: \.label, toEqual: "Mute microphone", timeout: 5))
        XCTAssertEqual(app.descendants(matching: .any)["voice.inputMeter"].value as? String, "Listening")
        tap(app.buttons["voice.minimize"])
        XCTAssertTrue(app.textViews["chatComposer"].isHittable)
        enterDraft("Continue this same conversation")
        tap(app.buttons["voice.expand"])
        XCTAssertEqual(app.buttons["voice.mute"].label, "Mute microphone")
        capture("voice-resumed")
        tap(app.buttons["voice.end"])
        XCTAssertTrue(app.staticTexts["Voice ended"].waitForExistence(timeout: 5))
        tap(app.buttons["voice.end"])
        XCTAssertEqual(app.textViews["chatComposer"].value as? String, "Continue this same conversation")
        capture("voice-back-to-chat")
    }

    func testVoiceControlsFitLandscapeAndLargeText() {
        app.launchArguments = ["--demo", "--demo-open", "demo-research", "--demo-voice", "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
        app.launch()
        XCTAssertTrue(app.buttons["voice.end"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["voice.end"].isHittable)
        capture("voice-large-text")
        XCUIDevice.shared.orientation = .landscapeLeft
        settle(2)
        XCTAssertTrue(app.buttons["voice.end"].isHittable)
        XCTAssertTrue(app.buttons["voice.minimize"].isHittable)
        capture("voice-landscape")
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

    func testGroupLeadHeaderAndMembers() {
        launch("demo-group", appearance: "light", extra: ["--demo-group-lead"])
        let members = app.buttons["chat.groupMembers"]
        XCTAssertTrue(members.waitForExistence(timeout: 10))
        XCTAssertEqual(members.value as? String, "Lead: Research Assistant")
        XCTAssertFalse(app.buttons["Bot details"].exists)
        capture("group-lead-header")
        tap(members)
        XCTAssertTrue(app.navigationBars["Group members"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Messages without an @mention go to the lead bot. Use @mentions to address other members."].exists)
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Research Assistant")).firstMatch.exists)
        capture("group-lead-members")
        tap(app.buttons["Done"])
        XCTAssertTrue(members.isHittable)
    }

    func testGroupLeadAtAccessibilityTextSize() {
        launch("demo-group", appearance: "dark", extra: ["--demo-group-lead", "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
        let members = app.buttons["chat.groupMembers"]
        XCTAssertTrue(members.waitForExistence(timeout: 10))
        XCTAssertEqual(members.value as? String, "Lead: Research Assistant")
        XCTAssertTrue(members.isHittable)
        XCTAssertLessThanOrEqual(members.frame.maxX, app.frame.maxX)
        capture("group-lead-accessibility-header")
        tap(members)
        XCTAssertTrue(app.navigationBars["Group members"].waitForExistence(timeout: 5))
        capture("group-lead-accessibility-members")
    }

    private func settle(_ seconds: TimeInterval) {
        let ready = expectation(description: "Allow UI fixture updates")
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { ready.fulfill() }
        wait(for: [ready], timeout: seconds + 3)
    }

    func testGroupWorkInClosedAndExpandedNavigation() {
        launch(extra: ["--demo-group-activity"])
        let researcher = app.buttons["Research Assistant: Working"]
        XCTAssertTrue(researcher.waitForExistence(timeout: 8))
        capture("ios-activity-collapsed")
        tap(researcher)
        XCTAssertTrue(app.staticTexts["Working…"].waitForExistence(timeout: 5))
        capture("ios-activity-expanded")
        tap(app.buttons["Close sidebar"])
        let atlas = app.buttons["Atlas: Working"]
        XCTAssertTrue(atlas.waitForExistence(timeout: 15))
        XCTAssertFalse(researcher.exists, "Completed group speaker must stop showing working")
        capture("ios-activity-handoff")
        let completed = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: atlas)
        wait(for: [completed], timeout: 30)
        capture("ios-activity-completed")
    }

    func testGroupWorkAtAccessibilityTextSize() {
        launch(extra: ["--demo-group-activity", "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
        let researcher = app.buttons["Research Assistant: Working"]
        XCTAssertTrue(researcher.waitForExistence(timeout: 8))
        XCTAssertTrue(researcher.isHittable)
        capture("ios-activity-accessibility-collapsed")
        tap(researcher)
        XCTAssertTrue(app.buttons["Close sidebar"].waitForExistence(timeout: 5))
        for _ in 0..<5 where !app.staticTexts["Working…"].exists { app.swipeUp() }
        XCTAssertTrue(app.staticTexts["Working…"].waitForExistence(timeout: 5))
        capture("ios-activity-accessibility-expanded")
    }

    private func visibleLatestFixtureParagraph(in transcript: XCUIElement) -> (label: String, frame: CGRect)? {
        let deadline = Date().addingTimeInterval(5)
        repeat {
            // Read the viewport, current tail identity, and its frame atomically.
            // Separate live element queries can resolve different render passes
            // while a new paragraph arrives every 0.2 seconds on slower simulators.
            if let snapshot = try? transcript.snapshot() {
                var pending: [any XCUIElementSnapshot] = [snapshot]
                while let node = pending.popLast() {
                    if node.elementType == .staticText,
                       node.identifier == "chat.latestReplyParagraph",
                       node.label.hasPrefix("QA line "), node.frame.height > 0,
                       // Text accessibility bounds can exceed the drawn glyphs.
                       // Require a meaningful visible portion of the newest text.
                       snapshot.frame.intersection(node.frame).height >= min(44, node.frame.height) {
                        return (node.label, node.frame)
                    }
                    pending.append(contentsOf: node.children)
                }
            }
            settle(0.2)
        } while Date() < deadline
        return nil
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

    private func openBotDirectory() {
        let bots = app.buttons["Bots"]
        if !bots.exists || !bots.isHittable { tap(app.buttons["Open sidebar"]) }
        tap(bots)
        XCTAssertTrue(app.searchFields["Search bots"].waitForExistence(timeout: 5))
    }

    func testSavedReplyQuoteVisible() {
        launch(extra: ["--demo-reply-quote"])
        let quote = app.descendants(matching: .any).matching(identifier: "chat.reply.quoted-user").firstMatch
        XCTAssertTrue(quote.waitForExistence(timeout: 5))
        XCTAssertTrue(quote.label.contains("Researcher"))
        XCTAssertTrue(quote.label.contains("small pilot"))
        capture("ios-saved-reply-quote")
    }

    func testBotDirectorySearchDismissalAndHomeNavigation() {
        launch()
        enterDraft("Keep this draft while browsing bots")
        openBotDirectory()
        let atlas = app.buttons["botDirectory.bot-atlas"]
        XCTAssertTrue(atlas.waitForExistence(timeout: 5))
        XCTAssertTrue((atlas.value as? String)?.contains("Pinned") == true)
        XCTAssertTrue((app.buttons["botDirectory.bot-research"].value as? String)?.contains("Working") == true)
        capture("bots-directory-dark")
        let search = app.searchFields["Search bots"]
        tap(search)
        search.typeText("Helpdesk")
        let helpdesk = app.buttons["botDirectory.bot-helpdesk"]
        XCTAssertTrue(helpdesk.waitForExistence(timeout: 5))
        XCTAssertTrue((helpdesk.value as? String)?.contains("Needs your approval") == true)
        XCTAssertFalse(atlas.exists)
        capture("bots-directory-search")
        search.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 8) + "unmatched-fixture-bot")
        XCTAssertFalse(helpdesk.exists)
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "No Results")).firstMatch.waitForExistence(timeout: 5))
        capture("bots-directory-empty-search")
        tap(app.buttons["Close"])
        tap(app.buttons["Done"])
        let closeSidebar = app.buttons["Close sidebar"]
        if closeSidebar.exists && closeSidebar.isHittable { tap(closeSidebar) }
        XCTAssertTrue(app.textViews["chatComposer"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.textViews["chatComposer"].value as? String, "Keep this draft while browsing bots")
        openBotDirectory()
        tap(app.buttons["botDirectory.bot-atlas"])
        XCTAssertTrue(app.textViews["chatComposer"].waitForExistence(timeout: 10))
        XCTAssertTrue((app.buttons["Bot details"].value as? String)?.contains("Atlas") == true)
        XCTAssertFalse(app.searchFields["Search bots"].exists)
        capture("bots-directory-open-home")
    }

    func testBotDirectoryOffersExistingSideChatAction() {
        launch()
        openBotDirectory()
        let atlas = app.buttons["botDirectory.bot-atlas"]
        XCTAssertTrue(atlas.waitForExistence(timeout: 5))
        atlas.press(forDuration: 1)
        tap(app.buttons["New side chat"])
        XCTAssertTrue(app.textViews["chatComposer"].waitForExistence(timeout: 10))
        XCTAssertTrue((app.buttons["Bot details"].value as? String)?.contains("Atlas") == true)
        XCTAssertEqual(app.textViews["chatComposer"].value as? String, "")
        capture("bots-directory-new-side-chat")
    }

    func testBotDirectoryLightLayoutKeepsRowsReadableAndTappable() {
        launch(appearance: "light")
        openBotDirectory()
        let directory = app.collectionViews.firstMatch
        let atlas = app.buttons["botDirectory.bot-atlas"]
        XCTAssertTrue(atlas.waitForExistence(timeout: 5))
        XCTAssertGreaterThanOrEqual(atlas.frame.height, 44)
        XCTAssertGreaterThanOrEqual(atlas.frame.minX, app.frame.minX)
        XCTAssertLessThanOrEqual(atlas.frame.maxX, app.frame.maxX)
        let research = app.buttons["botDirectory.bot-research"]
        for _ in 0..<6 {
            if research.exists && research.isHittable { break }
            directory.swipeUp()
        }
        XCTAssertTrue(research.isHittable)
        XCTAssertEqual(research.label, "Research Assistant")
        XCTAssertTrue((research.value as? String)?.contains("Working") == true)
        if UIApplication.shared.preferredContentSizeCategory.isAccessibilityCategory {
            let name = research.staticTexts["Research Assistant"]
            XCTAssertTrue(name.exists)
            XCTAssertLessThanOrEqual(name.frame.minX - research.frame.minX, 24,
                                     "Large text needs the full row width below the avatar")
        }
        capture("bots-directory-light-accessible")
        XCUIDevice.shared.orientation = .landscapeLeft
        settle(1)
        XCTAssertTrue(app.buttons["Done"].isHittable)
        XCTAssertTrue(app.searchFields["Search bots"].exists)
        capture("bots-directory-landscape")
        XCUIDevice.shared.orientation = .portrait
        tap(app.buttons["Done"])
        XCTAssertFalse(app.searchFields["Search bots"].exists)
    }

    func testStatusRecoveryClearsTheErrorAndAttentionHeader() {
        launch("home-bot-atlas", extra: ["--demo-hermes-cancellation", "--demo-stream-scenario", "recovery"])
        enterDraft("Recover the offline Hermes fixture")
        tap(app.buttons["Send"])
        let check = app.buttons["Check message status"]
        XCTAssertTrue(check.waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["Check Hermes status"].exists)
        XCTAssertTrue((app.buttons["Bot details"].value as? String)?.contains("Needs attention") == true)
        app.textViews["chatComposer"].typeText("Next draft remains separate")
        XCTAssertFalse(app.buttons["Send"].isEnabled)
        // History plus the software keyboard can put the recovery control below
        // the viewport. Reveal it as a reader would; never tap an offscreen frame.
        let transcript = app.scrollViews["chat.transcript"]
        XCTAssertTrue(transcript.exists)
        for _ in 0..<4 where !check.isHittable { transcript.swipeUp() }
        let visible = expectation(for: NSPredicate { _, _ in
            check.exists && check.isHittable && transcript.frame.contains(check.frame)
        }, evaluatedWith: check)
        wait(for: [visible], timeout: 5)
        capture("recovery-01-unconfirmed-error")
        tap(check)
        XCTAssertTrue(app.staticTexts["Recovered offline reply. Your message was saved once."].waitForExistence(timeout: 10))
        XCTAssertFalse(check.exists)
        XCTAssertFalse(app.buttons["Check Hermes status"].exists)
        XCTAssertFalse(app.staticTexts["Couldn't confirm the message status. Check again before sending another message."].exists)
        XCTAssertTrue((app.buttons["Bot details"].value as? String)?.contains("Ready") == true)
        XCTAssertEqual(app.textViews["chatComposer"].value as? String, "Next draft remains separate")
        capture("recovery-02-ready")
        XCUIDevice.shared.press(.home)
        app.activate()
        XCTAssertTrue(app.textViews["chatComposer"].waitForExistence(timeout: 10))
        XCTAssertTrue((app.buttons["Bot details"].value as? String)?.contains("Ready") == true)
        capture("recovery-03-foreground")
    }

    func testUnconfirmedMessageHasSafeOriginalRetry() {
        launch("home-bot-atlas", extra: ["--demo-stream-scenario", "uncertain"])
        enterDraft("Immutable original message")
        tap(app.buttons["Send"])
        let retry = app.buttons["Retry original message"]
        XCTAssertTrue(retry.waitForExistence(timeout: 10))
        capture("retry-01-confirmation-pending")
        tap(retry)
        XCTAssertTrue(app.staticTexts["Recovered offline reply. Your message was saved once."].waitForExistence(timeout: 10))
        XCTAssertFalse(retry.exists)
        XCTAssertEqual(app.staticTexts.matching(identifier: "Immutable original message").count, 1)
        capture("retry-02-saved-once")
    }

    func testFailedAttachmentRequiresRemovalBeforeSend() {
        launch("home-bot-atlas", extra: ["--demo-draft", "Please read the report", "--demo-attachment-scenario", "failed"])
        let remove = app.buttons["Remove report.pdf"]
        XCTAssertTrue(remove.waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["Send"].isEnabled)
        XCTAssertGreaterThanOrEqual(remove.frame.width, 44)
        XCTAssertGreaterThanOrEqual(remove.frame.height, 44)
        capture("attachment-01-failed-and-retained")
        tap(remove)
        XCTAssertTrue(app.buttons["Send"].isEnabled)
        XCTAssertEqual(app.textViews["chatComposer"].value as? String, "Please read the report")
        capture("attachment-02-removed-draft-kept")
    }

    func testCommandPickerAddsToDraftAndControlRunsOffline() {
        launch("home-bot-atlas", extra: ["--demo-commands"])
        let command = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "/new")).firstMatch
        XCTAssertTrue(command.waitForExistence(timeout: 10))
        capture("commands-01-picker")
        tap(command)
        XCTAssertTrue((app.textViews["chatComposer"].value as? String)?.hasPrefix("/new") == true)
        XCTAssertFalse(app.staticTexts["Offline demo command"].exists)
        tap(app.buttons["Send"])
        XCTAssertTrue(app.staticTexts["Offline demo command"].waitForExistence(timeout: 10))
        XCTAssertEqual(app.textViews["chatComposer"].value as? String, "")
        capture("commands-02-result")
    }

    func testUnconfirmedHermesCancellationKeepsDraftWithoutStatusButton() {
        launch("home-bot-atlas", extra: ["--demo-hermes-cancellation"])
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "No files or prompt were sent")).firstMatch.exists)
        XCTAssertFalse(app.buttons["Check Hermes status"].exists)
        enterDraft("/reset")
        // Typing the initial slash opens the native command popover. Dismiss
        // that modal before interacting with the composer behind it.
        tap(app.buttons["Close commands"])
        let send = app.buttons["Send"]
        capture("hermes-cancellation-00-reset-draft")
        XCTAssertTrue(send.isEnabled)
        tap(send)
        let warning = app.staticTexts["Hermes cancellation is not confirmed. Use /stop to retry or /status to check before continuing. Your draft has been kept."]
        XCTAssertTrue(warning.waitForExistence(timeout: 10))
        XCTAssertEqual(app.textViews["chatComposer"].value as? String, "/reset")
        XCTAssertFalse(app.buttons["Check Hermes status"].exists)
        XCTAssertFalse(app.staticTexts["Chat status"].exists, "An error must not submit a status command automatically")
        XCTAssertTrue(send.isEnabled)
        capture("hermes-cancellation-01-reset-kept")
        XCUIDevice.shared.press(.home)
        app.activate()
        XCTAssertTrue(app.textViews["chatComposer"].waitForExistence(timeout: 10))
        XCTAssertEqual(app.textViews["chatComposer"].value as? String, "/reset")
        XCTAssertFalse(app.buttons["Check Hermes status"].exists)
        XCTAssertFalse(app.staticTexts["Chat status"].exists)
    }

    func testExplicitHermesStatusAndStreamingDoNotAddStatusButton() {
        launch("home-bot-atlas", extra: ["--demo-hermes-cancellation", "--demo-stream-scenario", "long"])
        enterDraft("/status")
        tap(app.buttons["Close commands"])
        XCTAssertFalse(app.staticTexts["Chat status"].exists)
        tap(app.buttons["Send"])
        XCTAssertTrue(app.staticTexts["Portal reply: failed (stop requested)."].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Cancellation requested; upstream identity is not recorded yet. Retry /stop after the worker settles."].exists)
        XCTAssertEqual(app.textViews["chatComposer"].value as? String, "")
        XCTAssertFalse(app.buttons["Check Hermes status"].exists)
        capture("hermes-cancellation-02-unconfirmed-status")
        enterDraft("How is home assistant looking today?")
        tap(app.buttons["Send"])
        let stop = app.buttons["Stop"]
        XCTAssertTrue(stop.waitForExistence(timeout: 10))
        XCTAssertTrue((app.buttons["Bot details"].value as? String)?.contains("Working") == true)
        XCTAssertFalse(app.buttons["Check Hermes status"].exists)
        XCTAssertTrue(app.buttons["Chat options"].exists)
        XCTAssertTrue(app.buttons["Start voice"].exists)
        capture("hermes-status-03-streaming-without-button")
        tap(stop)
        let stopped = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: stop)
        wait(for: [stopped], timeout: 10)
        XCTAssertTrue((app.buttons["Bot details"].value as? String)?.contains("Ready") == true)
        // An empty, idle composer hides Send; typing a new draft reveals it.
        enterDraft("Next request after stopping")
        XCTAssertTrue(app.buttons["Send"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Send"].isEnabled)
        XCTAssertFalse(app.buttons["Check Hermes status"].exists)
    }

    // Also run on the dedicated iPad after simctl ui content_size sets the largest
    // accessibility size. The guidance and its removal action must fit together.
    func testAttachmentRecoveryGuidanceAndSettingsStayVisible() {
        launch("home-bot-atlas", appearance: "light", extra: ["--demo-draft", "Please read the report", "--demo-attachment-scenario", "failed"])
        let guidance = app.staticTexts["Upload interrupted. Remove the file and attach it again."]
        XCTAssertTrue(guidance.waitForExistence(timeout: 10))
        XCTAssertTrue(guidance.isHittable)
        XCTAssertTrue(app.buttons["Remove report.pdf"].isHittable)
        XCTAssertLessThan(guidance.frame.maxY, app.textViews["chatComposer"].frame.minY)
        capture("accessibility-01-attachment-guidance")
        tap(app.buttons["Remove report.pdf"])
        XCTAssertTrue(app.buttons["Send"].isEnabled)
        if !app.buttons["Settings"].isHittable { tap(app.buttons["Open sidebar"]) }
        XCTAssertTrue(app.buttons["Settings"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Settings"].isHittable)
        capture("accessibility-02-settings-visible")
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
        XCTAssertNotNil(visibleLatestFixtureParagraph(in: transcript), "The growing reply must render before the reader scrolls")
        XCTAssertFalse(app.buttons["Check message status"].exists, "An attached live stream must not offer an unavailable recovery action")
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
        capture("stream-after-jump")
        XCTAssertFalse(app.buttons["Scroll to latest message"].exists)
        let jumpedTail = visibleLatestFixtureParagraph(in: transcript)
        XCTAssertNotNil(jumpedTail, "Jumping to the latest reply must not leave a blank transcript")
        settle(2)
        let followedTail = visibleLatestFixtureParagraph(in: transcript)
        XCTAssertNotNil(followedTail, "The latest reply must stay visible as more paragraphs arrive after Jump")
        XCTAssertNotEqual(jumpedTail?.label, followedTail?.label, "Jump must resume following incoming paragraphs")
        XCTAssertTrue(app.buttons["Stop"].exists, "The reply must remain attached while following incoming paragraphs")
        XCTAssertFalse(app.buttons["Check message status"].exists)
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

    func testOfflineSignInPreviewRemainsDisabledInDarkTheme() {
        assertOfflineSignInPreview(appearance: "dark")
    }

    func testOfflineSignInPreviewRemainsDisabledInLightTheme() {
        assertOfflineSignInPreview(appearance: "light")
    }

    private func assertOfflineSignInPreview(appearance: String) {
        app.launchArguments = ["--demo", "--demo-screen", "signin", "--demo-appearance", appearance]
        app.launch()
        let button = app.buttons["Sign in"]
        XCTAssertTrue(button.waitForExistence(timeout: 10))
        XCTAssertTrue(button.isHittable)
        XCTAssertEqual(button.label, "Sign in")
        XCTAssertFalse(button.isEnabled, "Offline previews must never open browser authorization")
        XCTAssertTrue(app.buttons["Change server"].isEnabled)
        settle(0.5)
        capture("signin-" + appearance)
        // Native disabled controls use system-dimmed colors. Enabled sign-in ink
        // and label contrast remain covered by the hosted appearance tests.
    }
}
