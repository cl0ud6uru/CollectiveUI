import { HERMES_BOT_ONLY_MESSAGE } from "@/lib/llm/model-policy";
/**
 * The web side of durable runs: starting a turn, answering its approvals, stopping it, and picking the run a reload
 * resumes. Every status change goes through ./state.ts; these functions only compose them into the web's
 * transactions (user message + run, decisions + requeue) and enqueue the worker job after commit.
 */
import type { UIMessageChunk } from "ai";
import { and, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { agentRuns, conversations, delegatedTasks, hermesRunContexts, messages, routineRuns, type AiApp, type Bot, type Conversation } from "@/db/schema";
import { applyApprovalDecisions } from "@/lib/agent/approval-merge";
import type { Principal } from "@/lib/auth/groups";
import { getAccessibleModel, HttpError } from "@/lib/authz";
import { insertMessage, rowToUIMessage, setCurrentLeaf, updateMessageParts, updatePartsLockedTx, type MessageMeta, type PortalUIMessage } from "@/lib/chat/store";
import { newId } from "@/lib/ids";
import { enqueueRun } from "@/lib/jobs";
import { afterRunTransition } from "./hooks";
import { lockUserRuns } from "./lock";
import { snapshotHermesSettings } from "./hermes-context";
import { notifyRun, readRunState, type RunState } from "./log";
import { stopProviderRun } from "./provider-stop";
import { closeOpenParts } from "./replay";
import { activeRunOf, finalizeRunTx, insertRunTx, requestCancelTx, requeueRunTx, RunBusyError } from "./state";
import { HOLDING_STATUSES, FINAL_STATUSES, isActive, runConfig, type AgentRun, type ResumeState } from "./types";
import { isManagedHermes } from "@/lib/hermes-provisioning/config";
import { assertManagedConversation, ensureProfile } from "@/lib/hermes-provisioning/store";

export type Decisions = Map<string, { approved: boolean; reason?: string }>;

export const QUEUE_UNAVAILABLE = "The background worker queue is unavailable. Try again shortly.";
const TOO_MANY_RUNS = "You have several replies in progress. Wait for one to finish.";
const POLL_MS = 200;

/** Interactive runs (queued or running) count against runConfig().runsPerUser; routines' first segments don't. */
async function assertUnderCap(tx: Tx, userId: string, exceptRunId?: string) {
  const conds = [eq(agentRuns.executionMode, "worker"), eq(agentRuns.userId, userId), inArray(agentRuns.status, [...HOLDING_STATUSES]), eq(agentRuns.background, false)];
  if (exceptRunId) conds.push(ne(agentRuns.id, exceptRunId));
  const [{ n }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(agentRuns)
    .where(and(...conds));
  if (n >= runConfig().runsPerUser) throw new HttpError(429, TOO_MANY_RUNS);
}

/** Polls until the run releases its conversation, for at most `ms`. Returns its last state (null: deleted). */
export async function waitForRunEnd(runId: string, ms = runConfig().stopWaitMs): Promise<RunState | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    const state = await readRunState(runId);
    if (!state || (!isActive(state.status) && state.status !== "waiting_tasks") || Date.now() >= deadline) return state;
    await new Promise((r) => setTimeout(r, Math.min(POLL_MS, Math.max(0, deadline - Date.now()))));
  }
}

/** After commit: queue the run's segment. A queue that can't be reached fails the run instead of leaving it queued. */
async function enqueueOrFail(run: AgentRun) {
  try {
    await enqueueRun(run);
  } catch (err) {
    console.error(`[runs] couldn't enqueue run ${run.id}`, err);
    await abortQueuedRun(run.id, { status: "failed", error: QUEUE_UNAVAILABLE }).catch((e) => console.error(`[runs] couldn't fail run ${run.id}`, e));
    throw new HttpError(503, QUEUE_UNAVAILABLE);
  }
}

/**
 * A new turn (a user message, or regenerate with none): waits up to runConfig().stopWaitMs for a run being stopped,
 * then in one transaction: per-user advisory lock, cap check (non-background queued|running > runsPerUser → 429),
 * insert the user message + leaf (when given), insert the run (message id pre-allocated; busy conversation → 409).
 * Enqueues after commit (queue down → run failed, 503).
 */
export async function startRun(i: {
  principal: Principal;
  conversation: Conversation;
  bot: Bot | null;
  app: AiApp;
  userMessage?: PortalUIMessage;
  parentId: string | null;
}): Promise<AgentRun> {
  if (i.conversation.source === "delegation") throw new HttpError(409, "Delegated tasks are read-only. Start a separate chat to follow up.");
  if (i.app.provider === "hermes" && (!i.bot || i.conversation.botId !== i.bot.id)) throw new HttpError(400, HERMES_BOT_ONLY_MESSAGE);
  const userId = i.principal.user.id;
  const conversationId = i.conversation.id;
  let provisionId: string | undefined;
  if (isManagedHermes(i.app)) {
    if (!i.bot) throw new HttpError(400, "Choose a bot to use an automatic Hermes profile.");
    await assertManagedConversation(userId, i.bot.id, conversationId);
    provisionId = (await ensureProfile(userId, i.bot.id, i.app.id)).id;
  }

  const active = await activeRunOf(conversationId);
  if (active) {
    // "Stop and send": the previous reply is being stopped; give it a moment to save its partial and let go.
    if (!active.cancelRequestedAt) throw new RunBusyError();
    const after = await waitForRunEnd(active.id);
    if (after && (isActive(after.status) || after.status === "waiting_tasks")) throw new RunBusyError();
  }

  const run = await db.transaction(async (tx) => {
    await lockUserRuns(tx, userId);
    if (i.conversation.isBotHome) {
      const [current] = await tx.select({ isBotHome: conversations.isBotHome }).from(conversations)
        .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)));
      if (!current?.isBotHome) throw new HttpError(409, "This home chat changed. Select the bot to open its current home before sending.");
    }
    await assertUnderCap(tx, userId);
    const hermes = i.app.provider === "hermes" ? await snapshotHermesSettings(tx, i.app, conversationId) : null;
    if (i.userMessage) {
      await insertMessage(conversationId, i.userMessage, i.parentId, {}, tx);
      await setCurrentLeaf(conversationId, i.userMessage.id, {}, tx);
    } else if (i.parentId) {
      // Regenerate: the new reply replaces the visible one, so the path ends at the question until it's saved (the
      // executor then moves the leaf only while it's still the question or the reply).
      await setCurrentLeaf(conversationId, i.parentId, {}, tx);
    }
    const run = await insertRunTx(tx, {
      userId,
      conversationId,
      messageId: newId(),
      parentMessageId: i.userMessage?.id ?? i.parentId,
      appId: i.app.id,
      botId: i.bot?.id ?? null,
      background: false,
    });
    if (hermes) await tx.insert(hermesRunContexts).values({ runId: run.id, ...hermes, provisionId });
    return run;
  });
  await enqueueOrFail(run);
  return run;
}

type ToolPartView = { type: string; state?: string; approval?: { id?: string; approved?: boolean; reason?: string } };
const isToolPart = (p: ToolPartView) => p.type === "dynamic-tool" || p.type.startsWith("tool-");

/** The decisions that applied (requested → responded), as the chunks that make a replay rebuild them. */
function approvalResponseChunks(before: ToolPartView[], after: ToolPartView[]): UIMessageChunk[] {
  const chunks: UIMessageChunk[] = [];
  after.forEach((p, idx) => {
    const prev = before[idx];
    if (!isToolPart(p) || p.state !== "approval-responded" || prev?.state !== "approval-requested" || !p.approval?.id) return;
    chunks.push({
      type: "tool-approval-response",
      approvalId: p.approval.id,
      approved: p.approval.approved === true,
      ...(p.approval.reason != null ? { reason: p.approval.reason } : {}),
    });
  });
  return chunks;
}

/** The run of an assistant message, row-locked for the rest of the transaction. */
async function lockRunOfMessage(tx: Tx, messageId: string): Promise<AgentRun | null> {
  const [row] = await tx.select().from(agentRuns).where(eq(agentRuns.messageId, messageId)).for("update");
  return row ?? null;
}

/**
 * Approval answers for a waiting run, in one transaction: lock the run by message (create a legacy waiting run for a
 * pre-P6 message), require waiting (409), cap check, lock the message and applyApprovalDecisions (nothing changed →
 * 400), append tool-approval-response chunks, requeueRunTx. A 409 rolls the decisions back. Enqueues after commit.
 */
export async function continueRun(i: { principal: Principal; conversation: Conversation; messageId: string; decisions: Decisions }): Promise<AgentRun> {
  const userId = i.principal.user.id;
  const conv = i.conversation;
  if (conv.source === "delegation") throw new HttpError(409, "Delegated tasks cannot resume or answer approvals.");
  if (!conv.botId && conv.appId) await getAccessibleModel(i.principal, conv.appId);
  const run = await db.transaction(async (tx) => {
    await lockUserRuns(tx, userId);
    let run = await lockRunOfMessage(tx, i.messageId);
    if (run && (run.conversationId !== conv.id || run.userId !== userId)) throw new HttpError(400, "Unknown message");
    if (!run) {
      // An approval that was pending before durable runs: it continues on a run of its own (with nothing to replay).
      const [row] = await tx
        .select()
        .from(messages)
        .where(and(eq(messages.id, i.messageId), eq(messages.conversationId, conv.id)));
      if (!row || row.role !== "assistant") throw new HttpError(400, "Unknown message");
      // Only messages from before durable runs: every later assistant message has a run of its own, so one without a
      // run (e.g. a copy of a shared chat) has nothing to continue.
      const [first] = await tx.select({ at: sql<Date | null>`min(${agentRuns.createdAt})` }).from(agentRuns);
      if (first?.at && row.createdAt >= new Date(first.at)) throw new HttpError(400, "No pending approvals to respond to");
      const [routineRun] = await tx
        .select({ id: routineRuns.id })
        .from(routineRuns)
        .where(and(eq(routineRuns.conversationId, conv.id), eq(routineRuns.status, "awaiting_approval")))
        .limit(1);
      run = await insertRunTx(tx, {
        userId,
        conversationId: conv.id,
        messageId: row.id,
        parentMessageId: row.parentId,
        appId: (row.metadata as MessageMeta | null)?.appId ?? conv.appId,
        botId: conv.botId,
        routineRunId: routineRun?.id ?? null,
        status: "waiting",
        legacy: true,
      });
    }
    if (run.executionMode !== "worker") throw new HttpError(409, "Delegated tasks cannot resume.");
    if (isActive(run.status)) throw new RunBusyError("This reply is still running.");
    if (run.status !== "waiting") throw new HttpError(409, "This reply has finished; there's nothing to answer.");
    if (run.cancelRequestedAt) throw new HttpError(409, "This reply is being cancelled; its approval cannot be answered.");
    await assertUnderCap(tx, userId, run.id);

    // Decided under the message's row lock: each approval is used once (a second tab finds it answered).
    const claimed = await updatePartsLockedTx(tx, conv.id, i.messageId, (row) => {
      if (row.role !== "assistant") return null;
      const { parts, changed } = applyApprovalDecisions(row.parts as ToolPartView[], i.decisions);
      return changed ? parts : null;
    });
    if (!claimed || claimed.row.role !== "assistant") throw new HttpError(400, "Unknown message");
    if (!claimed.parts) throw new HttpError(400, "No pending approvals to respond to");
    const chunks = approvalResponseChunks(claimed.row.parts as ToolPartView[], claimed.parts as ToolPartView[]);

    const requeued = await requeueRunTx(tx, run.id, userId, chunks);
    if (!requeued) throw new RunBusyError();
    if (requeued.routineRunId) {
      await tx
        .update(routineRuns)
        .set({ status: "running" })
        .where(and(eq(routineRuns.id, requeued.routineRunId), eq(routineRuns.status, "awaiting_approval")));
    }
    return requeued;
  });
  await enqueueOrFail(run);
  return run;
}

/** Stop: queued runs → cancelled at once (closing parts saved, hooks); running → cancel requested + signal. Waiting runs are untouched. */
export async function stopRuns(principal: Principal, conversationId: string): Promise<{ cancelled: number; signalled: number }> {
  const open = await db
    .select({ id: agentRuns.id, status: agentRuns.status })
    .from(agentRuns)
    .where(
      and(or(eq(agentRuns.conversationId, conversationId), inArray(agentRuns.id, db.select({ id: delegatedTasks.childRunId }).from(delegatedTasks).where(and(eq(delegatedTasks.originConversationId, conversationId), eq(delegatedTasks.userId, principal.user.id))))), eq(agentRuns.userId, principal.user.id),
        or(inArray(agentRuns.status, [...HOLDING_STATUSES]), and(eq(agentRuns.executionMode, "async_delegate"), eq(agentRuns.status, "waiting")))),
    );
  let cancelled = 0;
  let signalled = 0;
  for (const run of open) {
    if (["queued", "waiting_tasks", "waiting"].includes(run.status) && (await abortQueuedRun(run.id, { status: "cancelled" }, { waitingTasks: true, waitingApproval: true }))) {
      cancelled++;
      continue;
    }
    // Running (or claimed since it was read): the executor aborts on the signal. Under the row lock, so a run that
    // finished meanwhile is left alone; a human-approval pause keeps its approval answerable.
    const status = await db.transaction(async (tx) => {
      await lockUserRuns(tx, principal.user.id);
      const [cur] = await tx.select({ status: agentRuns.status, executionMode: agentRuns.executionMode }).from(agentRuns).where(eq(agentRuns.id, run.id)).for("update");
      return cur && (isActive(cur.status) || cur.status === "waiting_tasks" || (cur.status === "waiting" && cur.executionMode === "async_delegate")) ? requestCancelTx(tx, run.id) : null;
    });
    if (status && ["queued", "waiting_tasks", "waiting"].includes(status) && await abortQueuedRun(run.id, { status: "cancelled" }, { waitingTasks: true, waitingApproval: true })) cancelled++;
    else if (status && (isActive(status) || status === "waiting_tasks" || status === "waiting")) signalled++;
  }
  return { cancelled, signalled };
}

/**
 * Stop pressed before the reply's run existed (its request still being handled): waits up to runConfig().stopWaitMs
 * for the run answering `messageId` (the user message, or the assistant message of a continuation) to appear, then
 * stops it if it's still active. Nothing happens for a run that already ended.
 */
export async function stopRunFor(principal: Principal, conversationId: string, messageId: string): Promise<{ cancelled: number; signalled: number }> {
  const deadline = Date.now() + runConfig().stopWaitMs;
  for (;;) {
    const [run] = await db
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.conversationId, conversationId),
          eq(agentRuns.userId, principal.user.id),
          or(eq(agentRuns.parentMessageId, messageId), eq(agentRuns.messageId, messageId)),
          inArray(agentRuns.status, [...HOLDING_STATUSES]),
        ),
      )
      .limit(1);
    if (run) return stopRuns(principal, conversationId);
    if (Date.now() >= deadline) return { cancelled: 0, signalled: 0 };
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * Ends a run that is still queued (stop, or the tail's queue timeout): finalizeRunTx from queued, closeOpenParts on
 * the stored message (a queued continuation holds answered approvals that never ran), save it, then hooks.
 */
export async function abortQueuedRun(
  runId: string,
  to: { status: "cancelled" | "failed"; error?: string },
  opts: { ifUnclaimedForMs?: number; waitingTasks?: boolean; waitingApproval?: boolean } = {},
): Promise<AgentRun | null> {
  const done = await db.transaction(async (tx) => {
    // `ifUnclaimedForMs` (the tail's queue timeout): only when it has waited that long by the database's clock and no
    // worker is busy, i.e. no run is running with a fresh heartbeat (a live worker with a free slot claims at once).
    const unclaimed = opts.ifUnclaimedForMs
      ? [
          sql`${agentRuns.updatedAt} < now() - ${Math.round(opts.ifUnclaimedForMs)}::int * interval '1 millisecond'`,
          sql`not exists (select 1 from agent_runs busy where busy.status = 'running'
                and busy.heartbeat_at > now() - ${Math.round(runConfig().staleMs)}::int * interval '1 millisecond')`,
        ]
      : [];
    // Run row first, then the message (the order every run transaction locks them in).
    const [cur] = await tx
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.id, runId), or(inArray(agentRuns.status, opts.waitingTasks ? ["queued", "waiting_tasks"] : ["queued"]),
        opts.waitingApproval ? and(eq(agentRuns.executionMode, "async_delegate"), eq(agentRuns.status, "waiting")) : undefined), ...unclaimed))
      .for("update");
    if (!cur) return null;
    const [row] = await tx
      .select()
      .from(messages)
      .where(and(eq(messages.id, cur.messageId), eq(messages.conversationId, cur.conversationId)))
      .for("update");
    let message: PortalUIMessage | null = null;
    const closing: UIMessageChunk[] = [];
    if (row) {
      const closed = closeOpenParts(rowToUIMessage(row), to.status, to.status === "failed" ? { endNote: to.error } : {});
      if (closed.changed) await updateMessageParts(cur.conversationId, closed.message, {}, tx);
      message = closed.message;
      closing.push(...closed.chunks);
    }
    if (to.status === "failed" && to.error) closing.push({ type: "error", errorText: to.error });
    const finished = await finalizeRunTx(tx, runId, { status: [cur.status] }, { status: to.status, error: to.error ?? null, closing });
    // Can't happen under the row lock; roll the message back rather than save it for a run that isn't ending.
    if (!finished) throw new Error(`run ${runId} left the queue while locked`);
    // A worker still holding this run's Hermes stream (from its pause) closes it.
    if ((cur.resumeState as ResumeState | null)?.hermes) await notifyRun(tx, { r: runId, k: "c" });
    return { run: finished, message, before: cur };
  });
  if (!done) return null;
  // A queued continuation's Hermes run is still waiting for the answer that won't be delivered now.
  await stopProviderRun(done.before);
  await afterRunTransition(done.run, done.run.status, done.message, to.error ?? null).catch((err) =>
    console.error(`[runs] hooks after run ${runId} (${to.status}) failed`, err),
  );
  return done.run;
}

/** What GET /api/chat/[id]/stream replays: the active run, else a non-legacy run that finished or paused within runConfig().recentReplayMs. */
export async function resumableRun(conversationId: string): Promise<AgentRun | null> {
  // Legacy runs have no events before their continuation (a replay must hold the whole message): never replayed. An
  // active run is tailed even before its first event; an ended one only when it has something to show.
  const active = await activeRunOf(conversationId);
  if (active) return active.legacy ? null : active;
  // Only the latest run qualifies: an older one's message isn't the one the page ends with.
  const ended = sql`coalesce(${agentRuns.finishedAt}, ${agentRuns.updatedAt})`;
  const [latest] = await db
    .select({ run: agentRuns, recent: sql<boolean>`${ended} > now() - ${runConfig().recentReplayMs}::int * interval '1 millisecond'` })
    .from(agentRuns)
    .where(and(eq(agentRuns.conversationId, conversationId), inArray(agentRuns.status, ["waiting", ...FINAL_STATUSES])))
    .orderBy(desc(ended))
    .limit(1);
  return latest?.recent && !latest.run.legacy && latest.run.lastSeq > 0 ? latest.run : null;
}
