# Native asynchronous delegated tasks

The existing `ask_*` tools accept `{ task, mode: "sync" | "async" }` in durable native turns. The default remains `sync`: ask a specialist and wait within the current turn. `async` creates a durable assignment, then suspends the assigning reply until its accepted assignments finish. The receiver's linked task conversation shows its assignment, live work, result and status in receiver activity/history. Its canonical home and `/new` behavior remain unchanged.

While the parent waits, its header says **Waiting for delegated tasks…** and Stop cancels the parent and descendants. The parent keeps its conversation slot but releases its worker slot, so other chats and tasks can run. The receiver has its own queue and worker slots (`TASK_RUN_CONCURRENCY`, default 4). Closing either page does not cancel work. The saved result returns to the original assistant message; its next segment continues automatically. Each finished async task also creates one local Inbox item. Browser status comes from authorized run/task state, not a simulated activity timer.

Task conversations remain read-only execution records. Start a side chat for follow-up, or ask for another attempt in a new human message in the originating chat. Interrupted/failed tasks do not restart automatically. Actions already dispatched may have run; retrying a request may repeat their effects.

## Lifecycle and recovery

1. Admission under the human's run lock records a queued `async_delegate` run and a task unique to owner, assistant message and tool-call ID. Repeated admission with the same input attaches to the same task; changed input conflicts. A second call ID with the same async assignment in the same root turn is rejected.
2. The parent saves its assistant message. A fenced transaction verifies the exact accepted task IDs and tool outputs, records the native checkpoint, appends the segment end, and changes the run to `waiting_tasks`. A child cannot claim before this checkpoint commits.
3. The child claims once, with root concurrency enforced under the same user lock. It runs in the receiving bot's separate conversation and usage scope. Queued jobs may be delivered again; duplicate claims cannot execute the run twice. Queue transport has zero execution retries.
4. After all children finish, one transaction revalidates authority, appends the final tool results and receipts, updates the parent transcript, advances its segment, and queues its continuation. Result receipt, transcript and continuation state commit together. No completed tool is rerun to rebuild context. If the same model step also requested human approval, the results commit first and the parent stays paused for that approval.
5. Recovery dispatches admitted, checkpointed queued work after lost queue delivery, rotates bounded parent batches to avoid starvation, and repairs missed result notifications. A stale running lease becomes interrupted, with any saved partial transcript; it is never resumed as a new attempt. Stop, deadline expiry and parent failure cancel descendants. Late completion cannot overwrite a committed cancellation.

Async children can themselves suspend for nested async work. Synchronous inline children cannot start async work because they do not own a resumable worker segment. Group turns retain synchronous delegation; group `@mentions` are still group handoffs. This implementation adds no Hermes async execution or provider-native subagent mapping.

## Authority, budgets and unattended execution

The requesting human owns the task and supplies its identity, permissions and credentials. The bot owner's account is never substituted. Admission, dispatch, each model step, each tool invocation and undelivered result all recheck task lineage, user/session, bots, connections and each edge’s current manual or coordinator policy. Captured model/tool authority is compared with current bot, app, principal/groups, tool configuration, remembered grants and workspace policy before effects. A revoked or changed configuration fails closed. Already dispatched effects cannot be recalled.

Finished transcripts remain the owner's history after execution access ends. Terminal replay rechecks the current account/session and owned task, but does not grant new execution or result-delivery authority. Live streams retain execution checks. Snapshot messages, active run and task state come from one database snapshot; the browser retries failed attachments and synchronizes the terminal saved transcript. A completed child keeps checking its delivery receipt while its parent remains active, then shows the committed return or undelivered outcome.

Async children are always unattended. Automatic routine continuations retain unattended billing restrictions, queue routing and instructions across task waits. Only an explicit human approval response makes a routine continuation interactive. Service bots and managed Hermes remain direct-only; all async paths require native engines. Normal manually linked synchronous Hermes behavior is unchanged.

Limits are depth 2, eight admitted tasks per root assistant reply, four running tasks per root, and sixteen open async tasks per human. The root deadline is shared with descendants. Each native run persists its used model steps and maximum across continuations, so suspension does not reset its step allowance. These are bounded execution limits, not a monetary spending cap. Child prompts are self-contained; no automatic receiver home history, selected memories, user instructions or memory extraction is added. Explicitly configured memory tools keep the human's existing scope.

## Data and migration ordering

The migration chain preserves published `0018_default_coordinator` (journal index 18, timestamp `1790985940212`) byte-for-byte, then adds regenerated `0019_delegated_tasks` (`1790987052400`) and `0020_native_async_tasks` (`1790987073715`). Their snapshots descend from the published coordinator snapshot. Async adds `waiting_tasks`, `async_delegate`, the corresponding database checks/indexes, and task `mode`, `parent_segment`, `notified_at`. Existing tasks default to synchronous mode. No historical chat is moved and no historical delegation is replayed.

Apply the complete chain with the matching web and worker code. Fresh installs and upgrades from main0017 and deployed coordinator0018 are tested, including replay, identity/home/history, grants, preferences and pets. The old standalone task migration numbering is superseded; those unpublished branches must not be deployed on this chain. Drizzle uses an applied-migration high-water mark, so migration order, timestamps and snapshot ancestry must remain consistent.

## Coordinator authorization

Both configured manual links and eligible automatic coordinator specialists use the durable task lifecycle. Discovery returns a server-selected authorization mode, which sync and async admission persist in the ancestry and idempotency binding. Task `mode` separately identifies sync or async execution. The database admission count remains authoritative across continuation segments.

`src/lib/delegation/source.ts` defines `DelegationEdge = { from, to, mode?: "manual" | "coordinator" }` (missing mode is legacy manual) and exports:

```ts
resolveTaskSource(task, q = db): Promise<DelegationSource>
resolveAdmissionSource(ctx, parentTask, toolCallId, inputHash, q = db): Promise<DelegationSource>
```

The source is resolved server-side from the persisted root task, never from a model-supplied conversation override. It binds human ID/session version, root task, original conversation/run, assigning bot, assistant message, tool-call ID and input hash, with fresh source conversation/run rows. Nested tasks must match the stored root's first edge and session. This separate source object does not change the child's own conversation, identity, `background` flag or billing policy.

`targets.ts` bridges durable admission and execution to `assertPersistedDelegationEdge` in the coordinator policy. `assertDelegationPath` binds child context to its stored task, then rechecks the complete lineage. A coordinator edge is allowed only as the first edge from the currently selected coordinator in the human's original direct chat; nested edges require manual links. Each check revalidates current default selection, opt-in, bot/model audience and native eligibility, and rejects archived/group/routine/non-human origins. Service bots and managed Hermes remain direct-only; automatic paths exclude all Hermes engines.

Shared MCP authorization uses this same persisted path policy plus existing connector authority. The child's conversation, identity and unattended flag are preserved. All queries inside authorization transactions use the supplied `DbOrTx`, including settings and service publication checks, so validation works with a one-connection pool. No child context is relabeled as the parent home or foreground work.

## Verification

Synthetic transports and disposable loopback databases only:

- `tests/integration/async-delegation.test.ts`: `collective_coordinator_async_test`; real worker execution with a local model, nested waits, exactly-once receipts/continuations, concurrency limits, queue/checkpoint gating, Stop races, stale-worker interruption, mixed approval, deadline/step budgets, revocation and bounded recovery; coordinator-to-manual nesting, current-source checks, MCP authorization without network calls, result-time revocation, and service conversion. Repeat with `DATABASE_POOL_MAX=1`.
- `tests/integration/async-migration.test.ts`: `ASYNC_MIGRATION_TEST=1`, `collective_async_upgrade_test`; fresh and foundation0019 upgrades plus migration replay and database constraints.
- Existing delegation and run executor/web regressions verify synchronous and approval behavior.
- `tests/async-delegation.playwright.config.ts`: `ASYNC_BROWSER=1`, `collective_coordinator_async_browser_test`, production app on 3068, local mock on 4068, one chat worker slot and one task worker slot. Uses automatic coordinator discovery without a manual source link, plus a queued manual assignment. Covers closing the origin, failed reconnect, parent continuation, Stop, saved terminal history, queued attachment, canonical-home preservation and mobile overflow.

Run typecheck, lint, unit tests and production build. No remote publication is implied by these local checks.
