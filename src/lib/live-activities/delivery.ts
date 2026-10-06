import { and, asc, eq, isNull, lte, or } from "drizzle-orm";
import { db } from "@/db";
import { agentRuns, liveActivities, mobileSessions } from "@/db/schema";
import { mobileEnabled } from "@/lib/auth/config";
import { loadPrincipal } from "@/lib/auth/groups";
import { sessionState } from "@/lib/auth/session-state";
import { decrypt } from "@/lib/crypto";
import { getOwnedConversation, getUsableBot } from "@/lib/authz";
import { apnsConfig, sendActivity, type APNsConfig } from "./apns";
import { contentFor, fingerprint, terminal } from "./protocol";
import { tokenAAD } from "./store";

/** Durable polling of registered runs: independent of SSE/app lifetime, recoverable after worker restart.
 * Replicas serialize on the session then activity row. Monotonic timestamps preserve ordering across retries and restart.
 */
export async function deliverActivities(config: APNsConfig, send = sendActivity) {
  const scanTime = new Date();
  const candidates = await db.select({ sessionId: liveActivities.sessionId, activityId: liveActivities.activityId }).from(liveActivities)
    .where(or(lte(liveActivities.expiresAt, scanTime), and(isNull(liveActivities.endedAt), lte(liveActivities.nextAttemptAt, scanTime)))).orderBy(asc(liveActivities.nextAttemptAt)).limit(100);
  for (const id of candidates) {
    await db.transaction(async (tx) => {
      const [session] = await tx.select().from(mobileSessions).where(eq(mobileSessions.id, id.sessionId)).for("update");
      const [row] = await tx.select().from(liveActivities)
        .where(and(eq(liveActivities.sessionId, id.sessionId), eq(liveActivities.activityId, id.activityId))).for("update");
      if (!row) return;
      const now = new Date();
      const where = and(eq(liveActivities.sessionId, row.sessionId), eq(liveActivities.activityId, row.activityId));
      const purge = () => tx.delete(liveActivities).where(where);
      if (!session || row.expiresAt <= now || !mobileEnabled() || session.revokedAt || session.expiresAt <= now || session.userId !== row.userId) { await purge(); return; }
      const auth = await sessionState(row.userId, session.sessionVersion, session.authProvider, tx);
      const p = auth && !auth.mustChangePassword ? await loadPrincipal(row.userId, tx) : null;
      const [run] = await tx.select().from(agentRuns).where(and(eq(agentRuns.id, row.runId), eq(agentRuns.userId, row.userId)));
      if (!p || p.user.sessionVersion !== session.sessionVersion || !run || !run.botId) { await purge(); return; }
      try {
        const chat = await getOwnedConversation(p, run.conversationId, tx);
        if (chat.botId !== run.botId || chat.source !== "chat" || chat.isGroup) { await purge(); return; }
        await getUsableBot(p, run.botId, tx);
      } catch { await purge(); return; }
      if (row.endedAt || row.nextAttemptAt > now) return;
      const state = contentFor(run);
      const stamp = Math.max(Math.floor(Date.now() / 1000), row.deliveryTimestamp + 1);
      const same = row.fingerprint === fingerprint(state);
      if (same && row.deliveredAt && now.getTime() - row.deliveredAt.getTime() < 90_000) {
        await tx.update(liveActivities).set({ nextAttemptAt: new Date(now.getTime() + 15_000) }).where(where);
        return;
      }
      let result;
      try { result = await send(config, decrypt(row.tokenEnc, tokenAAD(row.sessionId, row.activityId)), state, stamp); }
      catch { result = "configuration-error" as const; }
      if (result === "invalid-token") { await purge(); return; }
      if (result === "delivered") {
        await tx.update(liveActivities).set({ fingerprint: fingerprint(state), deliveryTimestamp: stamp, deliveredAt: now,
          nextAttemptAt: new Date(now.getTime() + 15_000), attempts: 0, endedAt: terminal(state.phase) ? now : null }).where(where);
      } else {
        const attempts = Math.min(row.attempts + 1, 10);
        const delay = result === "configuration-error" ? 300_000 : Math.min(300_000, 15_000 * 2 ** attempts);
        await tx.update(liveActivities).set({ attempts, nextAttemptAt: new Date(now.getTime() + delay), deliveryTimestamp: stamp }).where(where);
      }
    });
  }
}

/** Config is loaded once per worker. A disabled/unconfigured service leaves foreground activities usable. */
export function startActivityDelivery() {
  let config: APNsConfig | null;
  try { config = apnsConfig(); }
  catch { console.error("[worker] Live Activity APNs configuration unavailable"); config = null; }
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      if (config) await deliverActivities(config);
      else await db.delete(liveActivities).where(lte(liveActivities.expiresAt, new Date()));
    }
    catch { console.error("[worker] Live Activity delivery unavailable"); }
    finally { running = false; }
  };
  void tick();
  const timer = setInterval(() => void tick(), 15_000);
  return () => clearInterval(timer);
}
