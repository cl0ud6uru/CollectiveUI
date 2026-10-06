import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { db } from "@/db";
import { agentRuns, liveActivities, mobileSessions } from "@/db/schema";
import { encrypt, sha256Hex } from "@/lib/crypto";
import { getOwnedConversation, getUsableBot, HttpError } from "@/lib/authz";
import type { Principal } from "@/lib/auth/groups";
import type { MobileSession } from "@/lib/auth/mobile";
import { ACTIVITY_TTL_MS, contentFor, MAX_ACTIVITIES, terminal, type Registration } from "./protocol";

export const tokenAAD = (sessionId: string, activityId: string) => `live_activities.token_enc|${sessionId}|${activityId}`;

export async function runForActivity(p: Principal, conversationId: string, runId?: string) {
  const conversation = await getOwnedConversation(p, conversationId);
  if (conversation.source !== "chat" || conversation.isGroup || !conversation.botId) throw new HttpError(404, "Activity unavailable");
  await getUsableBot(p, conversation.botId);
  const [run] = await db.select().from(agentRuns).where(and(
    eq(agentRuns.userId, p.user.id), eq(agentRuns.conversationId, conversationId), eq(agentRuns.executionMode, "worker"),
    ...(runId ? [eq(agentRuns.id, runId)] : []),
  )).orderBy(desc(agentRuns.createdAt)).limit(1);
  if (!run || run.botId !== conversation.botId) throw new HttpError(404, "Activity unavailable");
  return run;
}

/** Rechecks ownership even when registration races a run finishing. A finished run may register for its final push. */
export async function registerActivity(p: Principal, session: MobileSession, input: Registration) {
  if (session.userId !== p.user.id) throw new HttpError(401, "Unauthorized");
  const [candidate] = await db.select({ conversationId: agentRuns.conversationId }).from(agentRuns)
    .where(and(eq(agentRuns.id, input.runId), eq(agentRuns.userId, p.user.id)));
  if (!candidate) throw new HttpError(404, "Activity unavailable");
  const run = await runForActivity(p, candidate.conversationId, input.runId);
  const tokenHash = sha256Hex(`activity-token|${input.pushToken}`);
  await db.transaction(async (tx) => {
    // Session row lock serializes registrations, delivery and logout. No client-provided device/owner/environment/topic.
    const [current] = await tx.select().from(mobileSessions).where(and(eq(mobileSessions.id, session.id),
      eq(mobileSessions.userId, p.user.id), isNull(mobileSessions.revokedAt), gt(mobileSessions.expiresAt, new Date()))).for("update");
    if (!current || current.sessionVersion !== p.user.sessionVersion) throw new HttpError(401, "Unauthorized");
    const [existing] = await tx.select().from(liveActivities)
      .where(and(eq(liveActivities.sessionId, session.id), eq(liveActivities.activityId, input.activityId)));
    if (existing && (existing.runId !== run.id || existing.userId !== p.user.id)) throw new HttpError(409, "Activity registration conflict");
    if (existing && (existing.expiresAt <= new Date() || existing.endedAt)) throw new HttpError(410, "Activity ended");
    if (existing && input.tokenVersion < existing.tokenVersion) throw new HttpError(409, "Stale activity registration");
    if (existing && input.tokenVersion === existing.tokenVersion && existing.tokenHash !== tokenHash) throw new HttpError(409, "Stale activity registration");
    if (existing?.tokenHash === tokenHash) {
      if (input.tokenVersion > existing.tokenVersion) await tx.update(liveActivities).set({ tokenVersion: input.tokenVersion })
        .where(and(eq(liveActivities.sessionId, session.id), eq(liveActivities.activityId, input.activityId)));
      return;
    } // Retries don't reset delivery deduplication.
    const [bound] = await tx.select({ activityId: liveActivities.activityId }).from(liveActivities).where(eq(liveActivities.tokenHash, tokenHash));
    if (bound) throw new HttpError(409, "Activity registration conflict");
    if (!existing) {
      const rows = await tx.select({ activityId: liveActivities.activityId }).from(liveActivities).where(and(
        eq(liveActivities.sessionId, session.id), isNull(liveActivities.endedAt), gt(liveActivities.expiresAt, new Date())));
      if (rows.length >= MAX_ACTIVITIES || rows.some((r) => r.activityId === input.activityId)) throw new HttpError(429, "Activity limit reached");
    }
    const values = { tokenHash, tokenEnc: encrypt(input.pushToken, tokenAAD(session.id, input.activityId)), tokenVersion: input.tokenVersion,
      fingerprint: null, nextAttemptAt: new Date(), attempts: 0 };
    if (existing) await tx.update(liveActivities).set(values).where(and(eq(liveActivities.sessionId, session.id), eq(liveActivities.activityId, input.activityId)));
    else await tx.insert(liveActivities).values({ ...values, sessionId: session.id, activityId: input.activityId, userId: p.user.id,
      runId: run.id, expiresAt: new Date(Date.now() + ACTIVITY_TTL_MS) });
  });
  return { content: contentFor(run), ended: terminal(contentFor(run).phase) };
}

export async function removeActivities(userId: string, sessionId: string, activityId?: string) {
  await db.transaction(async (tx) => {
    await tx.select({ id: mobileSessions.id }).from(mobileSessions).where(eq(mobileSessions.id, sessionId)).for("update");
    await tx.delete(liveActivities).where(and(eq(liveActivities.userId, userId), eq(liveActivities.sessionId, sessionId),
      ...(activityId ? [eq(liveActivities.activityId, activityId)] : [])));
  });
}

/** A duplicate token across concurrently registering sessions cannot claim somebody else's subscription. */
export function registrationError(err: unknown): never {
  const cause = (err as { cause?: { code?: string } })?.cause ?? err as { code?: string };
  if (cause?.code === "23505") throw new HttpError(409, "Activity registration conflict");
  throw err;
}
