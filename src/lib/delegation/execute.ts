import { getToolOrDynamicToolName, isToolUIPart, readUIMessageStream } from "ai";
import { and, eq } from "drizzle-orm";
import { db, type DbOrTx } from "@/db";
import { agentRuns, bots, conversations, messages } from "@/db/schema";
import { runTurn } from "@/lib/agent/run";
import { afterAssistantSaved, saveAssistantMessage, type PersistTurnInput } from "@/lib/agent/persist";
import { resolveTurnTarget } from "@/lib/agent/target";
import type { AgentCtx } from "@/lib/agent/types";
import { loadMessageRows, rowToUIMessage, type PortalUIMessage } from "@/lib/chat/store";
import { userFacingMessage } from "@/lib/llm";
import { HttpError } from "@/lib/authz";
import { loadHermesRunContext } from "@/lib/runs/hermes-context";
import { hermesAdmissionRecorder } from "@/lib/runs/hermes-admission";
import { lockUserRuns } from "@/lib/runs/lock";
import { runHost } from "@/lib/runs/host";
import { RunEventWriter } from "@/lib/runs/events";
import { closeOpenParts } from "@/lib/runs/replay";
import { finalizeRunTx, getRun, noteRunResumeState, setRunBilling } from "@/lib/runs/state";
import { finishFromLogTx, afterFinishedFromLog } from "@/lib/runs/sweeper";
import { stopProviderRun } from "@/lib/runs/provider-stop";
import { tailRun } from "@/lib/runs/tail";
import { abortKindOf, RunAbort, runConfig, type FinalStatus, type RunHandle } from "@/lib/runs/types";
import { admitDelegation, assertTaskExecution, type DelegatedTask } from "./store";
import type { DelegationResult } from "./policy";

const safeError = (e: unknown) => e instanceof HttpError ? e.message : userFacingMessage(e) ?? "The delegated task could not finish.";

/** One admitted invocation, never exposed as a queue handler. The task's caller owns its lifetime. */
async function executeInline(task: DelegatedTask, parent: AgentCtx, signal: AbortSignal | undefined) {
  const host = runHost();
  host.start();
  const run = await getRun(task.childRunId!);
  if (!run || run.executionMode !== "inline_delegate" || run.status !== "running" || run.holder !== host.instanceId) return;
  const ac = new AbortController();
  const abort = () => ac.abort(signal?.reason instanceof RunAbort ? signal.reason : new RunAbort("cancel"));
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => ac.abort(new RunAbort("timeout")), Math.max(0, task.deadlineAt.getTime() - Date.now()));
  const untrack = host.track(run.id, ac);
  const writer = new RunEventWriter({ runId: run.id, segment: 0, holder: host.instanceId,
    onLeaseLost: () => ac.abort(new RunAbort("lease-lost")), onCancel: () => ac.abort(new RunAbort("cancel")) });
  let input: PersistTurnInput | undefined;
  let failure: string | undefined;
  const authorize = async () => {
    if (ac.signal.aborted) throw ac.signal.reason;
    await assertTaskExecution(task);
    const cur = await getRun(run.id);
    if (!cur || cur.userId !== task.userId || cur.conversationId !== task.childConversationId || cur.botId !== task.receiverBotId || cur.holder !== host.instanceId || cur.status !== "running") {
      ac.abort(new RunAbort("lease-lost")); throw ac.signal.reason;
    }
    if (cur.cancelRequestedAt) { ac.abort(new RunAbort("cancel")); throw ac.signal.reason; }
  };
  try {
    try {
      await authorize();
      const principal = await assertTaskExecution(task);
      const [conversation] = await db.select().from(conversations).where(and(eq(conversations.id, run.conversationId), eq(conversations.userId, run.userId)));
      const { bot, app } = await resolveTurnTarget(principal, conversation);
      if (bot?.id !== task.receiverBotId || app.id !== run.appId) throw new HttpError(409, "The receiving bot's connection changed.");
      const handle: RunHandle = { id: run.id, holder: host.instanceId, deadlineAt: task.deadlineAt.getTime(), segment: 0, legacy: false, resumeState: null,
        saveResumeState: () => { throw new Error("Delegates cannot pause for approval."); },
        noteProviderRun: s => noteRunResumeState(run.id, host.instanceId, s) };
      handle.hermes = await loadHermesRunContext(run.id);
      handle.noteHermesAdmission = hermesAdmissionRecorder(run.id, host.instanceId, 0, handle.hermes);
      const rows = await loadMessageRows(run.conversationId);
      const prompt = rows.find(m => m.id === run.parentMessageId && m.role === "user");
      if (!prompt) throw new HttpError(409, "The assignment is no longer available.");
      const turn = await runTurn({ principal, conversation, bot, app, history: [rowToUIMessage(prompt)], continuation: false,
        background: parent.background, interactive: false, run: handle, responseMessageId: run.messageId, abortSignal: ac.signal,
        delegation: { task, parent, authorize }, persist: async (saved, end) => { input = saved; failure = end.error; } });
      if (turn.billing) await setRunBilling(run.id, host.instanceId, turn.billing.source);
      const reader = turn.stream.getReader();
      let cut: ReturnType<typeof setTimeout> | undefined;
      let release!: () => void;
      const abandoned = new Promise<void>(resolve => { release = resolve; });
      const endRead = () => { cut ??= setTimeout(() => { release(); void reader.cancel().catch(() => {}); }, runConfig().cancelDeadlineMs); };
      ac.signal.addEventListener("abort", endRead, { once: true });
      if (ac.signal.aborted) endRead();
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          if (next.value.type !== "error" || !ac.signal.aborted) await writer.push(next.value);
        }
        await Promise.race([turn.done, abandoned]);
      } finally { clearTimeout(cut); ac.signal.removeEventListener("abort", endRead); }
    } catch (e) { failure = safeError(e); }
    finally {
      await writer.close();
    }
    if (writer.leaseLost || abortKindOf(ac.signal.reason) === "lease-lost") return;
    const final = await db.transaction(async tx => {
      await lockUserRuns(tx, task.userId);
      // Cancellation wins under the same row lock as finalization; late results cannot restore success.
      const [current] = await tx.select().from(agentRuns).where(eq(agentRuns.id, run.id)).for("update");
      if (!current || current.status !== "running" || current.holder !== host.instanceId) return null;
      const kind = abortKindOf(ac.signal.reason);
      let status: FinalStatus = current.cancelRequestedAt || kind === "cancel" ? "cancelled" : kind === "shutdown" ? "interrupted" : failure || kind === "timeout" ? "failed" : "succeeded";
      let error = status === "cancelled" ? "Stopped. Actions already dispatched may have run." : kind === "timeout" ? "The delegated task deadline expired." : failure ?? null;
      if (status === "succeeded") {
        try { await assertTaskExecution(task, tx); } catch (e) { status = "failed"; error = safeError(e); }
      }
      if (!input) {
        const done = await finishFromLogTx(tx, current, { status: ["running"], holder: host.instanceId }, { status: status === "succeeded" ? "failed" : status, error: error ?? "The delegated reply could not be saved." });
        return done && { ...done, input: null, before: current, error };
      }
      const closed = closeOpenParts(input.responseMessage, status, { openIds: writer.openStreamIds(), endNote: error ?? undefined, stoppedText: "Stopped while it was running: it may have run." });
      const saved = { ...input, responseMessage: closed.message, background: true };
      await saveAssistantMessage(saved, tx, { leafOnlyFrom: [run.parentMessageId!, run.messageId] });
      const finished = await finalizeRunTx(tx, run.id, { status: ["running"], holder: host.instanceId }, { status, error, closing: closed.chunks });
      return finished && { run: finished, message: closed.message, input: saved, before: current, error };
    });
    if (final) {
      if (final.run.status !== "succeeded") await stopProviderRun(final.before);
      if (final.input) await afterAssistantSaved(final.input);
      else await afterFinishedFromLog(final, final.error ?? "Task ended.");
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    untrack();
  }
}

function stepsOf(message: PortalUIMessage): DelegationResult["steps"] {
  return message.parts.filter(isToolUIPart).slice(-30).map(p => ({ tool: getToolOrDynamicToolName(p),
    status: p.state === "output-denied" ? "denied" : p.state === "output-error" || ("output" in p && p.output && typeof p.output === "object" && "status" in p.output && ["error", "cancelled", "interrupted"].includes(String(p.output.status))) ? "error" : p.state === "output-available" && !("preliminary" in p && p.preliminary) ? "done" : "running" }));
}

/** Who the task went to, for the chat card. The bot row may since be gone; its id and name are kept on the task. */
export async function resultHead(task: DelegatedTask, q: DbOrTx = db) {
  const [bot] = await q.select({ avatar: bots.avatar, label: bots.label }).from(bots).where(eq(bots.id, task.receiverBotId));
  return { taskId: task.id, conversationId: task.childConversationId, bot: task.receiverName, botId: task.receiverBotId, avatar: bot?.avatar ?? null, label: bot?.label ?? null };
}

/** The persisted final step is the parent's result; intermediate reasoning/tool results stay in the task. */
export async function taskResult(task: DelegatedTask, q: DbOrTx = db): Promise<DelegationResult> {
  const run = task.childRunId ? await getRun(task.childRunId, q) : null;
  const base: DelegationResult = { ...await resultHead(task, q), status: "error", steps: [] };
  if (!run || run.userId !== task.userId || run.conversationId !== task.childConversationId || run.botId !== task.receiverBotId) return { ...base, error: "The task was removed." };
  if (run.status === "queued") return { ...base, status: "queued" };
  if (run.status === "running" || run.status === "waiting_tasks") return { ...base, status: "working" };
  const [row] = await q.select().from(messages).where(and(eq(messages.id, run.messageId), eq(messages.conversationId, run.conversationId)));
  const message = row ? rowToUIMessage(row) : null;
  if (message) base.steps = stepsOf(message);
  if (run.status !== "succeeded") return { ...base, status: run.status === "cancelled" || run.status === "interrupted" ? run.status : "error", error: run.error ?? "The delegated task did not finish." };
  const parts = message?.parts ?? [];
  const lastStep = parts.findLastIndex(p => p.type === "step-start");
  const timing = run.startedAt && run.finishedAt ? { startedAt: run.startedAt.toISOString(), finishedAt: run.finishedAt.toISOString() } : {};
  return { ...base, ...timing, status: "done", answer: parts.slice(Math.max(0, lastStep)).map(p => p.type === "text" ? p.text : "").join("").trim() };
}

export async function* runDelegation(ctx: AgentCtx, receiverId: string, prompt: string, toolCallId: string, signal?: AbortSignal, authorizationMode: "manual" | "coordinator" = "manual"): AsyncGenerator<DelegationResult> {
  signal?.throwIfAborted();
  const { task, created } = await admitDelegation(ctx, receiverId, prompt, toolCallId, runHost().instanceId, "sync", authorizationMode);
  const streamStop = new AbortController();
  const execution = (created ? executeInline(task, ctx, signal) : Promise.resolve()).catch(err => {
    console.error(`[delegation] task ${task.id}: finalization failed`, err);
    streamStop.abort(new Error("The task was interrupted before its result could be saved."));
  });
  // Always observe the committed child. Repeated invocations attach, never execute another child.
  const run = await getRun(task.childRunId!);
  const head = await resultHead(task);
  let lastSteps = "";
  if (run?.status === "running") {
    yield { ...head, status: "working", steps: [] };
    try {
      const stream = tailRun(run.id, { afterSeq: 0, targetSegment: 0, replay: true, authorize: async () => { signal?.throwIfAborted(); streamStop.signal.throwIfAborted(); await assertTaskExecution(task); } });
      for await (const message of readUIMessageStream<PortalUIMessage>({ stream, terminateOnError: false })) {
        const steps = stepsOf(message), key = JSON.stringify(steps);
        if (key !== lastSteps) { lastSteps = key; yield { ...head, status: "working", steps }; }
      }
    } catch { /* The authoritative result below explains cancellation/failure. */ }
  }
  await execution;
  try {
    signal?.throwIfAborted();
    streamStop.signal.throwIfAborted();
    await assertTaskExecution(task);
    yield await taskResult(task);
  } catch (err) {
    yield { ...head, status: "error", steps: [], error: safeError(err) };
  }
}
