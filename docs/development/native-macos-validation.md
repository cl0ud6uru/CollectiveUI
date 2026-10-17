# Native macOS foundation validation

The desktop foundation adds a SwiftUI sidebar, chat transcript, activity inspector,
Settings, native commands, production sign-in and shared streaming/recovery logic.
The polish adds native bot artwork, bounded image caching, a growing multiline
composer with visible Send/Stop controls, accessible message content and read-only
recovery that preserves the server error and the next draft.

Selected authentication, chat and draft sources are shared with iOS. Server
authorization and tool approval policies are unchanged. Deployment targets remain
macOS 14 and iOS 27. No voice implementation is added to macOS.

## Recorded verification

The recovered implementation was validated on an Apple Silicon Mac with Xcode
27.0, Swift 6.4 and SDK 27.0 before being reconciled with current main.

| Check | Confirmed result |
| --- | --- |
| macOS Debug | Passed |
| macOS Release | Passed, universal arm64/x86_64 |
| iOS Simulator Debug and Release | Passed |
| CollectiveKit package tests | 90 passed |
| macOS hosted fixture tests | 77 passed |
| iOS hosted fixture tests | 84 passed |
| Native project guardrails, seven iOS parity checks, voice bundle consistency | Passed |

After reconciling with current main, all four Debug/Release builds passed again,
as did 90 package tests, 78 macOS hosted tests and 85 iOS hosted tests, with no
failures or skips. Main adds a command-result dismissal fixture, accounting for
the one additional hosted test on each platform. Project guardrails and all seven
iOS source-parity checks also passed on the publication branch.

These are completed local results, not a claim that GitHub CI has passed.
Build products, logs, recovery history and result bundles are retained locally
and are excluded from the repository. Release compilation was checked with
distribution signing disabled; the app is not notarized or ready for distribution.

## UI and production limits

The current offline macOS UI suite passed **all nine cases**, with no failures or
skips, on the publication branch after a test-harness correction. SwiftUI's
TextEditor reported disabled through XCTest while accepting text; the runner now
activates the fixture, waits for foreground state and checks visibility. The
existing assertions still verify the actual typed draft and its restoration.
The earlier automation timeout and initial guard failures are superseded by this
completed run; they are not counted as successful attempts.

The suite verified direct approval settlement, Command-Return and visible Send,
immediate Stop and persistence of the stopped row, multiline drafts across
repeated navigation and relaunch, window-close/Settings recovery, read-only error
refresh preserving the next draft, streaming scroll stability and Jump to Latest,
and light/dark appearance with compact resizing and twenty-line draft restoration.
These are offline fixtures, not production authentication or server tool actions.

Live validation is incomplete. An earlier QA launch requested interactive Keychain
authorization; a later check found neither a dialog nor a running native QA app.
The configured server's public native-info endpoint responded successfully, but
that does not prove authenticated access. No live message or tool action was sent.
Production browser sign-in, Keychain persistence/failure handling, authenticated
streaming and the existing server reply error remain unverified. Diagnosing that
error needs the existing production server log for the failed turn.

Remaining checks include VoiceOver, Reduce Motion, broader keyboard/scrollbar and
resize coverage, macOS 14/Intel runtime behavior and broader rendered iOS
regressions. Attachments, search/inbox, complete Groups parity, pagination,
localization, distribution and voice are outside this foundation.

Reproduction commands and fixture isolation are documented in
[macos/README.md](../../macos/README.md). Native UI runs must use the separate
`io.collectiveui.macos.polish` fixture identity and never the signed-in QA app.
No screenshots, private session contents or local authorization captures are
published with this source change.
