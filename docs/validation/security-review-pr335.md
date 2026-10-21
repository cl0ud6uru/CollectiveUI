# Security review integration validation

PR #335 keeps its twelve issue-specific commits and merges main `76b1cb4e254ac643776f001a3342f33235a64397` without rewriting history. The single conflict in the MCP admin page preserves both its page-level admin authorization and main's MCP Apps configuration imports.

## Review repairs

- Parser concurrency now transfers an occupied permit directly to the next waiter. A new caller cannot steal that permit before the waiter's continuation runs. The deterministic synthetic-spawn regression observed three active parsers before the repair and two afterward. It executes the production extraction source with a fake child-process boundary; it does not start parsers or use a network.
- Composer previews are tracked immediately when created and released when removed, sent, rejected or unmounted. A multi-file upload stops when its composer unmounts, including after a pending upload succeeds or fails; it cannot create untracked previews for the rest of the batch. The six-case browser fixture uses the production Composer in React Strict Mode with headless Chromium and loopback-only synthetic uploads. Both unmount cases failed before the repair; all six cases pass afterward.

## Focused checks

- `npm run typecheck` and ESLint on the changed source, fixtures and tests.
- 53 tests across authz coverage, delegation authority, PDF/DOCX extraction (including the compressed document bomb), extraction concurrency, dependency compatibility, bot drafting, service-bot policy, toolset lifecycle, Markdown image rendering and the embedded PostgreSQL review regressions.
- `node tests/browser/composer-preview-lifecycle.mjs`: 6 passed. The fixture aborts all non-loopback requests and performs no real upload, server action or provider request.
- The three embedded PostgreSQL regressions run production queries and the actual AI SDK approval continuation. Against main's source, routine copy privacy, approval continuation and drafting-policy cases all fail; the approval case fails with signature verification after remembering a grant. All three pass with the fixes. The fixture checks template editor authorization and the current dispatch binding as well.
- Embedded PostgreSQL substitutes arrays for unrelated pgvector columns. It does not prove real PostgreSQL pool/locking behavior, vector execution or the broader service-bot integration suite. The existing integration suite remains available for its separately provisioned disposable PostgreSQL database.

## Platform parity and limits

Web Markdown now loads root-relative same-origin images inline and renders external images as links. iOS `MarkdownText` and macOS `DesktopMarkdownView` render inline Markdown through `AttributedString` in SwiftUI `Text`; neither surface has a Markdown image fetcher. This parity check is based on source inspection and does not claim a native live-network test. Composer object URLs are browser resources; native clients do not use this preview allocation path.

Issue #310 remains partial: the 30 MB proxy buffer restores normal uploads under the default 20 MB per-file limit, and truncated/incomplete multipart data produces HTTP 413. Admin configuration still allows a larger file limit (up to 500 MB), including through The Architect; uploads above the transport buffer are not supported by this change. Keep #310 open until the configurable limit and transport ceiling are reconciled across those paths.

No production service, provider, credential, account, deployment or live security configuration was changed by this validation. Hosted CI, release-image validation and independent final-commit review remain separate merge gates.
