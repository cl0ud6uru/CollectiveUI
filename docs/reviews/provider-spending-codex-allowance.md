# Provider spending and Codex allowance implementation

## Delivery

Local branch: `feat/provider-spending-codex-allowance`, based on current main `73ee97f8dee17b04e59acf52bae85673d6cdb5f0` (re-fetched and unchanged on 2026-10-08). No branch was pushed, PR published, merge performed, deployment made, real credential created/collected, or live account connected.

Sequential implementation commits:

1. `37fd785` — provider dashboard, encrypted billing configuration, subscription accounting isolation and migrations. This is the first reviewable delivery.
2. `3e8a276` — disabled owner-only Codex allowance adapter/UI and the first independent review fixes.
3. `beef4b5` — account-change fences and first-read notification preservation from the follow-up review.

The provider dashboard is at `/admin/spending`. It uses actual provider-reported month-to-date Costs, daily trends and authorized project breakdown; project allowance is bounded by the parent organization allowance. It shows currency, returned enforcement, original refresh timestamps, provider-delay context and honest unknown/stale/error states. Configuration and the optional chat-header health bar default off. Admin/IT authorization is enforced at pages, actions, cache reads and refresh/store boundaries. The separate Platform Admin key is encrypted server-side with row/organization-bound AAD and never enters inference configuration, bot contexts, browser responses, exports or logs. GET-only provider requests cannot change limits or enforce a local cap.

The usage ledger freezes provider connection, organization, project, billing source and route at dispatch, including embedding and native Team dispatch. Subscription/background/delegated calls retain tokens while all API-dollar fields and search-fee estimates stay null. Unverified Hermes routes remain unknown and excluded. Existing history is not reassigned to current connections. Migration `0047` clears erroneous historical subscription monetary fields while preserving token receipts and adds a defensive constraint. Provider-dollar totals are entirely independent of local token estimates.

The General Settings allowance bar uses only official app-server returned windows, percentages, durations, resets and per-field source/freshness. The owner-only API has no caller-selected owner or browser-configurable transport. Account changes clear caches; retired runtimes cannot publish; authorization is checked on every cache read and after refresh I/O; sparse notifications retain omitted fields' original timestamps. Notifications during the first read are buffered and published only after the ChatGPT account gate and successful read. There is no production runtime registration, new sign-in flow, private endpoint, OAuth reuse, or architectural migration. The feature remains disabled and does not claim a working live connection.

## Review surfaces

- [Provider architecture and source contracts](../architecture/provider-spending.md)
- [Codex architecture and activation requirement](../architecture/codex-allowance.md)
- Provider screenshots: [desktop](../screenshots/provider-spending/dashboard-1280.png), [mobile](../screenshots/provider-spending/dashboard-390.png)
- Codex screenshots: [desktop](../screenshots/codex-allowance/allowance-1280.png), [mobile](../screenshots/codex-allowance/allowance-390.png)

All screenshots and browser fixtures use synthetic data. For a reviewable provider fixture, run `node tests/browser/provider-spending.mjs --serve` and open port 4198. It needs no account or key. Screenshots do not establish live provider/runtime conformance.

## Validation

Checks on `beef4b5`, completed 2026-10-08 UTC:

| Check | Result |
| --- | --- |
| `npm test` | 168 files passed, 68 skipped; 2,035 tests passed, 514 skipped; exit 0. Skips are existing external PostgreSQL, Docker, live-service and opt-in prerequisites, not a live-integration success claim. |
| `npm run typecheck` | Route generation and TypeScript passed, exit 0. |
| `npm run lint` | Passed, exit 0. |
| `npm run build` | Next.js 16.3.8 production compilation, TypeScript and route generation passed, exit 0. |
| Provider browser fixture | Chromium passed at 320/390/768/1280 pixels: parent cap, multiple accounts, stale/permissions, failed refresh, idle expiry, default-off configuration and key clearing. |
| Codex browser fixture | Chromium passed at 320/390/768/1280 pixels: only returned 37-minute window, source, unknown reset, failed refresh, idle expiry and disabled integration. |
| `npm run db:generate` | No schema changes; generated migration snapshots and schema are consistent. |
| `git diff --check` | Passed. |

Full-suite output: `/tmp/collective-final-test.log`; typecheck: `/tmp/collective-final-typecheck4.log`; lint: `/tmp/collective-final-lint.log`; build: `/tmp/collective-final-build2.log`; browser outputs: `/tmp/collective-provider-ui-final.log` and `/tmp/collective-codex-ui-final.log`. These logs are environment-local; committed screenshots and this report are the durable review evidence.

Coverage includes permission leakage, independent organizations/projects, encrypted-key binding and secret redaction, stale/month rollover/UTC leap-year boundaries, unset and inaccessible limits, malformed/overlapping pagination, failed refresh and concurrent disable/rotation, immutable embedding/native-Team attribution, subscription/background/delegated exclusion, owner-only quota caches, account and connection retirement, initial/read-time sparse notifications, failed quota reads and idle expiry. The SQL migration tests run all historical migrations followed by `0046`/`0047` in disposable PGlite; pgvector is mapped to arrays in that fixture.

Independent Sol review approved `beef4b5` for the documented disabled implementation, with no further actionable findings. All six findings were fixed and verified: pre-I/O embedding attribution, native Team receipt selectors, stale parent allowance, idle freshness, final-authorization account change, and first-read notification loss. The final reviewer independently reproduced both quota races and confirmed their fixes; its focused verification passed 18 tests across two files.

## Remaining activation and validation limits

1. Provider activation needs a separately authorized organization-owned Platform Admin key with only the required Costs and organization/project spend-limit read access. Exact restricted scope names were not established by the current official public contracts; confirm the current Platform permission selections with the organization owner/OpenAI before activation. No names were invented. Only configured saved-connection project IDs have limits retrieved; other authorized breakdown projects retain unknown limits.
2. Personal allowance activation needs a separately authorized, isolated app-server already authenticated to the intended user's ChatGPT account. A trusted runtime broker must register owner/connection/auth-epoch-bound authorization, decoded official reads and notifications, and lifecycle teardown in the serving process. The current adapter is process-local, not a cross-worker registry. An organization billing key cannot supply personal allowance. Setting the flag alone does not connect a runtime.
3. Live provider/authenticated-runtime conformance, production PostgreSQL and opt-in external database/Docker suites were not exercised. Monthly spend allowance is neither prepaid credit nor a ChatGPT plan balance. Provider reporting delay and stale evidence can make current remaining allowance unknown.

Read-only overlap checks found Hermes-owned PRs #114/#115/#116/#118 still open. Their unrelated credential/session/security fixes were not duplicated. The required billing-secret rewrap hook is limited to the new store. Dependency audit issue #117 was inspected; the branch does not change dependency versions. Held PR #64 and unrelated document/environment work were left untouched.

## Draft PR summary (not published)

**Title:** Add read-only provider spending and disabled personal Codex allowance

Admins can review actual OpenAI month-to-date costs and organization/project spending limits in a dashboard that starts disabled. The optional header bar opens that dashboard; unknown, delayed, stale and inaccessible values remain explicit, and project remaining allowance cannot exceed its parent organization's reported allowance. A separate encrypted Platform Admin key serves only read-only billing requests.

Subscription-backed ChatGPT/Codex and unverified Hermes activity retain token receipts without entering API-dollar totals or budgets. Dispatch attribution is preserved across connection changes, including embedding and native Team calls, with migration and database protection for historical subscription rows.

General Settings adds an owner-only personal allowance bar and a disabled official app-server adapter. It renders only returned windows and sources, handles sparse notifications and account-change races, and requires separate authenticated-runtime activation; this PR does not establish a live Codex connection or reopen held sign-in work.

Validation: see the final results above, the synthetic desktop/mobile screenshots and the independent Sol approval. Apply migrations `0046` and `0047` as part of a separately authorized deployment. Provider permission verification and personal runtime wiring remain activation requirements.
