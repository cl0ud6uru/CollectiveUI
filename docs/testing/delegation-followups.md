# Related delegated task turns

A native specialist's `ask_*` tool starts a new task conversation. Its `continue_*` tool accepts an exact prior `taskId` plus the related follow-up instruction. The conversation is reused only after checking the human owner, originating chat, source and receiving bots, ancestry, original root source, target connection, and current access. The coordinator is instructed to use continuation only for the same piece of work. There is no implicit grouping by target bot.

Each accepted follow-up receives a new immutable delegated-task record, run, assistant message, deadline, parent lineage, receipt and notification. The historical ID selects context; it does not confer execution authority. Duplicate provider calls attach to their existing invocation. Identical instructions in one root turn cannot bypass admission protection by choosing another historical ID from the same child conversation.

Migration `0022_related_delegation_turns` adds ordered turns and the continuation reference. Existing assignments become turn 1. Queued native delegates may share a conversation, while a partial unique index still permits only one executing/suspended turn. Claims are FIFO, including nested suspension and resumed segments, and require the committed parent checkpoint. The first claim binds context to finished predecessors; it does not advance the active transcript at admission. Cancelled requests without a model response receive an explicit saved terminal outcome in subsequent context. Missing history fails the new turn and returns that failure through reconciliation.

Recent shows one entry per child conversation: the executing turn, then the earliest queued turn, otherwise the newest terminal turn. A later cancellation cannot hide earlier active work. The task page displays the queue count, pins stream access to an exact run, continues checking for new work after completion, and only acknowledges the saved terminal snapshot actually rendered. Admission and read acknowledgment use the same user lock. Old completions cannot acknowledge a newer follow-up. Stop in the child ends all pending turns in that conversation; stopping a parent retains the existing invocation/descendant cancellation scope.

Continuation is offered only in durable native contexts. Existing group and Hermes behavior is unchanged; this does not provide Hermes continuation parity. Model choice of related versus unrelated work is guided by the tool descriptions and coordinator instructions, not a server-side similarity guess.

## Verification

All runtime checks use disposable loopback PostgreSQL databases, synthetic local accounts, and `dev/mock-llm`. No external model, user account data, live connector, deployment, or merge is required.

- `npm test`: 662 passed, 389 normally gated/skipped tests; 71 passed files.
- `npm run typecheck`, `npm run lint`, `npm run build`.
- Full general integration suite: 216 passed, 70 normally gated/skipped tests. Database-restricted suites ran separately against their required named databases: native async 31, coordinator 10, service-bot 22 and default-start 11 passed.
- `tests/integration/delegation-followups.test.ts`: 9 passed, covering completed resume, full model history, concurrent admission, duplicate IDs/instructions, FIFO, nested suspension and nested continuation, exact-run access, stale reads/results, unrelated new work, unauthorized IDs and access revocation, cancellation, missing history recovery, native-only scope. Final related regression run: 38 passed across four suites.
- `tests/integration/delegation-followups-migration.test.ts`: 2 passed, covering fresh and 0021 upgrades, replay twice, historical receipts, queued turns, execution uniqueness and regular-chat exclusivity.
- `tests/e2e/delegation-followups.spec.ts`: 4 passed, covering real browser/worker/model flow through completed resume, mounted-view refresh, busy queue, separate unrelated work, unauthorized IDs, read markers, cancellation, failure and explicit recovery.

To run the new integration tests, migrate a disposable database first and set `DATABASE_URL` before invoking `npx vitest run tests/integration/delegation-followups.test.ts`. Migration tests require the loopback database `collective_followups_upgrade_test` and `FOLLOWUP_MIGRATION_TEST=1`; that suite recreates only its explicitly named test schema.

For browser tests, migrate the loopback database `collective_followups_browser_test`. Run the mock on port 4069, the web app on `http://localhost:3069`, and the worker with the same database and synthetic encryption key. Set `AUTH_URL=http://localhost:3069`, `AUTH_LOCAL_ENABLED=true`, `AUTH_TRUST_HOST=true`, a synthetic `AUTH_SECRET`, and `FOLLOWUP_BROWSER=1`. Invoke `npx playwright test --config=tests/delegation-followups.playwright.config.ts`. `PLAYWRIGHT_CHROMIUM_PATH` can select an installed Chromium. `FOLLOWUP_SCREENSHOTS` can override the default screenshot directory `/tmp/collective-followups-screenshots`. The fixture creates only synthetic users and uses deterministic tool markers, including parallel tool calls and a model-visible history probe.

## Browser evidence

The screenshots below are generated from the synthetic local fixture.

The original code always allocated a new child conversation during admission and exposed no continuation tool. Local tests reproduce that behavior for new assignments and verify the explicit continuation path reuses the conversation.

- [Follow-up working with one Recent entry](evidence/related-delegation/followup-working-one-recent.png)
- [Completed follow-up retaining the original context](evidence/related-delegation/followup-context-completed.png)
- [Busy task with a queued follow-up](evidence/related-delegation/followup-busy-queue.png)
- [Unrelated work in a separate task](evidence/related-delegation/unrelated-separate-task.png)
- [Stopped follow-ups](evidence/related-delegation/followup-stopped.png)
- [Failed follow-up](evidence/related-delegation/followup-failed.png)
