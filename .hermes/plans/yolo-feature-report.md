# Session-scoped Runs API YOLO feature report

## Delivery

Branch: architect/yolo-diagnostics-20261009
Base and locally verified origin/main: 234b57703553da249d531618d73e1b1fe36981fa
Checkout: /workspace. No push, deployment, production operations, boundary, sandbox or network changes.

Implemented /yolo (status), /yolo status, /yolo on and /yolo off in normal remote Hermes bot chat commands. These never enter model inference. Session mode is read and changed only in the authenticated backend; no enabled flag is stored in CollectiveUI. A non-dismissible per-chat status appears beside the composer before and after a transcript exists. It shows last-verified ON/OFF or explicit unverified state, refreshed on chat load, command result/error, window focus and every 30 seconds. Catalog results are keyed to chat/target and refresh version, preventing an old successful result from being presented as current while rechecking.

## Source and protocol findings

src/lib/llm/resolve.ts passes caller-supplied session_id `portal-${conversationId}-${botId}` to the remote Runs API. src/lib/llm/providers/hermes/scope.ts now defines the shared hermesSessionId helper used by normal Runs inference and approval controls. Native workspace runtime/stored session IDs are not used. Remote client profile routing is /p/{encoded-profile}; credentials stay server-side. Existing authenticated command routes accept only portal resource IDs, not remote session/profile/URL/key overrides.

Coordinator contract details are in .hermes/plans/yolo-contract.md. Important clarification: GET must support the exact caller-supplied session before the first run (default OFF), and capabilities must advertise features.session_approval_control === true under the same authenticated profile path. This implementation requires an explicitly named profile; profile-less default targets fail closed. No live backend endpoint or approval core was available in this isolated checkout; the inspected contract is actual CollectiveUI source plus the supplied extension contract, not a claimed live API validation.

## Security design

- resolveCommandTarget rechecks conversation ownership and bot access/effective enabled app per request. Admin status does not grant access to another user's conversation. /yolo additionally requires the bot owner or an admin in their own direct chat. Shared bot audience access alone is insufficient.
- Reject non-bot, group, routine, local and Docker/native transports. Native workspace transport remains untouched. Bare command only reads status; malformed arguments do not call the remote endpoint.
- Derive exact session identity server-side. Validate remote session_id and profile equality, boolean enabled, and scope exactly "session" on the initial GET, PUT response and fresh GET readback. A successful PUT alone is never success. Missing/nonboolean capability, bad identity, unreadable responses, failed readback or noncommitting PUT fail closed; no local fallback.
- Client reuses authenticated HTTPS/private-network URL resolution, redirect:error, cache:no-store, timeouts and bounded discovery GET parsing. No config.set, global/profile approval mode or approvals.mode calls are introduced.
- Controls reject stale app endpoint/profile/credential target fingerprints found in chat settings or run contexts. Managed contexts pin recorded provision ID; multiple provision bindings are rejected. hermesTargetFor performs its existing scope/transport verification.
- Mutations hold lockUserRuns, ensure the conversation exists and still matches its owner/bot, and call assertHermesIdle before HTTP mutation. Existing open-run and unconfirmed cancellation gates are reused. The backend must atomically reject mutation while any run is active, including non-portal runs, and serialize mutation with backend admission.
- For first-run controls, persist the existing chat connection fingerprint (model null, revision 0), not approval state. The fingerprint and conversation commit even when backend control verification fails, preserving the binding when a PUT may have committed but readback was lost. /model defaults and backend settings are not modified by the feature. Existing model-setting commands retain their existing behavior.
- Backend owns persistent bypass and restart survival. Fresh chats use different IDs and do not copy mode. Client isolation regression exercises separate sessions and client recreation against a stateful synthetic HTTP backend; this is not proof of actual Hermes disk persistence.
- YOLO skips approval prompts only. Tool permissions, sandbox restrictions, network policy, profile memory boundaries and credentials are unchanged. Failure does not automatically turn an already-enabled remote session OFF; the UI reports unverified and asks for a fresh status check.

## TDD evidence and exact verification

Before implementation:

1. npm test -- --project unit tests/unit/hermes-session-approval.test.ts --maxWorkers=1
   Exit 1: 14 failing tests, missing sessionApprovalMode implementation.
2. npm test -- --project unit tests/unit/hermes-yolo-command.test.ts --maxWorkers=1
   Exit 1: 9 failed / 6 passed; commands rejected as unsupported, catalog had no verified YOLO state, missing owner/idle/binding behavior.
3. npm test -- --project unit tests/unit/hermes-yolo-status.test.ts --maxWorkers=1
   Exit 1: missing status component (suite import failure).

Final focused verification:

npm test -- --project unit tests/unit/hermes-session-approval.test.ts tests/unit/hermes-yolo-command.test.ts tests/unit/hermes-yolo-status.test.ts tests/unit/hermes-commands.test.ts tests/unit/hermes-command-route.test.ts tests/unit/hermes-provider.test.ts tests/unit/hermes-settings.test.ts tests/unit/remote-hermes-yolo.test.ts tests/unit/remote-hermes-yolo-route.test.ts --maxWorkers=1
Exit 0: 9 files, 148 tests passed. Includes the unchanged native workspace YOLO tests to guard transport separation.

npm run typecheck
Exit 0: next typegen succeeded; tsc --noEmit succeeded.

npm run lint
Exit 0: zero errors, one warning in untouched tests/browser/workspace-browser.mjs:59 ('chunk' unused).

git diff --check
Exit 0.

An earlier verification caught fixture TS2352 and effect synchronous setState lint errors; both were corrected before final successful checks. Per-file tool syntax checks invoke TypeScript without project configuration and reported alias/dependency errors; the authoritative project typecheck above passes.

## Changed files

- src/lib/llm/providers/hermes/client.ts: capability-gated verified remote session approval client.
- src/lib/llm/providers/hermes/scope.ts and src/lib/llm/resolve.ts: common normal Runs session identity helper.
- src/lib/chat/hermes-command-service.ts: authorization, idle serialization, target binding, commands and verified catalog status.
- src/lib/chat/hermes-commands.ts: vocabulary and credential-free catalog status type.
- src/components/chat/session-yolo-status.tsx and src/components/chat/chat.tsx: persistent visible state and refresh behavior.
- tests/unit/hermes-session-approval.test.ts: HTTP contract, readback, capability, identity, isolation and failures.
- tests/unit/hermes-yolo-command.test.ts: service regressions with isolated database/target mocks, ownership/admin, native exclusion, idle ordering and provision binding.
- tests/unit/hermes-yolo-status.test.ts: actual React server rendering of verified/unverified status.
- docs/connections.md: usage and security constraints.
- .hermes/plans/yolo-contract.md and this report: coordinator handoff artifacts.

## Remaining validation / next action

No live Hermes test, real PostgreSQL concurrency test, browser interaction test, full unit suite or production build was run. Service regressions use mocked query/admission dependencies; the existing focused provider and native workspace suites pass. The feature is client/service-tested against the agreed protocol but cannot prove backend approval enforcement, disk persistence or idle admission atomicity until the coordinator's isolated backend extension is exercised.

Parent should independent-review, then verify authenticated actual capabilities and GET/PUT before first run, restart persistence, ON bypass / OFF approval in approval core, wrong-profile rejection, active-run 409 and two-session isolation against that extension before cutover. No production change is requested or performed here. Obtain the resulting commit ID with git log -1 on the delivery branch; this report is included in that commit.

## Security follow-up: preserve the pre-first-run connection pin

Follow-up to 4242c9434ce7c2a0a25997227be005782bb97963 on architect/yolo-diagnostics-20261009, implemented by The Architect in /workspace.

Coordinator identified that setModel's existing onConflictDoUpdate could overwrite hermesChatSettings.targetKey after connection retargeting, erasing the first-run YOLO pin. The only production-code change is a mismatch guard in setModel, inside the existing user-run lock and after conversation/idle checks. Existing settings with a different targetKey now reject HTTP 409 asking for a fresh chat, before idempotency, revision checks or settings writes. Both /model default and allowed model selections use this guard. Same-target absolute selections remain idempotent; normal changes and stale-revision protection are preserved. This supersedes the original security-design statement above that model-setting commands retain all existing behavior.

Fixture changes are confined to tests/unit/hermes-yolo-command.test.ts: mutable hermesSettings, persistence of first-run settings inserts, the minimal onConflictDoUpdate/returning mock, and one advertised/admin-allowed model. Two retarget regressions first create a real service-level /yolo on pin with no run contexts, change the configured profile, then assert 409 with fresh-chat guidance, no settings update, unchanged binding and rejection of subsequent /yolo without remote approval access. A third regression covers same-target default/allowed-model changes, stale-revision rejection and idempotent retries.

Exact TDD and verification evidence:

1. Before the guard: npm test -- --project unit tests/unit/hermes-yolo-command.test.ts --maxWorkers=1
   Exit 1: 2 failed, 18 passed (20 tests). Both retarget cases incorrectly resolved with "Model request saved", revision 1, instead of rejecting.
2. After the guard: npm test -- --project unit tests/unit/hermes-session-approval.test.ts tests/unit/hermes-yolo-command.test.ts tests/unit/hermes-yolo-status.test.ts tests/unit/hermes-commands.test.ts tests/unit/hermes-command-route.test.ts tests/unit/hermes-provider.test.ts tests/unit/hermes-settings.test.ts tests/unit/remote-hermes-yolo.test.ts tests/unit/remote-hermes-yolo-route.test.ts --maxWorkers=1
   Exit 0: 9 files, 151 tests passed.
3. npm run typecheck
   Exit 0: next typegen and tsc --noEmit succeeded.
4. npm run lint -- src/lib/chat/hermes-command-service.ts tests/unit/hermes-yolo-command.test.ts
   Exit 0: no warnings or errors. Full lint was not rerun; the preceding feature commit's full-lint evidence remains above.
5. git diff --check
   Exit 0, including the follow-up report update.

The patch tool's standalone TypeScript checks again reported missing project alias/module-resolution and dependency errors; the authoritative project typecheck above passed. No full unit suite, production build, browser test or real PostgreSQL concurrency test was run for this narrow follow-up.

Operator reports the backend extension is now implemented in isolation and 212 actual HTTP/core tests passed. That is coordinator-supplied evidence, not execution independently performed in this checkout. Parent retains review and cutover ownership. No migration, configuration, network, boundary, production, push or cutover changes were made. Follow-up changes are limited to the service, its existing YOLO command test fixture/regressions and this report.
