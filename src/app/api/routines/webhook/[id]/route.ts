import { eq } from "drizzle-orm";
import { db } from "@/db";
import { routines } from "@/db/schema";
import { openWebhookSecret } from "@/lib/routines";
import { queueRoutineRun } from "@/lib/routines/admission";
import { authenticateRoutineWebhook } from "@/lib/routines/webhook";
import { HttpError } from "@/lib/http-error";

/**
 * Inbound webhook trigger for a routine. Authenticate with either:
 *  - X-Portal-Signature: sha256=<HMAC-SHA256 of timestamp.deliveryId.rawBody>, with
 *    X-Portal-Timestamp (Unix seconds) and X-Portal-Delivery-Id, or
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
  let webhookDelivery;
  try {
    webhookDelivery = authenticateRoutineWebhook(req.headers, secret, raw);
  } catch (error) {
    if (error instanceof HttpError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }

  let payload: unknown = null;
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = { text: raw };
    }
  }
  try {
    const { run } = await queueRoutineRun({ routineId: routine.id, ownerId: routine.ownerId, trigger: "webhook", payload, webhookSecret: routine.webhookSecret, webhookDelivery });
    return Response.json({ ok: true, runId: run.id }, { status: 202 });
  } catch (error) {
    if (error instanceof HttpError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
}
