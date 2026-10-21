# Web composer focus after send

Base: `76b1cb4e254ac643776f001a3342f33235a64397` (PR #337).
Scope: web keyboard focus only. No provider calls, production messages, deployment, or native changes.

## Cause and fix

The first submitted message switches `Chat` from its empty layout to the transcript layout. These contain separate `Composer` instances, so React removes the focused textarea. The new composer also mounts `NativeSearchControl`, which verifies the conversation's search policy and temporarily disables the field. The old autofocus effect only ran on the empty composer and did not retry when verification completed.

Clicking Send has a second failure path in existing conversations: the browser focuses the button, then submission disables it or changes it into Stop. No code returned keyboard input to the textarea. Enter in an existing conversation did not reproduce that second path.

`Chat` now shares a small focus-intent ref across both composer layouts. Explicit Send activation returns focus synchronously, before the button changes. A layout effect carries that intent across textarea replacement and waits until search verification enables typing. It only restores when focus has fallen to the document body. Focus on another control, pointer interaction elsewhere (including nonfocusable content), Tab, or window blur cancels the intent. Stream completion does not create a new focus request. Initialization happens once per chat, so rejection/remount does not reapply autofocus after the user moves away.

Rejected unsaved-message recovery previously called `setText`, which scheduled unconditional focus on the next animation frame. Recovery now restores the draft without requesting focus; the same intent controls whether typing resumes. Other explicit composer-prefill actions keep their existing focus behavior.

No button is removed from the tab order, pointer default is not prevented, and existing message/command accessibility labels and IME/Shift+Enter handling remain in place.

## Reproduction and coverage

Run from the checkout after installing dependencies:

```sh
node tests/browser/composer-focus.mjs
```

The test bundles the production `Chat`, `Composer`, `NativeSearchControl`, and AI SDK in React Strict Mode. Next navigation and server actions are synthetic. All browser requests outside the fixture origin are blocked; chat, uploads, search policy and failures are synthetic. A loopback SSE response remains open while focus and typing are asserted, then emits its remaining chunk and closes. Failures print DOM identity, focus-event and disabled-attribute traces.

On an untouched archive of the base commit, the final matrix produced 7 passes and 19 case failures. First-send traces show a replaced textarea (`sameInput: false`) with focus on `body`; saved-click traces show the same textarea (`sameInput: true`) with focus on Send/Stop. The fixed checkout passes all 26 cases. Some baseline cases fail at their initial focus assertion, before reaching their later lifecycle assertions.

The 26 passing cases cover:

- First and saved conversations; Enter, pointer Send, and keyboard activation of Send.
- Submitted, open SSE streaming, final response, and typing the next draft while streaming.
- Delayed search verification with restoration, plus cancellation by another control, blank content, Tab, and window blur.
- Unsaved HTTP rejection with draft recovery, HTTP 500, transport failure, and partial-response stream error; focus remains where the user chose.
- First and saved file-only sends, blocked incomplete uploads, attachment payloads and accepted-file clearing.
- Composing Enter does not send; Shift+Enter inserts a line; normal Enter sends multiline content once.
- Async acceptance/rejection preserves appropriate drafts and focus.
- Stop and send during an open stream, and accessible explicit Stop without reclaiming typing focus.

The same harness can target a clean source archive with `COLLECTIVE_UI_SOURCE_ROOT=/absolute/source/path`; that source needs dependencies available for bundling. No production server or account is required.

Additional validation passed:

```sh
npm run typecheck
node_modules/.bin/eslint src/components/chat/composer.tsx src/components/chat/chat.tsx tests/browser/composer-focus.mjs
node_modules/.bin/vitest run --project unit tests/unit/composer-commands.test.ts tests/unit/hermes-command-route.test.ts tests/unit/chat-send-fetch.test.ts tests/unit/message-reply.test.ts --maxWorkers=1
node tests/browser/starter-attachments.mjs
node tests/browser/remote-hermes-commands.mjs
node_modules/.bin/playwright test --config tests/message-interactions.playwright.config.ts
```

The selected unit suites passed 25 tests; message-interaction Playwright passed 11 tests, including reply recovery, mentions, branch changes, read-only accessibility and mobile targets. The existing attachment and Hermes command browser harnesses also passed.

## Platform parity and remaining gaps

- Web: the behavior applies to both conditional composer layouts and the shared Send/Stop controls; existing Hermes command and group reply/mention regressions pass.
- iOS: source review of `ChatView`, `ComposerView`, and `MultilineComposer` shows the composer outside the transcript's empty/content switch, an existing `UITextView` retained across send, and no send-time resignation. Return intentionally inserts a line; the explicit Send button submits. The field is not disabled for response streaming.
- macOS: source review of `DesktopChatView`, `DesktopComposerView`, and `DesktopComposerKeyHandler` shows stable composer placement, an enabled native editor while streaming, and existing `isFocused = true` after Send. Enter/Shift+Enter and native input-method handling remain platform specific.

Executed on macOS with Playwright 1.63.0 and its bundled headless Chromium. Windows/Docker deployment, real OS IME, screen-reader interaction, Firefox/WebKit, and native-device runtime behavior were not exercised. The synthetic test verifies browser-side focus and lifecycle behavior, not production provider or infrastructure operation. Native parity is a source review; no unrelated native changes were made.
