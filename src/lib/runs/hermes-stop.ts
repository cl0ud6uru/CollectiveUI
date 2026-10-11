import { isDockerHermes } from "@/lib/docker-hermes/policy";
import { bindingSchema } from "@/docker-hermes/types";
import { dockerCleanupFetch } from "@/lib/docker-hermes/client";
import { LOCAL_ORIGIN } from "@/lib/local-hermes/client";
/** Explicit conversation cancellation, including approval waits. Never interprets denial as cancellation. */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { agentRuns, aiApps, hermesRunContexts, messages, type AgentRun } from "@/db/schema";
import { rowToUIMessage, updateMessageParts } from "@/lib/chat/store";
import { getRun, stopRun } from "@/lib/llm/providers/hermes/client";
import { hermesTargetKey } from "@/lib/llm/providers/hermes/scope";
import { hermesTargetFor } from "@/lib/llm/resolve";
import { afterRunTransition } from "./hooks";
import { loadHermesRunContext } from "./hermes-context";
import { confirmHermesNonAdmission } from "./hermes-admission";
import { lockUserRuns } from "./lock";
import { notifyRun } from "./log";
import { closeOpenParts } from "./replay";
import { finalizeRunTx, requestCancelTx } from "./state";
import { OPEN_STATUSES } from "./types";
import { isManagedHermes } from "@/lib/hermes-provisioning/config";
import { isLocalHermes } from "@/lib/local-hermes/config";

const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);

/** Safe to retry after an interrupted request. The current connection must match the recorded run's binding. */
export async function reconcileHermesStop(run: Pick<AgentRun, "id" | "appId" | "status" | "segment" | "startedAt" | "userId" | "botId">, requestStop: boolean): Promise<string> {
  const context = await loadHermesRunContext(run.id);
  if (!context) return "Remote outcome unavailable for a reply created before command support. Check the Hermes operator console.";
  if (context.stopState === "confirmed") return "Hermes reply ended.";
  if (requestStop) await db.update(hermesRunContexts).set({ stopState: "pending" }).where(eq(hermesRunContexts.runId, run.id));
  if (!context.upstreamRunId) {
    if (await confirmHermesNonAdmission(run.id)) return "Request rejected before Hermes started.";
    if (run.status === "cancelled" && !run.startedAt && run.segment === 0) {
      await db.update(hermesRunContexts).set({ stopState: "confirmed" }).where(eq(hermesRunContexts.runId, run.id));
      return "Cancelled before Hermes started.";
    }
    return "Cancellation requested; upstream identity is not recorded yet. Retry /stop after the worker settles.";
  }
  const [app] = run.appId ? await db.select().from(aiApps).where(eq(aiApps.id, run.appId)) : [];
  if (app?.provider !== "hermes" || context.targetKey !== hermesTargetKey(app))
    return "Remote cancellation is unconfirmed because the Hermes connection changed. An admin must restore the original connection or stop the reply in Hermes.";
  try {
    const managed = isManagedHermes(app);
    if (managed && (!run.botId || !context.provisionId)) return "Remote cancellation needs the original managed profile binding. Ask an operator to reconcile it.";
    const docker = isDockerHermes(app) ? bindingSchema.parse(app.providerConfig.docker) : null;
    if (docker && (docker.ownerId !== run.userId || docker.botId !== run.botId)) return "Retained runtime ownership changed; cancellation needs operator reconciliation.";
    const { target } = docker ? { target: { baseUrl: LOCAL_ORIGIN, profile: docker.bindingId, apiKey: "", local: true,
      fetch: dockerCleanupFetch(docker.ownerId, docker.bindingId, context.upstreamRunId) } } : await hermesTargetFor(app, (managed || isLocalHermes(app)) && run.botId ? { userId: run.userId, botId: run.botId, provisionId: context.provisionId } : undefined);
    if (requestStop) await stopRun(target, context.upstreamRunId);
    const state = await getRun(target, context.upstreamRunId);
    if (TERMINAL.has(state.status)) {
      await db.update(hermesRunContexts).set({ stopState: "confirmed" }).where(eq(hermesRunContexts.runId, run.id));
      return `Hermes reply ended (${state.status}).`;
    }
    return "Cancellation requested; Hermes has not confirmed an ended state. Retry /stop or check /status.";
  } catch {
    return "Remote cancellation is unconfirmed: Hermes is unavailable or no longer knows the reply. Retry /stop; an operator may need to check Hermes.";
  }
}

/** Caller authorizes the conversation and its current target before invoking this internal service. */
export async function stopHermesConversation(userId: string, conversationId: string): Promise<string[]> {
  const closed = await db.transaction(async (tx) => {
    await lockUserRuns(tx, userId);
    const runs = await tx.select().from(agentRuns).where(and(eq(agentRuns.userId, userId), eq(agentRuns.conversationId, conversationId), inArray(agentRuns.status, [...OPEN_STATUSES]))).for("update");
    const results = [];
    for (const run of runs) {
      await tx.update(hermesRunContexts).set({ stopState: "pending" }).where(eq(hermesRunContexts.runId, run.id));
      await requestCancelTx(tx, run.id);
      if (run.status === "running") continue; // Its worker saves the partial under its lease.
      const [row] = await tx.select().from(messages).where(and(eq(messages.id, run.messageId), eq(messages.conversationId, conversationId))).for("update");
      const message = row ? closeOpenParts(rowToUIMessage(row), "cancelled", { deniedReason: "The user cancelled this reply." }) : null;
      const finished = await finalizeRunTx(tx, run.id, { status: ["queued", "waiting"] }, { status: "cancelled", closing: message?.chunks ?? [] });
      if (!finished) throw new Error("Cancelled reply changed while locked");
      if (message?.changed) await updateMessageParts(conversationId, message.message, {}, tx);
      await notifyRun(tx, { r: run.id, k: "c" });
      results.push({ run: finished, message: message?.message ?? null });
    }
    return { results, hadOpen: runs.length > 0, legacy: runs.some((r) => !!r.resumeState && r.status !== "running") };
  });
  for (const { run, message } of closed.results) {
    await afterRunTransition(run, "cancelled", message, null).catch((err) => console.warn("[runs] cancellation hooks failed", err));
  }
  const pending = await db.select({ run: agentRuns }).from(agentRuns).innerJoin(hermesRunContexts, eq(hermesRunContexts.runId, agentRuns.id))
    .where(and(eq(agentRuns.userId, userId), eq(agentRuns.conversationId, conversationId), eq(hermesRunContexts.stopState, "pending")));
  const lines = await Promise.all(pending.map(({ run }) => reconcileHermesStop(run, true)));
  if (closed.legacy && !pending.length) lines.push("An older approval was closed locally; check Hermes to confirm its reply stopped.");
  return [...new Set(lines.length ? lines : [closed.hadOpen ? "Stop requested. Use /status to check the reply." : "No unfinished reply in this chat."])];
}
