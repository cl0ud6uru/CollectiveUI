import { and, eq, inArray } from "drizzle-orm";
import { db, type DbOrTx, type Tx } from "@/db";
import { agentRuns, hermesChatSettings, hermesRunContexts, type AiApp } from "@/db/schema";
import { HttpError } from "@/lib/authz";
import { allowedHermesModels, hermesTargetKey } from "@/lib/llm/providers/hermes/scope";
import { OPEN_STATUSES } from "./types";

/** Caller holds lockUserRuns: a setting change/new session must never race a run admission or approval. */
export async function assertHermesIdle(tx: Tx, conversationId: string, busyMessage = "This chat has an unfinished reply or approval. Use /stop, then try again when /status shows it has ended.") {
  const [open] = await tx.select({ id: agentRuns.id }).from(agentRuns)
    .where(and(eq(agentRuns.conversationId, conversationId), inArray(agentRuns.status, [...OPEN_STATUSES]))).limit(1);
  if (open) throw new HttpError(409, busyMessage);
  const [pending] = await tx.select({ id: agentRuns.id }).from(agentRuns)
    .innerJoin(hermesRunContexts, eq(hermesRunContexts.runId, agentRuns.id))
    .where(and(eq(agentRuns.conversationId, conversationId), eq(hermesRunContexts.stopState, "pending"))).limit(1);
  if (pending) throw new HttpError(409, "Hermes cancellation is not confirmed. Use /stop to retry or /status to check before continuing.");
}

export async function hermesSettings(conversationId: string, connection: DbOrTx = db) {
  const [row] = await connection.select().from(hermesChatSettings).where(eq(hermesChatSettings.conversationId, conversationId));
  return row ?? null;
}

export async function snapshotHermesSettings(tx: Tx, app: AiApp, conversationId: string) {
  await assertHermesIdle(tx, conversationId);
  const settings = await hermesSettings(conversationId, tx);
  const targetKey = hermesTargetKey(app);
  if (settings?.model && (settings.targetKey !== targetKey || !allowedHermesModels(app).includes(settings.model)))
    throw new HttpError(409, "This chat's requested model is no longer allowed for this connection. Use /model default to clear it.");
  return { targetKey, model: settings?.model ?? null };
}

export async function loadHermesRunContext(runId: string) {
  const [row] = await db.select().from(hermesRunContexts).where(eq(hermesRunContexts.runId, runId));
  return row;
}
