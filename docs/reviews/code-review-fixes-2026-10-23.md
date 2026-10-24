# Code review repairs — 2026-10-23

Repairs for seven findings from the 2026-10-23 review, based on `75209d458384aa945927fe985858756a3caa6f0e`.

## Changes and platform parity

| Finding | Implemented behavior | Web / iOS / macOS parity |
| --- | --- | --- |
| 1. Unconfirmed Stop | Web keeps the stream attached while cancellation is pending or unconfirmed, verifies the persisted run, and offers Retry stop after failure. Stop-and-send preserves the complete draft and submits only after confirmation. | Matches the existing shared native ChatModel recovery contract, which is exercised by the native chat tests. Direct chats use durable cancellation. Group chats retain their existing request-owned cancellation behavior. |
| 2. Delayed sign-out | AppModel captures the old API client and immediately clears local credentials, drafts, and authenticated state. Remote activity cleanup and session revocation run concurrently using that captured client. Late responses cannot invalidate a replacement login. | AppModel is shared by iOS and macOS. Only iOS has Live Activities; macOS retains immediate local sign-out and remote revocation. Web has no Live Activity cleanup dependency. |
| 3. Lost rejected attachments | Web restores text, uploaded files, quote metadata, and mention information after an admission rejection. Newer text and files already being composed survive recovery. One Composer remains mounted across empty/transcript layout changes. | Matches native rejected-submission recovery. Existing shared native draft/session tests remain passing. |
| 4. Wrong artifact workspace | The shared native parser carries a validated instance ID through the iOS download button to the API query. Missing IDs retain legacy behavior; malformed IDs are rejected. | Web already carries instance IDs. CollectiveKit serves both native platforms. macOS artifact download UI remains an existing, documented capability gap. |
| 5. Invalid copied replies | Shared-conversation copies remap quotes to preceding copied messages, recalculate shifted group-speaker indexes, remove invalid references, and strip replay keys. | The server supplies corrected metadata through the same conversation snapshot API used by web, iOS, and macOS. |
| 6. Lost routine Inbox notices | Routine state and an idempotent Inbox receipt commit in one transaction. Recovery repairs lost hooks, including approval transitions; stale segments cannot overwrite newer outcomes. | All clients consuming routine state or Inbox data use the same server contract. Existing platform navigation capabilities are unchanged. |
| 7. Cross-session image cache | Authenticated attachment images use a session-generation, server, and resource cache key. Display state resets on scope changes; late responses from obsolete clients cannot replace or cache pixels. | This renderer is iOS-only. It follows the session-scoping approach already used by native bot artwork. macOS does not use this UIKit cache; web uses its existing authorized image path. |

## Regression coverage

- `tests/e2e/chat-recovery.spec.ts` renders the real Chat and Composer against a local synthetic server. It covers Stop failure, retry, pending cancellation, Stop-and-send, run-admission races, approval continuation, file-only rejection, text-plus-file rejection, and preserving a newer draft with an upload in flight. It makes no provider requests. The suite is included in the existing browser CI job.
- `ios/CollectiveUITests/AuthenticationTests.swift` stalls Live Activity deletion with activities enabled and disabled, verifies immediate local cleanup and independent revocation, then verifies that a late unauthorized response cannot erase a new login.
- `ios/CollectiveKit/Tests/CollectiveKitTests/WorkspaceArtifactTests.swift` inspects actual API requests for identical filenames in different instances, legacy downloads, and malformed instance selectors.
- `tests/unit/shared-conversation-replies.test.ts` uses a migrated disposable PGlite database and production share-copy/chat/snapshot handlers. It verifies successful editing after copying, no reference to the original chat, repeated group speakers, and removal of self/future/sibling/malformed references.
- `tests/unit/routine-notifications.test.ts` uses the production hooks and reconciler with a migrated disposable PGlite database. It injects failures at both writes, retries recovery, checks receipt deduplication and distinct approval phases, rejects stale hooks, preserves recovered message summaries, and covers deleted/missing conversations and terminal errors.
- `tests/integration/routine-notifications-postgres.test.ts` adds four real PostgreSQL overlap cases for user/conversation/routine deletion and missing-agent recovery. These are wired into the existing PostgreSQL CI job with pool sizes 1 and 4. Parent rows are protected before acquiring agent locks to avoid cascade-deletion deadlocks while permitting continuation updates.
- `ios/CollectiveUITests/AuthenticatedImageTests.swift` runs the actual image loader with synthetic HTTP responses. It covers server/account changes with identical relative paths, late responses after login replacement, and logout while a response is outstanding.

## Validation

| Check | Result |
| --- | --- |
| Portable JavaScript unit suite | 245 files passed, 1 skipped; 2,618 tests passed, 1 skipped |
| Final routine notification, hook, and executor tests after lock-order correction | 47 tests passed |
| New browser recovery regressions | 17 tests passed |
| Existing message-interaction and group-activity browser suites | 14 tests passed |
| TypeScript typecheck | Passed |
| ESLint on tracked source and the new source/test files | Passed: 0 errors, 8 existing warnings |
| CollectiveKit | 93 tests passed |
| Shared native headless chat/session suite | 91 tests passed |
| Hosted iOS authentication and image tests | 16 tests passed |
| Native parity contracts | 8 tests passed |
| macOS project guardrails | Passed |
| Full macOS Debug build | Passed |
| Full iOS Simulator Debug build and targeted hosted tests | Passed |

The portable unit command was:

```sh
npx vitest run --project unit --maxWorkers=2 \
  --exclude '**/docker-hermes*' --exclude '**/hermes-team*' \
  --exclude '**/personal-codex*' --exclude '**/private-socket*' \
  --exclude '**/remote-hermes*' --exclude '**/agent-browser*' \
  --exclude '**/local-hermes*' --exclude '**/computer-control*'
```

These exclusions cover the Docker/Linux/runtime-dependent suites. Docker was unavailable locally, so this is not a full-suite result. No live provider, user account, or existing application database was used. Native builds used Xcode 27.0 with signing disabled; the iOS tests used the separate QA bundle.

The four real PostgreSQL overlap tests were imported successfully with opt-in disabled and skipped locally because PostgreSQL/Docker was unavailable. Their execution remains for CI; PGlite validates transaction rollback and receipt semantics but does not validate concurrent PostgreSQL row-lock behavior.

Optional routine email remains best-effort. Only the transaction that creates the Inbox receipt attempts email, preventing duplicate attempts on hook recovery; durable email delivery and retry history remain a separate feature. The fix does not backfill historical terminal routine runs that lost notifications before this change.

Local evidence logs are under `/tmp/collective-fixes-*.log`, with the final browser run at `/tmp/collective-chat-recovery-final.log` and final typecheck at `/tmp/collective-web-final-typecheck.log`. These temporary paths may be cleaned by the operating system; the changes and regression tests are retained in the repository.
