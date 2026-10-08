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

if __name__ == '__main__':
    unittest.main()
