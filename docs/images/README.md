# README screenshots

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

For future refreshes, follow the [local setup](../getting-started.md), keep fixtures in a disposable database, use a synthetic account, and retain the mock-provider disclosure. Capture through the actual app, inspect every image for rendering problems and private information, and keep the assets here so repository Markdown works without external attachments. Do not point screenshot tooling at a real installation.

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
