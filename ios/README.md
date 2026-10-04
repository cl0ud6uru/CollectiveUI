# CollectiveUI for iOS

A native SwiftUI client for a CollectiveUI server. It runs on iPhone and iPad (iOS 17+). You can chat with model connections and bots, approve tool actions, read the inbox and search your history.

```
ios/
  CollectiveKit/            Swift package (Foundation only): models, API client, SSE parser,
                            UI message stream reducer, PKCE. Unit tested with `swift test`.
  CollectiveUI.xcodeproj    App project (the CollectiveUI/ folder is a synchronized group, so
                            new files are picked up without editing the project)
  CollectiveUI/             App sources: App/, Auth/, Views/, Chat/, Support/, Assets.xcassets
  Config/Info.plist         Extra Info.plist keys (local-network ATS exception)
```

## Requirements

- Xcode 16 or newer (the project uses `objectVersion = 77` with synchronized folders)
- iOS 17 or newer on a device or simulator
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

# Simulator build without signing
xcodebuild -project ios/CollectiveUI.xcodeproj -scheme CollectiveUI \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

The `iOS` GitHub Actions workflow (`.github/workflows/ios.yml`) runs both commands on macOS for every change under `ios/`.

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

## Architecture

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

## Troubleshooting

- **"This server doesn't support the mobile app"**: the server returned 404 for `/api/mobile/info`. Update the server.
- **Sign-in sheet closes immediately**: make sure the server redirects to the `collectiveui://auth/callback` scheme.
- **Replies stop mid-way on a flaky network**: when you reopen the chat, the app re-fetches the conversation and resumes any reply that is still running.
