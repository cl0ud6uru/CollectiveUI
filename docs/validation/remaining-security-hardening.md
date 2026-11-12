# Retained Team history, migration locking and signed webhook replay protection

## Verified findings and changes

- Deleting a conversation with a native Team context or learning-child receipt cascades into `agent_runs`, where retained Team records prohibit deletion. The old action stopped runs before the eventual foreign-key error. Single and bulk deletion now preflight those references before stopping work and recheck inside the deletion transaction. Known Team foreign-key failures from a concurrent context insertion become an actionable 409. Native retirement deliberately retains these records; archive remains the supported operation. A concurrent first context can still arrive after preflight, so the final foreign key preserves history, but provider-stop side effects are not claimed to be atomic with that race.
- Web callers receive a serializable expected-error result, preserving the archive guidance in production Server Actions. Sidebar deletion waits for success before hiding the chat. Settings and bot home navigation show the same guidance. The shared mobile route returns 409 and its existing archive PATCH remains available. iOS `AppModel.archive`/sidebar and macOS `DesktopSidebarView` expose archive; no native UI contract changed. Native app binaries were not run.
- Migration journal inspection and application previously ran without a deployment-wide fence. The runner now holds a PostgreSQL session advisory lock across Drizzle's journal inspection, migration transaction and bundled-pet bootstrap, all on one checked-out client. Bootstrap accepts that same client, including with pool size one. Unlock and pool cleanup run on failures; an unlock failure discards the session.
- Body-only webhook HMAC had no authenticated age or delivery identity. Signed requests now authenticate `timestamp.deliveryId.rawBody`, accept a five-minute clock window, and atomically record delivery ID and payload hash with the admitted run. Simultaneous retries return one durable run ID without enqueuing again; a changed payload for the same delivery ID returns 409. Existing receipts can be retrieved with a fresh valid signature after pause or capacity exhaustion. Conversation deletion preserves receipts. There is no routine-run pruning path; routine deletion removes both the receipts and the webhook secret.

## Compatibility requirement

Existing HMAC senders must add the two headers and change their signature input before this version is deployed. Legacy body-only signatures return 401. The exact client example is in [operations](../operations.md#routines-via-webhook). Bearer-only callers keep their existing behavior, including no replay or retry-deduplication guarantee. No production deployment was performed.

## Validation

- `npm run typecheck` passed.
- `npm run lint` passed with zero errors and eight existing warnings.
- Real PostgreSQL 16/pgvector disposable database: migration and bundled-pet bootstrap passed with `DATABASE_POOL_MAX=1`.
- `REMAINING_SECURITY_TEST=1 ... npx vitest run --project integration tests/integration/remaining-security.test.ts --maxWorkers=1`: all eight tests passed with both the default pool and pool size one. They exercise concurrent signed HTTP handlers, persisted retry behavior, changed-payload rejection, bearer compatibility, database uniqueness, conversation receipt retention, the production deletion actions/mobile handlers, archive, and learning-child references.
- The migration test holds the first bootstrap open and observes the second session waiting on a PostgreSQL advisory lock before releasing it. Both runners then succeed with exactly one journal entry. Separate migration and bootstrap failure cases prove another session can acquire the released lock. Each runner uses a one-connection pool.
- Focused unit suite: 32 tests passed across `routine-webhook`, `conversation-delete-policy`, `hermes-team-store`, and `event-trigger-migration`.
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium node tests/browser/responsive-sidebar-focus.mjs` passed, including denied deletion feedback remaining visible and the retained chat staying in the sidebar. The browser fixture uses production components and synthetic action responses; action results and native HTTP status are exercised separately against PostgreSQL.
- `git diff --check` passed; the new GitHub Actions workflow parses as YAML and configures the pool size as a string. It runs the eight PostgreSQL regressions on each PR and main push.

The independent Next.js 16.4.6 patch and its vendor advisory evidence are documented in [next-16.4.6-security.md](next-16.4.6-security.md).
