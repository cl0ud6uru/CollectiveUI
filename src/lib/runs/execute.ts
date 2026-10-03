/**
 * The run executor: one segment of a durable run, in the worker (one agent.run job = one segment). It claims the run,
 * re-authorizes the acting user and the chat's bot and app (every segment), calls runTurn with the run's
 * AbortController, pumps the UI stream into the event log (RunEventWriter, fenced on this worker), saves the message
 * under the lease when the turn ends, then pauses the run at an approval or finishes it, and runs the hooks once.
 *
 * Aborts (reason = RunAbort) come from a stop (listener `c`, or a cancel request seen by a fence or heartbeat), the
 * segment timeout, the worker shutting down (or pg-boss giving the job up), or a lost lease (write nothing more).
 */
import type { UIMessageChunk } from "ai";
import { and, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import { agentRuns, conversations, delegatedTasks, messages, type AiApp } from "@/db/schema";
import { afterAssistantSaved, hasPendingApproval, saveAssistantMessage, type PersistTurnInput } from "@/lib/agent/persist";
import { runTurn, type TurnResult } from "@/lib/agent/run";
import { resolveTurnTarget } from "@/lib/agent/target";
import { loadPrincipal } from "@/lib/auth/groups";
import { HttpError } from "@/lib/authz";
import { loadMessageRows, pathTo, rowToUIMessage, updateMessageParts, type PortalUIMessage } from "@/lib/chat/store";
import { userFacingMessage } from "@/lib/llm";
import { enqueueRun } from "@/lib/jobs";
import { redactSecrets } from "@/lib/redact";
import { decideFinal, finalErrorText } from "./decide";
import { RunEventWriter } from "./events";
import { afterRunTransition } from "./hooks";
import { loadHermesRunContext } from "./hermes-context";
import { stopHermesConversation } from "./hermes-stop";
import { runHost } from "./host";
import { notifyRun } from "./log";
import { closeOpenParts } from "./replay";
import { claimRun, finalizeRunTx, getRun, noteRunResumeState, pauseRun, setRunBilling, withRunFence } from "./state";
import { stopProviderRun } from "./provider-stop";
import { abortQueuedRun } from "./store";
import { afterFinishedFromLog, finishFromLogTx } from "./sweeper";
import { abortKindOf, isBackgroundSegment, RunAbort, runConfig, type AgentRun, type AgentRunStatus, type FinalStatus, type ResumeState, type RunHandle } from "./types";

/** How long the turn may take to settle (persist, close its tools) once its stream has ended. */
const DONE_TIMEOUT_MS = 30_000;
const PARENT_RETRIES = 5;
const PARENT_RETRY_MS = 300;
const SUPERSEDED = "Not answered before the next message.";
const NOT_SAVED = "The reply couldn't be saved. Try again.";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Resolves with the promise's value, or undefined after `ms`. */
async function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<undefined>((r) => (timer = setTimeout(() => r(undefined), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

const hooks = (run: AgentRun, status: AgentRunStatus, message: PortalUIMessage | null, error: string | null) =>
  afterRunTransition(run, status, message, error).catch((err) => console.error(`[runs] hooks after run ${run.id} (${status}) failed`, err));

/**
 * What an approved tool shows when the segment ended before its result came back: it was already running (or about
 * to), so it may have had effects; "Stopped before it ran." is kept for runs stopped while still queued.
 */
const STOPPED_MID_RUN = "Stopped while it was running: it may have run.";

/** The note saved on a reply that ended early (a failure or a worker restart; not a Stop, not a pause). */
const endNoteFor = (status: AgentRunStatus, error: string | null | undefined) =>
  (status === "failed" || status === "interrupted") && error ? error : undefined;

/**
 * Executes the run's queued segment. Throws only when the worker is shutting down (so pg-boss fails the job); a claim
 * that fails (taken, cancelled, finished) returns; a failure after the claim ends the run as failed where possible,
 * else the sweeper interrupts it once the heartbeat is stale.
 * `signal` is the pg-boss job's (aborted when pg-boss gives the job up, and whenever the handler returns).
 */
export async function executeRun(runId: string, opts: { signal?: AbortSignal } = {}): Promise<void> {
  const host = runHost();
  if (host.shuttingDown) {
    // A job fetched while shutting down: leave the run queued and enqueue it again for whichever worker comes next,
    // and fail this job (not completed: nothing ran). The next worker's startup sweep re-enqueues it as well.
    const queued = await getRun(runId).catch(() => null);
    if (queued?.status === "queued") await enqueueRun(queued, { delaySeconds: 5 }).catch(() => {});
    throw new Error(`worker shutting down: run ${runId} left queued`);
  }
  let run: AgentRun | null;
  try {
    run = await claimRun(runId, host.instanceId);
    if (!run) return await reconcileUnclaimed(runId);
  } catch (err) {
    console.error(`[runs] couldn't claim run ${runId}`, err);
    return;
  }

  const ac = new AbortController();
  const untrack = host.track(run.id, ac);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onJobAbort = () => ac.abort(new RunAbort("shutdown"));
  opts.signal?.addEventListener("abort", onJobAbort, { once: true });
  if (opts.signal?.aborted) onJobAbort();
  try {
    const background = isBackgroundSegment(run);
    const [task] = run.executionMode === "async_delegate" ? await db.select().from(delegatedTasks).where(eq(delegatedTasks.childRunId, run.id)) : [];
    const deadlineAt = Math.min((run.resumeState as ResumeState | null)?.native?.deadlineAt ?? Infinity, task?.deadlineAt.getTime() ?? Infinity);
    const timeoutMs = Math.max(1, Math.min(deadlineAt - Date.now(), background && run.executionMode !== "async_delegate" ? runConfig().routineTimeoutMs : runConfig().runTimeoutMs));
    timer = setTimeout(() => ac.abort(new RunAbort("timeout")), timeoutMs);
    await executeSegment(run, host.instanceId, ac, { background, timeoutMs });
  } catch (err) {
    console.error(`[runs] run ${run.id} segment ${run.segment} failed`, err);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onJobAbort);
    untrack();
  }
}

/** A claim that didn't apply: a run stopped while it was queued is ended here (nobody else will). */
async function reconcileUnclaimed(runId: string) {
  const cur = await getRun(runId);
  if (cur?.status === "queued" && cur.cancelRequestedAt) await abortQueuedRun(runId, { status: "cancelled" });
  else if (cur?.status === "queued" && cur.executionMode === "async_delegate") await enqueueRun(cur, { delaySeconds: 5 }).catch(() => {});
}

type Outcome = {
  status: AgentRunStatus;
  /** The message as the turn produced it (closing chunks are computed from it once the log has everything). */
  produced: PortalUIMessage;
  /** The closed message, as saved. */
  message: PortalUIMessage;
  error: string | null;
  /** The stream carried its own error chunk. */
  streamError: boolean;
};

async function executeSegment(run: AgentRun, holder: string, ac: AbortController, cfg: { background: boolean; timeoutMs: number }) {
  let saved: ResumeState | null = null;
  const handle: RunHandle = {
    id: run.id,
    holder,
    deadlineAt: Date.now() + cfg.timeoutMs,
    segment: run.segment,
    legacy: run.legacy,
    resumeState: (run.resumeState as ResumeState | null) ?? null,
    saveResumeState: (s) => {
      saved = s;
    },
    noteProviderRun: (s) => noteRunResumeState(run.id, holder, s),
  };
  const leafOnlyFrom = [run.parentMessageId, run.messageId].filter((x): x is string => !!x);
  let outcome: Outcome | undefined;
  let writer: RunEventWriter | undefined;
  let turn: TurnResult;

  // Capture the SDK message; the pump must commit its terminal tool events before this snapshot is saved.
  // Otherwise a delayed/rejected delegation receipt could disagree with an already-saved successful result.
  let pendingPersist: { input: PersistTurnInput; end: { error?: string } } | undefined;
  const persist = async (input: PersistTurnInput, end: { error?: string }) => { pendingPersist = { input, end }; };
  const saveTurn = async (input: PersistTurnInput, end: { error?: string }) => {
    const abort = ac.signal.aborted ? abortKindOf(ac.signal.reason) : undefined;
    const status = decideFinal({ abort, error: end.error, pendingApproval: hasPendingApproval(input.responseMessage), pendingTasks: !!turn.native?.taskIds.length });
    if (!status) return; // lease lost: whoever holds the run now saves it
    const error = finalErrorText({ abort, error: end.error, timeoutMs: cfg.timeoutMs });
    const { message } = closeOpenParts(input.responseMessage, status, { endNote: endNoteFor(status, error), stoppedText: STOPPED_MID_RUN });
    const closed: PersistTurnInput = { ...input, responseMessage: message };
    const fenced = await withRunFence(run.id, holder, (tx) => saveAssistantMessage(closed, tx, { leafOnlyFrom }));
    if (!fenced) {
      ac.abort(new RunAbort("lease-lost"));
      return;
    }
    outcome = {
      status,
      produced: input.responseMessage,
      message,
      error,
      streamError: !!end.error && !abort,
    };
    await afterAssistantSaved(closed);
  };

  try {
    const setup = await prepareSegment(run);
    handle.hermes = await loadHermesRunContext(run.id);
    if (run.segment === 0 && setup.app.provider === "hermes") await supersedeWaiting(run, setup.app);
    writer = new RunEventWriter({
      runId: run.id,
      segment: run.segment,
      holder,
      onLeaseLost: () => ac.abort(new RunAbort("lease-lost")),
      onCancel: () => ac.abort(new RunAbort("cancel")),
    });
    turn = await runTurn({
      ...setup,
      background: cfg.background,
      interactive: run.executionMode !== "async_delegate",
      abortSignal: ac.signal,
      run: handle,
      responseMessageId: run.messageId,
      persist,
    });
  } catch (err) {
    await writer?.close();
    if (abortKindOf(ac.signal.reason) === "lease-lost") return;
    await failSetup(run, holder, err);
    return;
  }

  if (turn.billing?.source) await setRunBilling(run.id, holder, turn.billing.source).catch((err) => console.warn(`[runs] run ${run.id}: billing not recorded`, err));
  await pump(turn.stream, writer, ac);
  await within(turn.done, DONE_TIMEOUT_MS);
  await writer.close();
  if (writer.leaseLost || abortKindOf(ac.signal.reason) === "lease-lost") return;

  if (pendingPersist) {
    try { await saveTurn(pendingPersist.input, pendingPersist.end); }
    catch (err) { console.error(`[runs] failed to persist run ${run.id}`, err); }
  }
  if (abortKindOf(ac.signal.reason) === "lease-lost") return;
  const o = outcome as Outcome | undefined;
  if (!o) {
    // The turn ended without saving (persist failed, or never ran): end the run from what the log holds.
    const done = await withRunFence(run.id, holder, (tx) => finishFromLogTx(tx, run, { status: ["running"], holder }, { status: "failed", error: NOT_SAVED }));
    if (done?.value) await afterFinishedFromLog(done.value, NOT_SAVED);
    return;
  }

  const closing: UIMessageChunk[] = closeOpenParts(o.produced, o.status, {
    openIds: writer.openStreamIds(),
    endNote: endNoteFor(o.status, o.error),
    stoppedText: STOPPED_MID_RUN,
  }).chunks;
  // Timeouts and shutdowns end with an abort chunk only: say why.
  if (o.error && !o.streamError) closing.push({ type: "error", errorText: o.error });
  if (o.status === "waiting_tasks" && turn.native) {
    const { suspendForTasks, reconcileAsyncParent } = await import("@/lib/delegation/async");
    let paused: AgentRun | null;
    try { paused = await suspendForTasks(run, holder, turn.native, closing); }
    catch (err) {
      const error = err instanceof HttpError ? err.message : "The delegated assignments could not be saved.";
      const ended = await withRunFence(run.id, holder, tx => finishFromLogTx(tx, run, { status: ["running"], holder }, { status: "failed", error }));
      if (ended?.value) await afterFinishedFromLog(ended.value, error);
      return;
    }
    if (paused?.status === "waiting_tasks") await reconcileAsyncParent(run.id);
    else if (paused) await hooks(paused, paused.status, o.message, paused.error);
    return;
  }
  if (o.status === "waiting") {
    const paused = await pauseRun(run, holder, turn.native ? { ...(saved ?? {}), native: turn.native } : saved, closing);
    if (paused?.cancelRequestedAt && handle.hermes) await stopHermesConversation(run.userId, run.conversationId);
    else if (paused) await hooks(paused, "waiting", o.message, null);
    return;
  }
  const status = o.status as FinalStatus;
  const finished = await db.transaction((tx) => finalizeRunTx(tx, run.id, { status: ["running"], holder }, { status, error: o.error, closing }));
  if (!finished) return;
  // Ended early: a provider run that reached an approval in this segment (its stream held for a pause that won't
  // come now) or is otherwise still going must not carry on unobserved.
  if (finished.status !== "succeeded") await stopProviderRun({ id: run.id, appId: run.appId, resumeState: saved ?? run.resumeState });
  await hooks(finished, finished.status, o.message, o.error);
}

/** Reads the turn's stream into the log. After an abort the stream gets runConfig().cancelDeadlineMs to end by itself. */
async function pump(stream: ReadableStream<UIMessageChunk>, writer: RunEventWriter, ac: AbortController) {
  const reader = stream.getReader();
  let cut: ReturnType<typeof setTimeout> | undefined;
  const armCut = () => {
    // A tool that ignores the abort would hold the segment: cancel the stream (runTurn still saves on cancel).
    cut ??= setTimeout(() => void reader.cancel(ac.signal.reason).catch(() => {}), runConfig().cancelDeadlineMs);
  };
  ac.signal.addEventListener("abort", armCut, { once: true });
  if (ac.signal.aborted) armCut();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // A provider whose response is cut by the abort reports a failed request: that's the stop, not an error (the
      // run's status says what happened, with its own error text for a timeout or shutdown).
      if (value.type === "error" && ac.signal.aborted) continue;
      await writer.push(value);
    }
  } catch (err) {
    console.error("[runs] reading the turn's stream failed", err);
  } finally {
    clearTimeout(cut);
    ac.signal.removeEventListener("abort", armCut);
  }
}

/** Re-authorizes the run's user, chat, bot and app, and loads the history the turn continues. */
async function prepareSegment(run: AgentRun) {
  const principal = await loadPrincipal(run.userId);
  if (!principal) throw new HttpError(403, "This account is disabled.");
  const [conversation] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, run.conversationId), eq(conversations.userId, run.userId)));
  if (!conversation || conversation.isGroup) throw new HttpError(404, "This chat is no longer available.");
  const { bot, app } = await resolveTurnTarget(principal, conversation);
  if ((bot?.id ?? null) !== run.botId) throw new HttpError(409, "This chat's bot changed.");
  let delegation: Parameters<typeof runTurn>[0]["delegation"];
  if (run.executionMode === "async_delegate") {
    const [task] = await db.select().from(delegatedTasks).where(and(eq(delegatedTasks.childRunId, run.id), eq(delegatedTasks.userId, run.userId), eq(delegatedTasks.mode, "async")));
    if (!task || app.provider === "hermes" || app.id !== run.appId) throw new HttpError(403, "The native task's connection changed.");
    const { assertTaskExecution } = await import("@/lib/delegation/store");
    const authorize = async () => {
      await assertTaskExecution(task);
      const current = await getRun(run.id);
      if (!current || current.status !== "running" || current.holder !== run.holder || current.segment !== run.segment) throw new RunAbort("lease-lost");
      if (current.cancelRequestedAt) throw new RunAbort("cancel");
    };
    await authorize();
    delegation = { task, authorize };
  }

  let rows = await loadMessageRows(conversation.id);
  if (run.segment === 0) {
    const parentId = run.parentMessageId;
    if (!parentId) throw new HttpError(400, "There's no message to reply to.");
    for (let i = 0; i < PARENT_RETRIES && !rows.some((r) => r.id === parentId); i++) {
      await sleep(PARENT_RETRY_MS);
      rows = await loadMessageRows(conversation.id);
    }
    const parent = rows.find((r) => r.id === parentId);
    if (!parent || parent.role !== "user") throw new HttpError(400, "The message this reply answers is gone.");
    return { principal, conversation, bot, app, history: pathTo(rows, parentId).map(rowToUIMessage), continuation: false, delegation };
  }
  const stored = rows.find((r) => r.id === run.messageId);
  if (!stored || stored.role !== "assistant") throw new HttpError(400, "The reply to continue is gone.");
  const history = [...pathTo(rows, stored.parentId).map(rowToUIMessage), rowToUIMessage(stored)];
  return { principal, conversation, bot, app, history, continuation: true, delegation };
}

/**
 * A new Hermes turn ends the conversation's Hermes runs still waiting on an approval (Hermes runs one turn per
 * session at a time): cancelled, their unanswered approvals denied, the held stream closed and the Hermes run
 * stopped (best effort). Failures are logged; the new turn goes ahead.
 */
async function supersedeWaiting(run: AgentRun, app: AiApp) {
  let waiting: AgentRun[];
  try {
    waiting = await db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.conversationId, run.conversationId), eq(agentRuns.status, "waiting"), ne(agentRuns.id, run.id)));
  } catch (err) {
    console.error(`[runs] run ${run.id}: couldn't list waiting runs to supersede`, err);
    return;
  }
  for (const w of waiting) {
    const hermesRunId = (w.resumeState as ResumeState | null)?.hermes?.runId;
    if (!hermesRunId && w.appId !== app.id) continue;
    try {
      const done = await db.transaction(async (tx) => {
        // Run row first, then the message (the order every run transaction locks them in).
        const [cur] = await tx
          .select()
          .from(agentRuns)
          .where(and(eq(agentRuns.id, w.id), eq(agentRuns.status, "waiting")))
          .for("update");
        if (!cur) return null;
        const [row] = await tx
          .select()
          .from(messages)
          .where(and(eq(messages.id, cur.messageId), eq(messages.conversationId, cur.conversationId)))
          .for("update");
        const closed = row ? closeOpenParts(rowToUIMessage(row), "cancelled", { deniedReason: SUPERSEDED }) : null;
        const finished = await finalizeRunTx(tx, cur.id, { status: ["waiting"] }, { status: "cancelled", closing: closed?.chunks ?? [] });
        if (!finished) return null;
        if (closed?.changed) await updateMessageParts(cur.conversationId, closed.message, {}, tx);
        // A worker holding this run's Hermes stream closes it.
        await notifyRun(tx, { r: cur.id, k: "c" });
        return { run: finished, message: closed?.message ?? null };
      });
      if (!done) continue;
      await stopProviderRun(done.run);
      await hooks(done.run, "cancelled", done.message, null);
    } catch (err) {
      console.error(`[runs] run ${run.id}: couldn't supersede waiting run ${w.id}`, err);
    }
  }
}

/**
 * Setup failed before the turn streamed anything: the run fails with an error chunk. A continuation fails closed:
 * its answered approvals become errors ("Couldn't continue: …") and are never re-armed, so a tool can't run twice.
 */
async function failSetup(run: AgentRun, holder: string, err: unknown) {
  const text = err instanceof HttpError ? err.message : (userFacingMessage(err) ?? "Couldn't start this reply.");
  console.error(`[runs] run ${run.id} segment ${run.segment}: setup failed:`, redactSecrets(err instanceof Error ? (err.stack ?? err.message) : String(err)));
  const fenced = await withRunFence(run.id, holder, async (tx) => {
    let message: PortalUIMessage | null = null;
    const closing: UIMessageChunk[] = [];
    if (run.segment > 0) {
      const [row] = await tx
        .select()
        .from(messages)
        .where(and(eq(messages.id, run.messageId), eq(messages.conversationId, run.conversationId)))
        .for("update");
      if (row) {
        const closed = closeOpenParts(rowToUIMessage(row), "failed", { stoppedText: `Couldn't continue: ${text}`, endNote: text });
        if (closed.changed) await updateMessageParts(run.conversationId, closed.message, {}, tx);
        message = closed.message;
        closing.push(...closed.chunks);
      }
    }
    closing.push({ type: "error", errorText: text });
    const finished = await finalizeRunTx(tx, run.id, { status: ["running"], holder }, { status: "failed", error: text, closing });
    if (!finished) throw new Error(`run ${run.id} changed while locked`);
    return { run: finished, message };
  });
  if (fenced) {
    // A continuation's Hermes run is still waiting for the answer this segment couldn't deliver.
    if (run.segment > 0) await stopProviderRun(run);
    await hooks(fenced.value.run, "failed", fenced.value.message, text);
  }
}
