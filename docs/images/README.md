# Documentation screenshots

## Live app captures — 2026-10-15

The README and user-facing guides use actual deployed CollectiveUI screens captured through the user's existing Firefox installation. The authenticated views use empty or unsaved states; the sign-in screen was opened separately in a private window with empty credentials. No application code, DOM, response data or artwork was changed for these captures. No message, model request, voice session, sign-in or configuration save was submitted.

Firefox's Responsive Design Mode exported lossless PNGs at **1440 × 900**, device pixel ratio 1, in the app's existing dark appearance. The selected assets are crops of those exports, with metadata removed. They contain no overlays, blurring, replacement text, compositing or generated UI.

| File | Deployed view and framing |
| --- | --- |
| [New chat](live-app/new-chat.png) | **1368 × 828**. Empty model-chat composer. The personal navigation rail and account/provider header are outside the crop. |
| [Bot avatars](live-app/bot-avatars.png) | **566 × 700**. The avatar section of the unsaved **New bot → Configure** form, including the original icon and available catalog options. Navigation, model configuration and the empty preview pane are outside the crop. |
| [Sign in](live-app/sign-in.png) | **1440 × 828**. Public sign-in screen with blank local-account fields and the passkey option. Browser chrome and the installation's credit footer are outside the crop; artwork notices remain linked below. |

Each selected image was visually inspected at its native size and independently reviewed for privacy. PNG metadata was checked for identifying fields. Browser chrome, personal navigation, conversations, notifications, account names, credentials, balances, private endpoints and file previews are excluded. Raw exports and intermediate images stay outside the repository and are not publication assets.

These captures document the visible deployed interface, not model quality, provider connectivity, voice operation or a claim that every feature on the repository's current branch is deployed. Historical fixture screenshots remain below as QA evidence.

### Artwork notices

The sign-in and avatar images show catalog artwork already present in the deployed installation. Their inclusion does not change the artwork's license or assert ownership or endorsement. See the existing [Hermes](../../assets/pets/hermes/README.md), [Hermes Assimilated](../../assets/pets/hermes-assimilated/README.md), [Nimbus](../../assets/pets/nimbus/README.md) and [catalog notices](../../assets/pets/README.md). Hermes and Hermes Assimilated, including their reproduction in screenshots, are excluded from the application's MIT license; their existing provenance and permission limitations still apply.

### Future live refreshes

Use an explicitly authorized live session and genuinely empty or unsaved states. Avoid personal sidebars, saved conversations, provider administration, file previews and account details. Do not make paid requests or change saved data to stage a capture. Export the actual browser viewport, crop only at clean boundaries, strip metadata and inspect every final pixel at native size. Obtain an independent privacy review and the owner's approval before any screenshot is committed or published. Keep raw captures outside Git, including intermediate commits. Skip a view if a clean capture is not possible.

## Historical component captures — 2026-10-12

The workspace, voice and sidebar QA images linked here were generated from the production components at that time using the checked-in isolated browser fixtures. These are historical component previews with synthetic data and simulated endpoints, not a deployed full-stack installation. No live account, provider, Docker workspace, microphone or paid inference was used. PNGs are direct Playwright captures, without retouching or compositing.

| Capture | View and fixture boundary |
| --- | --- |
| [Workspace files](../screenshots/workspace-browser/desktop-files.png) · [light](../screenshots/workspace-browser/desktop-light.png) · [terminal](../screenshots/workspace-browser/desktop-terminal.png) | Actual workspace component at 1600 × 1000; surrounding chat, file contents and daemon responses are synthetic. |
| [Workspace empty](../screenshots/workspace-browser/desktop-empty.png) · [wide empty](../screenshots/workspace-browser/reference-viewport-empty.png) | 1600 × 1000 and 2558 × 1410; the latter retains the original QA viewport, not a newly verified reference comparison. |
| [Workspace mobile 320](../screenshots/workspace-browser/mobile-320.png) · [390](../screenshots/workspace-browser/mobile-390.png) | Current mobile workspace dialog at 320/390 × 844. |
| [Voice desktop](current-voice/voice-desktop.png) · [mobile](current-voice/voice-mobile.png) | Fullscreen voice with the original 2D bot icon and captions at 1280 × 900 and 390 × 844. WebRTC, microphone tracks and transcripts are simulated. |
| [Sidebar desktop](current-sidebar/desktop.png) · [mobile 320](current-sidebar/mobile-320.png) · [390](current-sidebar/mobile-390.png) | Actual sidebar/navigation components cropped to their element bounds. Generic Demo User and fixture bot activity; no authenticated account. |

Reproduce from the repository root after `npm ci`:

```bash
# Omit these browser overrides when Playwright's matching Chromium is installed.
# Replace /path/to/chromium with your installed browser executable.
CHROME_EXECUTABLE_PATH=/path/to/chromium node tests/browser/workspace-browser.mjs
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chromium \
  VOICE_SCREENSHOT_DIR=docs/images/current-voice node tests/browser/voice-mode.mjs
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chromium \
  SIDEBAR_ROSTER_SCREENSHOT_DIR=docs/images/current-sidebar node tests/browser/sidebar-roster-design.mjs
```

All three scripts passed their interaction assertions and reported no page errors. The refresh used installed Google Chrome on macOS, 1× device scale. The workspace and sidebar fixture inputs use generic names; application components were not changed for the captures. Older full-stack captures below were retained and dated because Docker/Postgres were unavailable for a new full-stack session on this host.

## Earlier full-stack demo — 2026-10-02

The chat, bots, avatars and sign-in PNGs are actual Chromium captures of the production build of CollectiveUI, captured on 2026-10-02. No application code or rendered DOM was changed for the captures.

| File | View |
| --- | --- |
| [chat.png](chat.png) | Writing Partner's persistent home chat, with a completed mock-provider reply, code, table, math and activity panel. |
| [bots.png](bots.png) | The Bots page with four synthetic assistants. |
| [avatars.png](avatars.png) | The actual Pet avatar dialog, captured directly as an element with Shared bot pet expanded. |
| [sign-in.png](sign-in.png) | Local-account sign-in with empty credential fields and the built-in Moss companion. |
| [hermes-backends.png](hermes-backends.png) | Admin Connections with Mock GPT and two saved synthetic Hermes profiles. Configuration view only; no live Hermes connection test. |

The local instance used a separate disposable `collective_readme_demo` database, synthetic local credentials, Node 24, PostgreSQL 17 with pgvector, the included `dev/mock-llm` provider and the real background worker. Full-page viewport captures are 1440 × 1000 at 1× scale; the dialog is captured at its native size. Browser reduced motion was enabled for stable artwork. PNGs are lossless and contain no overlays or composited UI.

The operator CLI created a local demo administrator; `db:seed` supplied Mock GPT and the initial bot. Additional bot names/descriptions and branding are synthetic database fixtures. The chat reply was produced by sending `Show me a demo of tables, code and math.` through the actual app to its shipped scripted mock provider. It is not a real-model quality example. Moss, Ember and the sign-in shapes are original shipped CollectiveUI art; no private imports, user photos or third-party gallery art were used.

To reproduce these historical demo captures, follow the [local setup](../getting-started.md), keep fixtures in a disposable database, use a synthetic account, and retain the mock-provider disclosure. Do not point the fixture scripts at a real installation. Public live captures follow the separate review process above.

## Hermes backend configuration capture

`hermes-backends.png` was captured on 2026-10-02 (America/New_York) from a fresh production build of the app. The same disposable README database was migrated through 0018. No application code or DOM was changed.

The demo administrator used **Add agent backend** to save **Hermes · Research demo** and **Hermes · Writing demo**, using `research` and `writing` profiles/routes and the loopback endpoint `http://127.0.0.1:18642`. The form saved generated synthetic API keys through the normal encrypted-credential path; none is visible in the image. Reloading the page verified the rows persisted. No Hermes gateway was started, no **Test** button was clicked, and no model or upstream Hermes request was made. This shows how saved backend configuration appears, not verified connectivity or provisioning.

The screenshot is an unmodified Playwright element capture of the actual Connections content, at its native **1152 × 618** pixels, from a 1600 × 1000 desktop viewport in light mode. It includes the normal model/backend separation, profile routes and bot-only badges. Only synthetic demo data appears in the capture.

## Recent delegated task activity

These unmodified Chromium screenshots show the production code, captured on 2026-10-03 over local HTTPS. The named disposable `collective_coordinator_async_browser_test` database contains synthetic users, bots and messages. Tasks execute through the real worker against the shipped scripted mock LLM; no external model or live Hermes backend was used.

| File | View |
| --- | --- |
| [recent-working.png](recent-working.png) | A newly delegated task in Recent chats with its actual running indicator; centered parent header, 1360 × 1000. |
| [recent-unread.png](recent-unread.png) | A completed child remains unread after an early visit, returning to its parent, offline recovery and reload. |
| [recent-read.png](recent-read.png) | Opening the saved completed child clears its dot and refreshes the Inbox count. |
| [recent-mobile-reduced-motion.png](recent-mobile-reduced-motion.png) | Mobile drawer with a static, accessible working indicator under reduced motion, 390 × 844. |

Run `ASYNC_BROWSER=1 BASE_URL=<local preview origin> PLAYWRIGHT_CHROMIUM_PATH=<browser> npm run test:e2e -- --config=tests/async-delegation.playwright.config.ts`. Use a migrated disposable database with the exact name above, local authentication, the mock LLM on port 4068, and a worker with `TASK_RUN_CONCURRENCY=1`. For a production preview, use local HTTPS and `TEST_HTTPS=1` for a self-signed test certificate. The seven browser scenarios cover initial discovery, concurrent/queued tasks, reconnects, terminal transcript loading, stops, persistent unread, parent versus child reads, delayed-response navigation, Inbox count, centered header geometry, mobile/reduced motion and cross-user access.
