# CollectiveUI for iOS

A native SwiftUI client for a CollectiveUI server. It runs on iPhone and iPad (iOS 27+). You can chat with model connections and bots, approve tool actions, read the inbox and search your history.

```
ios/
  CollectiveKit/            Swift package (Foundation only): models, API client, SSE parser,
                            UI message stream reducer, PKCE. Unit tested with `swift test`.
  CollectiveUI.xcodeproj    App project (the CollectiveUI/ folder is a synchronized group, so
                            new files are picked up without editing the project)
  CollectiveUI/             App sources: App/, Auth/, Views/, Chat/, Support/, Assets.xcassets
  CollectiveUITests/        App unit tests: draft lifecycle, session isolation, Stop and contrast
  UITests/                 Offline simulator regressions and standalone UI test project
  Config/Info.plist         Extra Info.plist keys (local-network ATS exception)
```

## Requirements

- Xcode 27 or newer (the project uses `objectVersion = 77` with synchronized folders)
- iOS 27 or newer on a device or simulator
- A CollectiveUI server that has the mobile API turned on (see below)

## Enable mobile sign-in on the server

Mobile sign-in is off by default. Set the following in the server environment and restart it:

```sh
MOBILE_APP_ENABLED=true
```

`GET /api/mobile/info` on the server should now return `"enabled": true`. Otherwise the app shows:
"Mobile sign-in is turned off on this server. Ask your administrator to set MOBILE_APP_ENABLED=true."

## Open, build and run

1. Open `ios/CollectiveUI.xcodeproj` in Xcode. The local `CollectiveKit` package resolves automatically.
2. Select the **CollectiveUI** scheme and an iPhone or iPad simulator, then press Run.

From the command line:

```sh
# Unit tests for the core package (runs on macOS)
swift test --package-path ios/CollectiveKit

# App unit tests use fixture transport and in-memory credentials. The host launches with --demo.
# The optional QA bundle ID keeps a developer's installed app separate.
xcodebuild -project ios/CollectiveUI.xcodeproj -scheme CollectiveUI \
  -destination 'platform=iOS Simulator,name=iPhone 18 Pro' \
  QA_APP_BUNDLE_IDENTIFIER=io.collectiveui.qa CODE_SIGNING_ALLOWED=NO test

# Simulator build without signing
xcodebuild -project ios/CollectiveUI.xcodeproj -scheme CollectiveUI \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

The `iOS` GitHub Actions workflow (`.github/workflows/ios.yml`) uses the `xcode-27` runner and an iOS 27 simulator for changes under `ios/`.

## Recover an interrupted reply

An interrupted connection does not mean the server rejected the message. The app
keeps the original request, attachments and message identity in its protected,
session-scoped draft store. It checks the server before enabling another send or
regeneration, including after switching chats, backgrounding or relaunching.

**Check message status** reconciles the transcript. A recovered connection clears
its obsolete error and attention header; genuine server run errors remain visible.
If a direct-chat message is still unconfirmed, **Retry original message** reuses the
exact saved request and message ID without consuming a newer composer draft. The
server's message primary key prevents this retry from admitting a second turn.
Group conversations require status confirmation instead of offering that retry.

Automatic stream reconnection is bounded. If the server is still working after
that budget, the header says **Reply still running** and **Reconnect to reply**
reattaches explicitly. A confirmed Stop retains the stopped turn across navigation.
If Stop finds no run, returns an invalid outcome, or precedes the first server reply
identity, the app retains the original submission and checks its status before
another send. Conversation-level cancellation counts alone cannot prove that a
slow original request finished admission. Group Stop continues to close its request.
Failed attachments block sending until removed, so a message cannot silently omit
the file. At accessibility text sizes, the attachment card puts recovery guidance
below the filename and removal control; the sidebar uses a readable Settings
footer with the account name available to VoiceOver. `/new` and `/reset` retain their destination ID when retried across chat
reconstruction or relaunch. After an uncertain `/yolo` toggle, inspect `/yolo status`
and choose an explicit `/yolo on` or `/yolo off`.

**Check Hermes status** runs only `/status` and keeps the current composer draft,
attachments and any unconfirmed submission. It remains available after a command
error or status result, including when ordinary message sending is guarded.
An unconfirmed server cancellation remains unconfirmed; this inspection does not
reset the conversation or authorize another reply. Follow the server's reported
recovery instruction before retrying `/new` or `/reset`.

`CollectiveUITests/ChatRecoveryTests.swift` uses synthetic transport failures,
delayed snapshots, clean EOF and immutable requests. The standalone UI regressions
exercise `--demo-stream-scenario recovery|uncertain` and
`--demo-attachment-scenario failed` only in the Debug demo session. These fixtures
never call a model or modify a production chat.

## Run on a device (bundle ID and team)

The project ships with `PRODUCT_BUNDLE_IDENTIFIER = io.collectiveui.app` and no development team.

1. In Xcode select the **CollectiveUI** target, then **Signing & Capabilities**.
2. Choose your **Team**. Signing is automatic.
3. Change **Bundle Identifier** to one you own, for example `com.yourcompany.collectiveui`.

You can also set `DEVELOPMENT_TEAM` and `PRODUCT_BUNDLE_IDENTIFIER` in the target's build settings, or pass them to `xcodebuild`.

## Point the app at a server

On first launch, enter your server address, for example `ai.example.com`. If you don't enter a scheme, `https://` is added. Trailing slashes are removed, and installations under a sub-path such as `https://example.com/portal` are supported. The app checks `/api/mobile/info` before continuing.

For local development, enter `http://localhost:3000` in the simulator, or `http://<your-mac's-LAN-IP>:3000` on a device. Plain HTTP is allowed only for local-network addresses (`NSAllowsLocalNetworking`). Public servers must use HTTPS.

To use another server later, sign out (Settings) and tap **Change server**.

## How sign-in works

The app uses OAuth-style PKCE inside `ASWebAuthenticationSession`. This works with every sign-in method the web app supports (local accounts with passkeys/TOTP, Microsoft Entra ID, LDAP):

1. The app opens `{server}/mobile/authorize?code_challenge=…&code_challenge_method=S256&state=…&device_name=…`.
2. You sign in on the web page if needed, then tap **Approve**.
3. The server redirects to `collectiveui://auth/callback?code=…&state=…`. The app checks `state` and exchanges the code at `POST /api/mobile/auth/token`.
4. The returned bearer token and server address are stored in the Keychain (this device only, available after first unlock).

The device appears in the server session list under its device name. Signing out revokes the token (`DELETE /api/mobile/v1/session`) and clears the Keychain. Any `401` response also signs the app out.

## Mobile website parity and settings

Design authority: `src/app/globals.css`, `src/components/sidebar/sidebar.tsx`,
`src/components/chat/chat.tsx`, `composer.tsx`, `message.tsx`, `chat.module.css`,
`src/components/settings-view.tsx` and `src/components/admin/admin-nav.tsx`.
The app uses the site's neutral palette, server welcome copy, bot identities, rounded
surfaces and destination names rather than an iOS grouped Form. Home lets you open a
native model conversation or a bot home; its composer-shaped target chooser opens
New chat, not a fake input. The sidebar adds Home while retaining search, projects,
chat actions and the account footer. iPad retains split navigation; native Dynamic
Type, large touch targets and Reduce Motion remain supported.

**Native settings:** device-only appearance, Live Activities, native account/server/
session facts and confirmed native sign-out. These do not edit website preferences.

**Website controls:** General (default target), Security, Personalization, Memory,
Approvals, Connected accounts, Workspace and Data controls link to the actual
`/settings?tab=…` sections. Website capability policies may hide Connected accounts
or Workspace and fall back to General. Current administrators additionally receive
Usage, Connections, Managed Hermes, Groups, Users, Bots, Pets, Bots & tools, MCP
servers, Workspaces, Activity and Organization settings at the existing `/admin`
routes. Admin access is validated against the current mobile session, not cached
shell roles, and rechecked before opening. Validation failures hide administration.
Late session/shell responses are ignored after logout or server change.

A destination preview shows the exact configured-server URL. **Open website** uses
`SFSafariViewController` with ordinary website authentication. Web sign-in may be
required; it may use a different account. No mobile bearer token, cookies or scripts
are injected into the browser, and no backend authentication bridge was added.
URLs come from a fixed catalog, preserve installation subpaths and reject bases
with credentials, queries, fragments or path traversal. The website independently
enforces admin/security permissions (`src/lib/session.ts`). Safari owns subsequent
navigation, including identity-provider redirects; this is not a locked-down web
view. Native sign-out does **not** sign out browser sessions. Access refreshes on
browser dismissal/foreground, and pending destinations clear when login changes.

Offline demo website previews do not open a browser or make network requests.
Use `--demo-role member` for non-admin fixtures, `--demo-settings-section admin`
with `--demo-screen settings` for the administrator directory, and `--demo-screen
welcome` for the welcome screen. Regression tests capture personal/admin route
previews, role visibility, welcome navigation and header/transcript separation.
The screenshot script explicitly sets `--demo-appearance` per scenario, requires
both iPhone/iPad and fails on any required screenshot failure or empty file.

Local Linux guardrails: `python3 ios/scripts/test-parity-contracts.py` checks source
contracts only, **not** rendering or native compilation. The Foundation-only
settings policy XCTest suite can run in isolation with `bash ios/scripts/test-settings-policy.sh`
when Docker Swift execution is authorized. Full package/app unit tests, Debug and
Release builds, simulator regressions, large-text/orientation checks and actual
light/dark iPhone/iPad screenshot review still require macOS/Xcode CI. No visual
parity claim should be made until those screenshots have been inspected.

## Architecture

### Appearance and chat input

The native views use the website's #181818 dark canvas, a compact sidebar,
bot artwork and the website's message colors. `PortalTheme` centralizes adaptive colors; the interface remains
SwiftUI, with a native `UITextView` for the composer. Return (including a hardware keyboard's Enter)
inserts a newline. Only the Send button submits a message.

Settings → Appearance saves System, Light or Dark independently of the phone's setting.
The chat header sits outside the scrolling viewport at every text size and orientation, so identity controls never obscure messages.
The unified composer has its plus menu inside the capsule and the microphone on the right. Its placeholder is
`Ask anything` for models or `Message <bot>` for bots. Typing `/` or choosing Commands in the plus menu opens the command picker without submitting; bot skills come from the conversation snapshot,
and Hermes controls use `/api/chat/commands` (including its revision and retry identifiers).
Control failures retain the draft, and controls with attachments are rejected locally without losing files.
After an uncertain chat submission, the app checks persisted message status before allowing another send.
Confirmed unsaved messages restore their original multiline draft and attachments; approval snapshots clear
optimistic local decisions. Artwork credentials are limited to the exact server origin, and authenticated
redirects cannot move to another scheme, host or port.

Unsent drafts and uploaded attachment references survive chat switching and app relaunch. They are stored
on this device in a protected directory excluded from backups, separately for each server and credential
session. Signing out, changing servers, deleting the chat or receiving a session-ending 401 clears the
relevant draft state. Uploads interrupted by app termination show an error so the file can be attached again.
Streaming follows the newest message while the reader stays near the bottom; scrolling away preserves
their place, and the down-arrow button resumes following. Keyboard and orientation changes follow the
same policy. Stopping an empty reply shows `Reply stopped`, with that response's marker retained locally
across snapshots and relaunch. The server currently persists partial output but does not include a terminal
cancellation reason in conversation snapshots, so this marker is specific to this device/session.
Transcript rows are measured eagerly so changing offscreen height estimates cannot shift the reader
during streaming. Very long histories carry rendering and memory costs; pagination remains a follow-up,
as the current snapshot API loads the complete thread.

The microphone uses native on-device speech recognition after the user grants Speech Recognition and
Microphone permission. Recognized words are added to the draft for review, never sent automatically.
Recording stops on backgrounding, interruption or leaving the composer. Unsupported locales show a
message so the user can use keyboard dictation instead; no transcription service is called.

The mobile shell optionally includes display-only `pets` metadata. Updated servers provide authenticated
artwork through `GET /api/mobile/v1/bots/[id]/pet/avatar`; older servers continue to use blob/emoji avatars.
Built-in pets use native vector artwork. Custom avatars also require these server changes to be deployed; an app-only rebuild against an older server cannot supply the missing metadata/endpoint. Imported atlases honor the user's still-motion preference,
Reduce Motion and app backgrounding; compact roster avatars remain still. Pet editing stays on the website.

- **CollectiveKit** (`CollectiveKit/Sources/CollectiveKit`)
  - `JSONValue`: Codable arbitrary JSON (tool input/output, data parts).
  - `Models`: lenient `Decodable` API types. Missing or `null` optional fields never fail decoding.
  - `MessagePart` / `UIMessage`: AI SDK UI message parts. Unknown part types decode to `.unknown` and keep their raw JSON.
  - `SSEParser`: incremental Server-Sent Events parser. Handles arbitrary chunk splits, CRLF, `: keepalive` comments and `[DONE]`.
  - `UIMessageChunk` + `UIMessageStreamReducer`: decodes stream chunks and applies them to an assistant message. This is a pure value type, so it is unit tested.
  - `APIClient`: async endpoints, multipart upload with progress, and `AsyncThrowingStream<UIMessageChunk, Error>` for `/api/chat` and resume streams. It uses a URLSession with a 300 s request timeout.
  - `PKCE`, `MobileAuth`, `IDGenerator`, `MarkdownParser`.
- **App** (`CollectiveUI/`)
  - `AppModel` (`@Observable`, main actor): server, token, shell data, navigation selection, banners and global 401 handling.
  - `WebAuthenticator` + `KeychainStore`: the sign-in flow and token storage.
  - `MainView`: a `NavigationSplitView` with the sidebar (search, bots, grouped chats, inbox, compose, settings) and a chat detail column.
  - `ChatModel` / `ChatView`: snapshot loading (thread = path from the leaf to the root), streaming with live updates, resume after relaunch, stop, regenerate, tool approvals, uploads and the composer.

## Demo mode & screenshots

Debug builds include a demo mode that runs entirely offline. A `URLProtocol` answers every request to `demo.collectiveui.app` from in-memory fixtures (`CollectiveUI/Demo/`), including streamed replies, approvals, search, the inbox and a generated chart image. Release builds don't contain any demo code: everything is wrapped in `#if DEBUG`.

Launch arguments (Xcode: **Product → Scheme → Edit Scheme → Run → Arguments**, or `xcrun simctl launch <device> io.collectiveui.app …`):

| Argument | Effect |
| --- | --- |
| `--demo` | Start signed in as the demo user "Jordan Lee" without reading real credentials. Fixture sessions never touch the Keychain; a real server login reached later uses normal credential persistence. |
| `--demo-open <conversationId>` | Open a conversation, e.g. `demo-research`, `demo-approval`, `demo-image`, or a bot home chat such as `home-bot-atlas` |
| `--demo-send "<text>"` | About 1 s after opening, type and send this message in that chat, then stream the reply |
| `--demo-screen <name>` | Show `inbox`, `settings`, `newchat`, `search`, `setup` or `signin` |
| `--demo-sidebar-collapsed` | On iPad, show only the chat column |
| `--demo-stream-scenario long` | Stream 600 deterministic offline lines over about 120 seconds for scroll regressions; Stop ends the fixture early |
| `--demo-stream-scenario delayed` | Wait six seconds before visible output for immediate Stop regressions |
| `--demo-hermes-cancellation` | Show a historical unsupported-file rejection and a synthetic unconfirmed cancellation; `/reset` is rejected and `/status` inspects without submitting the retained draft |
| `--demo-reset-drafts` | Clear only the fixture session's saved drafts and local stopped-reply markers on launch; omit when checking relaunch persistence |

Example:

```sh
xcrun simctl launch booted io.collectiveui.app --demo --demo-open home-bot-atlas \
  --demo-send "How do I enable the iOS app on our server?"
```

The **Simulator screenshots** job in `.github/workflows/ios.yml` builds the Debug app and runs `ios/scripts/simulator-screenshots.sh`. That script captures light and dark iPhone and iPad screenshots plus a short streaming video, and uploads them as the `ios-screenshots` artifact. To run it locally, build the Debug app for the simulator and run:

```sh
xcodebuild -project ios/CollectiveUI.xcodeproj -scheme CollectiveUI -configuration Debug \
  -sdk iphonesimulator -derivedDataPath build/DD CODE_SIGNING_ALLOWED=NO build
ios/scripts/simulator-screenshots.sh build/DD/Build/Products/Debug-iphonesimulator/CollectiveUI.app screenshots
```

For the committed offline UI regressions, build the separate QA bundle and run the fixture-only suite.
The script accepts an optional simulator UUID as its third argument and writes screenshots, hierarchy
attachments and the result bundle under the output directory. CI publishes these as `ios-regressions`.

```sh
xcodebuild -project ios/CollectiveUI.xcodeproj -scheme CollectiveUI -configuration Debug \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath /tmp/collectiveui-qa-dd \
  QA_APP_BUNDLE_IDENTIFIER=io.collectiveui.qa CODE_SIGNING_ALLOWED=NO build
bash ios/scripts/simulator-regressions.sh \
  /tmp/collectiveui-qa-dd/Build/Products/Debug-iphonesimulator/CollectiveUI.app \
  /tmp/collectiveui-qa-results
```

## Troubleshooting

- **"This server doesn't support the mobile app"**: the server returned 404 for `/api/mobile/info`. Update the server.
- **Sign-in sheet closes immediately**: make sure the server redirects to the `collectiveui://auth/callback` scheme.
- **Replies stop mid-way on a flaky network**: when you reopen the chat, the app re-fetches the conversation and resumes any reply that is still running.

For offline visual checks, `--demo-appearance dark` saves the demo app's dark preference,
`--demo-commands` opens the command picker, `--demo-focus` opens the keyboard, and
`--demo-draft "Line one\nLine two"` sets a draft (use an actual newline in the argument).
Demo Atlas and Research use synthetic v2 and v1 atlases
through the same authenticated loader as imported pets. These fixtures are not a user's custom avatar.

## Live Activities

Settings → Live Activities → Show bot status enables a static pet pose and generic run status on the Lock Screen
and Dynamic Island. Tap returns to the exact authorized chat. It starts while foregrounded; up to three direct-bot
runs can appear concurrently. Task text stays private. Approval decisions remain in chat.

The `CollectiveLiveActivity` widget extension is embedded automatically. Both targets use `COLLECTIVE_BUNDLE_ID`
(default `io.collectiveui.app`), with `.liveactivity` appended for the extension. Use that setting when changing
bundle identifiers, so the app and extension identifiers stay aligned.

Background push is disabled by default and requires separately approved Apple provisioning/APNs setup and device
verification. See [Live Activity operation and validation](../docs/operations/live-activities.md) for prerequisites,
configuration, supported cases and offline previews. No Apple account capability or push entitlement is enabled
by this implementation.
