# CollectiveUI for macOS — native foundation

A native SwiftUI desktop client using the existing CollectiveKit mobile API and
the iOS client's production session, chat, approval and recovery code. The server
still requires `MOBILE_APP_ENABLED=true`. No server routes or permission policies
change in this milestone.

**Status:** native Debug and universal Release builds pass on Xcode 27.0. The
Apple-toolchain package suite and macOS/iOS hosted fixture suites pass. See the
[native validation record](../docs/development/native-macos-validation.md)
for completed checks and remaining limits. Current polish UI cases have not completed. Real browser sign-in and Keychain behavior
remain outside fixture coverage.

## Project and boundaries

- Open `macos/CollectiveUI.xcodeproj`, scheme **CollectiveUI**. The local package is
  `../ios/CollectiveKit`; its macOS minimum remains 14.0. The app also targets macOS
  14.0, with Swift language mode 5 matching the existing app. Use an installed
  Xcode with a macOS 14+ SDK and Swift 5.10+; the repository's iOS build needs its
  existing iOS 27 SDK/toolchain. Check the actual toolchain before validating.
- `CollectiveUI/App`: a single native window, session root, commands and lifecycle.
  `Views`: sidebar, new chat, bot opener and Settings. `Chat`: transcript, composer,
  tool/delegated approvals, recovery controls and activity inspector.
- Xcode compiles the selected files in `ios/CollectiveUI` directly. These are not
  forks: AppModel, ChatModel, ConversationState, PendingChatSubmission,
  WebAuthenticator, KeychainStore and Foundation-only offline demo transport.
- UIKit/voice/Live Activities stay in iOS compilation branches. AppKit boundaries
  are browser presentation/device naming, clipboard, scroll observation and
  desktop lifecycle. No web view or voice engine is embedded in the desktop app.
- macOS credentials use the app bundle ID as their Keychain service (production
  `io.collectiveui.macos`; QA has its own service) and disable synchronization.
  After token exchange both clients verify server/token persistence and
  shows a failure if the Keychain cannot save it. Drafts use a separate application
  support directory, server/token hashed scope, backup exclusion, `0700` directories
  and `0600` files. Disk encryption depends on the Mac's FileVault configuration.
  A local ended-session marker prevents restoring an old token if Keychain deletion
  fails during logout or a 401.
  Restoration requires the saved credential server to match the selected server.
- The app sandbox requests only outgoing network access. ATS permits local
  networking; public servers require HTTPS. Website Settings opens a fixed,
  validated destination with the browser's own login; native bearer tokens are
  never injected into browser sessions.

`python3 macos/scripts/generate-project.py` regenerates deterministic project and
scheme files after adding/removing a Swift file. `--check` verifies membership
without changing anything. No XcodeGen or third-party app frameworks are needed.

## Implemented behavior

- Server discovery, PKCE/S256 authorization in ASWebAuthenticationSession, state
  and callback address validation, token exchange/storage, server session revocation
  and 401 logout. Server changes invalidate old sign-in attempts; late callbacks,
  token exchanges, sign-out and shell responses cannot overwrite a newer session.
- Resizable NavigationSplitView sidebar with bots, conversations, pin/archive,
  and local saved drafts/recovery entries. Bot home and new private bot/model chats
  use the existing authorized endpoints. Team Bots retain the web compatibility
  boundary. The new-chat chooser never silently chooses a model.
- Streaming transcript with Markdown/code, explicit Stop, regeneration, direct
  approvals with an optional denial reason, delegated approvals, and an optional
  inspector of current tools and server bot activity. The server remains responsible
  for admission, approval identity, policy enforcement and access control.
- **Enter** sends; **Shift+Enter** inserts a newline. **⌘Return** remains an alternate
  Send shortcut. **⌘.** stops an attached stream,
  **⌘N** opens New Chat, **⌥⌘I** toggles the inspector, **⌘,** opens Settings, and
  **⌘0** shows the main window while Settings remains open. Native
  sidebar commands and System/Light/Dark appearance are provided.
- Drafts flush on navigation, focus loss and ordinary quit. Interrupted requests
  keep the original body/message ID and preserve a newer composer draft. Status
  checks, bounded resume, explicit reconnect and safe original-request retry use
  the existing recovery rules. Stop before admission remains unconfirmed until
  the server supplies evidence. New chats absent from the server list remain
  discoverable through **Saved Drafts & Recovery** after relaunch.
  Accepted conversations retain an establishment marker so reopening the window's
  original New Chat route loads their transcript. AppKit window-close notifications
  cancel sign-in and detach streaming without stopping the server's run.
- A chat captures its credential generation: stale chat views cannot send,
  regenerate, approve, resume, upload or Stop using a replacement session.

The eager transcript stack follows the existing scroll stability approach; long
histories need pagination. Native wheel/trackpad/keyboard follow behavior must be
verified against real AppKit layout before making any UI reliability claim.

## Cloud checks

Run from the repository root:

```sh
python3 macos/scripts/check-project.py
bash macos/scripts/check-swift-syntax.sh
bash macos/scripts/test-portable-core.sh
python3 ios/scripts/test-parity-contracts.py
node ios/scripts/build-voice-engine.mjs --check
npm run typecheck
npm run lint
env -u DATABASE_URL -u SANDBOX_DOCKER npm test -- --maxWorkers=4
git diff --check
```

The syntax script is a Linux Bash/Docker guardrail, with macOS/iOS Debug and
Release active branches. It does **no SDK resolution or type checking**. The
portable suite executes unmodified production Foundation sources and real
XCTest suites, including SSE chunking, reducers, approval decoding, callback
validation, models, Markdown, commands, scroll policy and settings policy. It
excludes Apple URLSession streaming, CryptoKit, Keychain and all native views;
it does not replace them with stubs. Docker fallback uses the Linux `swift:6.0`
image with networking disabled; no Apple toolchain is installed in the cloud.

See the [validation record](../docs/development/native-macos-validation.md) for
recorded results and remaining scope.

## GitHub Actions

[The macOS workflow](../.github/workflows/macos.yml) runs on pull requests and
pushes to `main` that change Mac code, its shared iOS sources/tests, CollectiveKit
or the workflow itself. It can also be run manually. New commits cancel an
older run for the same PR or branch.

A Linux job checks project membership, shared-source contracts and the workflow
with actionlint/ShellCheck before using GitHub's hosted `xcode-27` Apple Silicon
runner. The native job runs CollectiveKit tests, builds Debug and its hosted
tests once, executes hosted tests without rebuilding, then runs the offline UI
suite against that same `io.collectiveui.macos.polish` app. The two suites run
sequentially because they launch the same fixture app. Release builds both
`arm64` and `x86_64` with distribution signing disabled and verifies the binary
contains both architectures.

Each stage has a timeout. Toolchain/build/test logs, hosted and UI `.xcresult`
bundles, and exported UI attachments are uploaded as `macos-native-validation`
even after a failure and retained for 14 days. Fixtures use no production
session, browser sign-in or real server actions. This gate does not establish
macOS 14/Intel runtime coverage or distribution readiness.

## Native validation

These checks require no real account or paid model. The macOS test scheme launches the host with `--demo`; application tests
use synthetic transport and in-memory credentials. Shared iOS session/draft,
stream lifecycle/recovery and new authentication tests compile in the Mac test
target too. New Mac tests cover stale-chat isolation, file permissions and
relaunch discovery of unsent new chats. Recorded native results are linked above.

```sh
COLLECTIVE_QA_ROOT="$(mktemp -d)"

xcodebuild -version
xcrun --sdk macosx --show-sdk-version
xcrun swift --version
swift test --package-path ios/CollectiveKit

xcodebuild -project macos/CollectiveUI.xcodeproj -scheme CollectiveUI \
  -configuration Debug -destination 'platform=macOS' \
  -derivedDataPath "$COLLECTIVE_QA_ROOT/mac" \
  COLLECTIVE_BUNDLE_ID=io.collectiveui.macos.polish CODE_SIGN_IDENTITY=- build

xcodebuild -project macos/CollectiveUI.xcodeproj -scheme CollectiveUI \
  -destination 'platform=macOS' -parallel-testing-enabled NO \
  -derivedDataPath "$COLLECTIVE_QA_ROOT/mac" \
  -resultBundlePath "$COLLECTIVE_QA_ROOT/mac-hosted.xcresult" \
  COLLECTIVE_BUNDLE_ID=io.collectiveui.macos.polish CODE_SIGN_IDENTITY=- test

xcodebuild -project macos/CollectiveUI.xcodeproj -scheme CollectiveUI \
  -configuration Release -destination 'platform=macOS' \
  -derivedDataPath "$COLLECTIVE_QA_ROOT/release" \
  CODE_SIGNING_ALLOWED=NO build
```

Debug builds only the active Mac architecture; Release builds both arm64 and
x86_64. This keeps the app architecture aligned with its Swift package in Debug.

The Debug target defaults to local ad-hoc signing, with no development team or
distribution account. If Xcode asks for signing configuration, record it before
changing entitlements. Use a fresh result-bundle path on repeated tests.

Launch the separately named QA app with fixtures:

```sh
open -n "$COLLECTIVE_QA_ROOT/mac/Build/Products/Debug/CollectiveUI.app" \
  --args --demo --demo-open demo-research
```

Quit between scenarios; use `--demo-reset-drafts` only when intentionally clearing
fixture drafts. Omit it to verify relaunch persistence. Debug demo startup uses its
own appearance/defaults and session draft scope, and never reads real credentials.
Release compilation excludes all demo transport/fixtures.

1. Capture light/dark screenshots at the minimum window size and a wide window;
   resize both sidebar and inspector. Verify labels, contrast, keyboard navigation,
   VoiceOver, Reduce Motion and increased text size. Verify Settings and menu actions
   enable/disable with the active chat and signed-in session.
2. Open `demo-approval`. Inspect the actual input, approve, then relaunch fresh
   fixtures and deny with a reason. Verify server fixture response and decision
   reconciliation after switching conversations; do not exercise real tool actions.
3. Stream with `--demo --demo-open demo-research --demo-send "Fixture question"`.
   Repeat with `--demo-stream-scenario long` and `delayed`. Scroll away with wheel,
   trackpad, scrollbar and keyboard; confirm chunks preserve the reader's position
   and Jump to Latest restores following. Verify Enter sends exactly once, Shift+Enter
   inserts a newline, and Enter used to commit input-method marked text never sends.
   Check the alternate ⌘Return shortcut separately.
4. Stop immediately and during output. Inspect the retained original request and
   unconfirmed status behavior, plus the persisted empty **Reply stopped** row where
   the server acknowledges cancellation. Reopen chats and quit/relaunch mid-send.
5. Use `--demo-stream-scenario recovery` and `uncertain`. Verify Check Message Status,
   Reconnect, safe Retry Original Message, unchanged original message ID/body and
   preservation of text typed after submission. Run the XCTest cases for a delayed
   Stop acknowledgment after detachment and pre-admission Stop outcomes.
   Close/reopen the main window after its first accepted reply and while streaming;
   verify the transcript resumes and the request identity remains stable. Close
   Settings independently and confirm the main conversation stays active.
6. Create a new chat and leave an unsent multiline draft. Quit/relaunch without
   reset; open Saved Drafts & Recovery and confirm the selected target survives.
   Sign out of the fixture session; confirm its local recovery entries clear.
7. Inspect actual sandbox entitlements and file permissions on the QA app. Auth
   browser presentation and real Keychain error handling need a controlled local
   test server with synthetic accounts; fixture XCTest bypasses OS browser/Keychain.
   Do not sign in to production, invoke paid models, send HASS commands or modify
   production credentials during this validation.
   Cancel the browser and its owning task, close the main window during sign-in,
   and use fixture tests for partial credential writes and delayed token exchanges.
   The offline sign-in preview disables browser sign-in: ASWebAuthenticationSession
   does not use the app's URLProtocol transport.

Because shared iOS sources changed, retain the existing iOS gate:

```sh
xcodebuild -project ios/CollectiveUI.xcodeproj -scheme CollectiveUI \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
xcodebuild -project ios/CollectiveUI.xcodeproj -scheme CollectiveUI \
  -configuration Release -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO build
```

Then run the fixture-only iOS hosted tests and simulator regressions documented in
[ios/README.md](../ios/README.md), with the actual available iOS 27 simulator ID.
Cloud parsing does not certify iOS rendering or native compatibility.

## Offline macOS UI regressions

Build the separately identified QA app with the Debug command above, then run:

```sh
TEST_RUNNER_COLLECTIVE_MACOS_QA_APP="$COLLECTIVE_QA_ROOT/mac/Build/Products/Debug/CollectiveUI.app" \
  xcodebuild -project macos/UITests/CollectiveUIRegression.xcodeproj \
  -scheme CollectiveUIRegression -destination 'platform=macOS,arch=arm64' \
  -parallel-testing-enabled NO -derivedDataPath "$COLLECTIVE_QA_ROOT/ui" \
  -resultBundlePath "$COLLECTIVE_QA_ROOT/mac-ui.xcresult" test
```

The runner uses the explicit QA app path from the documented Debug build and
checks its bundle ID before launching. A different location can be supplied with
`TEST_RUNNER_COLLECTIVE_MACOS_QA_APP` in the `xcodebuild` environment. It launches
only offline fixtures; reset arguments affect fixture drafts only. XCTest may
require the Mac owner to enable UI Automation. The suite does not grant that
permission or handle a password. Keep UI testing separate from hosted tests
because both launch the same QA app. XCTest results contain window screenshots
and accessibility snapshots for diagnosis.

## Remaining scope

Independent multiwindow navigation/session coordination; Groups lead/activity UI;
native attachments/import/download/search/inbox; the remaining avatar types;
voice, microphone and dictation; full website settings/admin parity; transcript
pagination; app icon, localization and distribution packaging; broader macOS UI
regressions.

Uploaded references in saved drafts remain intact, failed uploads block send, and
the desktop can remove them, but a native attachment workflow is not complete.
Existing voice audio clicks remain unresolved. No voice implementation was copied
to macOS, and the voice bundle check is not audio/device validation. Distribution
signing, notarization and deployment are outside this foundation.
