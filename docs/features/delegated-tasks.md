# Linked delegated tasks

When a bot calls an `ask_*` delegation tool, the receiving bot gets a separate, private task conversation. Its history contains the assignment, attributed to the assigning bot, and the receiver's streamed work and saved response. The parent tool card links to that task; the task links back to the originating chat. Receiver activity and history include the task, and the sidebar refreshes current work every ten seconds while visible, on focus, and when a delegation card changes state.

Selecting a bot still opens its canonical home. `/new` still starts a fresh direct chat. Task conversations are read-only execution records: they cannot send, regenerate, change branches, answer approvals, invoke slash controls, or be shared/copied as an executable conversation. Stop cancels the task and its descendants. A separate side chat is the explicit follow-up action. Presentation controls (rename, pin, folder, archive) and owner deletion remain available. Sharing an originating chat includes its existing textual answer but strips private task links.

## Execution and authority

Tasks are attached to the assigning execution. Direct-chat parents run in the existing worker, and their child tasks continue if the browser disconnects. Group turns run in the request, so their children follow the request's cancellation. Ordinary group `@mentions` remain visible handoffs in the group transcript; only actual delegation tool calls create linked tasks. Hermes-native subagent events do not create portal bot assignments.

Synchronous child runs use `execution_mode = inline_delegate`. They start running atomically with admission and cannot enter a queue, pause for approval, or resume. If an executor disappears, the existing stale-run sweeper saves any partial event-log transcript and marks the task interrupted. It never restarts that task. Another attempt requires an explicit new request in the originating chat and a new tool invocation. Native durable turns can also select [asynchronous execution](native-async-tasks.md), which persists a queued child and suspends its parent without occupying a worker slot.

The human owns both conversations. Each admission rechecks the account/session, both bots, manual links or current coordinator eligibility, and enabled connections. Each model step, portal tool invocation, live stream batch, and unreturned final result rechecks that lineage. Service bots and managed Hermes profiles remain direct-only. Synchronous children inherit the parent's billing/background policy; async children are unattended. Children never inherit routine-run completion hooks. Manual Hermes gets a separate session and a recorded connection context. Native child prompts remain self-contained: no automatic home history, user instructions, selected memories, or memory extraction; explicitly configured memory tools keep their existing human-owned scope.

One root turn can admit at most eight tasks, with at most four simultaneously running; depth is capped at two and ancestor/self loops are rejected. Children share the root deadline. Admission is serialized by the human's run lock and unique on owner, originating assistant message, and scoped tool call ID. A repeat attaches to the existing task; changed input conflicts. Group speakers namespace provider call IDs so separate speakers cannot collide. Deleted task records retain an admission tombstone until the human is deleted.

## Persistence and delivery

`delegated_tasks` links the owner, source message/call, parent run/task, root, assigning/receiving bots, child conversation/run, input hash, ancestry, deadline and result receipt. Bot names are historical snapshots. Deleted conversations/runs clear their links without erasing another conversation's saved history. Completed history remains readable by its owner after bot access is revoked; current execution and live output require fresh access.

A child's completion is distinct from returning its result. A parent result receipt is committed with the terminal parent tool event, or with the saved group assistant message. Duplicate final events are dropped. Both event and transcript persistence validate undelivered results, including when a child was deleted or access changed after generation. Stop/finalization propagates to descendants, and late child completion cannot overwrite cancellation. Cancellation cannot undo tool actions already dispatched.

Tool-call audit identities are scoped to the assistant message and provider call ID. Child usage belongs to the child run, conversation and receiving bot, so parent usage is not counted again. Legacy audit IDs and approval updates are preserved by migration backfill.

## Rollout and verification

Apply migration `0019_delegated_tasks` after published `0018_default_coordinator` with the new web and worker code. It adds the task table, inline execution-mode checks and scoped audit fields/index, and backfills the existing audit IDs. It does not convert old invisible delegations into tasks because their child transcripts were never saved.

Validation covers fresh, main0017 and coordinator0018 upgrades (including repeated migration and existing approval audit identity), real Postgres plus the local mock model, duplicate admissions/results, owner isolation, revocation/deletion during result dispatch, parent cancellation, partial orphan recovery, task queue/approval/send guards, actual parent-to-child execution, and activity/history. Service-bot and managed-Hermes regressions use synthetic transports only. Browser coverage exercises the origin/task links, receiver activity, read-only task display, reload, Stop and preserved home identity at desktop and mobile sizes.
