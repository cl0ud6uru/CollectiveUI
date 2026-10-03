import { eq } from "drizzle-orm";
import { db } from "@/db";
import { routineRuns, routines } from "@/db/schema";
import { hmacSha256Hex, safeEqual } from "@/lib/crypto";
import { enqueue, QUEUES } from "@/lib/jobs";
import { openWebhookSecret } from "@/lib/routines";

/**
 * Inbound webhook trigger for a routine. Authenticate with either:
 *  - X-Portal-Signature: sha256=<hex HMAC-SHA256 of the raw body using the routine secret>, or
 *  - Authorization: Bearer <routine secret>  (for tools that can't sign requests)
 */
export async function POST(req: Request, ctx: RouteContext<"/api/routines/webhook/[id]">) {
  const { id } = await ctx.params;
  const raw = await req.text();
  if (raw.length > 100_000) return Response.json({ error: "Payload too large" }, { status: 413 });
  const [routine] = await db.select().from(routines).where(eq(routines.id, id));
  const secret = routine?.triggerType === "webhook" ? openWebhookSecret(routine.webhookSecret) : null;
  if (!routine || !secret) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  const sig = req.headers.get("x-portal-signature")?.replace(/^sha256=/, "") ?? "";
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const ok =
    (sig && safeEqual(sig, hmacSha256Hex(secret, raw))) || (bearer && safeEqual(bearer, secret));
  if (!ok) return Response.json({ error: "Invalid signature" }, { status: 401 });
  if (!routine.enabled) return Response.json({ error: "Routine is paused" }, { status: 409 });

  let payload: unknown = null;
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = { text: raw };
    }
  }
  const [run] = await db.insert(routineRuns).values({ routineId: routine.id, trigger: "webhook", payload, lastEnqueueAt: new Date() }).returning();
  // Accepted once recorded durably. Returning 503 here would invite a duplicate trigger even though
  // the sweeper will deliver this queued row (including after a lost queue acknowledgement).
  await enqueue(QUEUES.routineRun, { runId: run.id }, { singletonKey: run.id });
  return Response.json({ ok: true, runId: run.id }, { status: 202 });
}
