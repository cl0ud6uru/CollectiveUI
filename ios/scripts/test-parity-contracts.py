"""Linux source guardrails, NOT a replacement for Xcode or visual QA."""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
def source(path):
    return (ROOT / path).read_text()

class ParityContracts(unittest.TestCase):
    def test_navigation_and_demo_evidence_are_complete(self):
        sidebar = source('CollectiveUI/Views/SidebarView.swift')
        self.assertIn('navigationAction("Home"', sidebar)
        fixtures = source('CollectiveUI/Demo/DemoServer.swift')
        self.assertIn('--demo-role', fixtures)
        script = source('scripts/simulator-screenshots.sh')
        self.assertIn('--demo-appearance "$appearance"', script)
        self.assertIn('iphone-12-welcome', script)
        self.assertIn('iphone-13-admin-settings', script)
        self.assertIn('iphone-14-member-settings', script)
        self.assertIn('set -euo pipefail', script)
        self.assertNotIn('::warning::Scenario failed', script)

    def test_web_palette_and_nonoverlapping_chat_flow(self):
        theme = source('CollectiveUI/Support/PortalTheme.swift')
        self.assertIn('adaptive("ffffff", "181818")', theme)
        self.assertIn('adaptive("f0f0f0", "262626")', theme)
        chat = source('CollectiveUI/Chat/ChatView.swift')
        self.assertIn('.accessibilityIdentifier("chat.header")', chat)
        self.assertNotIn('.mask(alignment: .top)', chat)
        self.assertLess(chat.index('header\n'), chat.index('messageList\n'))
        self.assertNotIn('headerHeight + 20', chat)
        composer = source('CollectiveUI/Chat/ComposerView.swift')
        self.assertIn('"Ask anything"', composer)
        self.assertIn('"Message "', composer)
        home = source('CollectiveUI/Views/MainView.swift')
        self.assertIn('welcomeText', home)
        self.assertIn('app.startNewChat(with: target)', home)
        self.assertIn('home.target.', home)

    def test_settings_are_card_based_and_browser_uses_only_a_validated_url(self):
        settings = source('CollectiveUI/Views/SettingsView.swift')
        self.assertNotIn('Form {', settings)
        self.assertIn('SettingsDestination.available(isAdmin: model.settingsAccess.isAdmin)', settings)
        self.assertIn('Web sign-in may be required', settings)
        self.assertIn('model.settingsAccess.generation', settings)
        browser = ROOT / 'CollectiveUI/Support/SettingsBrowser.swift'
        self.assertTrue(browser.exists(), 'Missing ordinary-login Safari settings access')
        safari = browser.read_text()
        self.assertIn('SFSafariViewController(url: url)', safari)
        self.assertIn('controller.delegate = context.coordinator', safari)
        self.assertIn('safariViewControllerDidFinish', safari)
        self.assertNotIn('Authorization', safari)
        self.assertNotIn('token', safari)

    def test_session_responses_are_scoped_and_admin_validation_is_fail_closed(self):
        app = source('CollectiveUI/App/AppModel.swift')
        self.assertIn('settingsAccess.invalidate()', app)
        shell = app.split('func refreshShell() async')[1].split('func loadSessionInfo()')[0]
        self.assertIn('guard settingsAccess.generation == generation', shell)
        session = app.split('func loadSessionInfo() async')[1].split('func startNewChat')[0]
        self.assertIn('settingsAccess.beginValidation()', session)
        self.assertIn('settingsAccess.completeValidation', session)
        change = app.split('func changeServer()')[1].split('func loadServerInfoIfNeeded')[0]
        self.assertIn('sessionInfo = nil', change)

    def test_pending_validation_preserves_existing_admin_navigation_only(self):
        access = source('CollectiveKit/Sources/CollectiveKit/SettingsDestination.swift')
        self.assertIn('var isValidating = false', access)
        self.assertIn('var shouldDismissAdminDestinations: Bool { !isValidating && !isAdmin }', access)
        begin = access.split('func beginValidation()')[1].split('@discardableResult')[0]
        self.assertIn('isAdmin = false', begin)
        self.assertIn('isValidating = true', begin)
        settings = source('CollectiveUI/Views/SettingsView.swift')
        self.assertIn('.onChange(of: model.settingsAccess.shouldDismissAdminDestinations)', settings)
        self.assertNotIn('if !isAdmin && !isOpening', settings)
        opening = settings.split('private func openWebsite(')[1].split('private func reconcileAdminDestinations')[0]
        self.assertIn('defer {', opening)
        self.assertIn('if model.settingsAccess.generation == generation', opening)
        self.assertIn('isOpening = false; reconcileAdminDestinations()', opening)
        self.assertIn('guard model.settingsAccess.shouldDismissAdminDestinations else { return }', settings)
        cleanup = settings.split('private func reconcileAdminDestinations()')[1].split('private func refreshAfterBrowser')[0]
        self.assertIn('if path.contains(where: \\.isAdminOnly) { path = [] }', cleanup)
        self.assertIn('if browser?.destination.isAdminOnly == true { browser = nil }', cleanup)
        self.assertNotIn('isOpening', cleanup)

    def test_failed_validation_settles_through_the_scoped_request(self):
        access = source('CollectiveKit/Sources/CollectiveKit/SettingsDestination.swift')
        self.assertIn('func failValidation(generation: UUID, request: UUID) -> Bool', access)
        failure = access.split('func failValidation(')[1].split('\n    }')[0]
        self.assertIn('self.generation == generation, self.request == request', failure)
        self.assertIn('isValidating = false', failure)
        app = source('CollectiveUI/App/AppModel.swift')
        session = app.split('func loadSessionInfo() async')[1].split('func startNewChat')[0]
        self.assertIn('settingsAccess.failValidation(generation: generation, request: request)', session)

    def test_header_geometry_requires_real_elements(self):
        ui = source('UITests/CollectiveUIRegression.swift')
        test = ui.split('func testChatHeaderNeverOverlapsTheTranscriptViewport()')[1].split('func testDrafts')[0]
        self.assertIn('transcript.waitForExistence(timeout: 5)', test)
        self.assertIn('XCTAssertGreaterThan(header.frame.height, 0)', test)
        self.assertIn('XCTAssertGreaterThan(transcript.frame.height, 0)', test)

if __name__ == '__main__':
    unittest.main()
