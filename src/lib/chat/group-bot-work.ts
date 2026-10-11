import { eq, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { groupBotWork } from "@/db/schema";
import { newId } from "@/lib/ids";

export const GROUP_WORK_HEARTBEAT_MS = 10_000;
export const GROUP_WORK_LEASE_SECONDS = 30;
const expiresAt = () => sql`now() + ${GROUP_WORK_LEASE_SECONDS} * interval '1 second'`;

/** A lease belongs to one speaker invocation, never every member or every conversation for a bot. */
export async function beginGroupBotWork(input: { userId: string; conversationId: string; botId: string }) {
  const id = newId();
  await db.delete(groupBotWork).where(lte(groupBotWork.expiresAt, sql`now()`));
  await db.insert(groupBotWork).values({ id, ...input, expiresAt: expiresAt() });
  let closed = false;
  let pending: Promise<unknown> = Promise.resolve();
  const timer = setInterval(() => {
    if (closed) return;
    pending = pending.then(async () => {
      if (!closed) await db.update(groupBotWork).set({ expiresAt: expiresAt() }).where(eq(groupBotWork.id, id));
    }).catch(error => console.warn("[group] Could not renew bot activity lease", error));
  }, GROUP_WORK_HEARTBEAT_MS);
  timer.unref?.();
  return async () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    // Let an in-flight renewal finish before deletion; it cannot resurrect a completed invocation.
    await pending;
    await db.delete(groupBotWork).where(eq(groupBotWork.id, id))
      .catch(error => console.warn("[group] Could not clear bot activity lease; it will expire", error));
  };
}
