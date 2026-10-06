import { requireMobileSession, errorResponse } from "@/lib/session";
import { apnsConfig } from "@/lib/live-activities/apns";
import { contentFor } from "@/lib/live-activities/protocol";
import { runForActivity } from "@/lib/live-activities/store";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { principal } = await requireMobileSession();
    const run = await runForActivity(principal, (await ctx.params).id, new URL(req.url).searchParams.get("runId") ?? undefined);
    let backgroundUpdates = false;
    try { backgroundUpdates = !!apnsConfig(); } catch { /* Operator configuration never escapes. */ }
    return Response.json({ runId: run.id, conversationId: run.conversationId, botId: run.botId, content: contentFor(run), backgroundUpdates },
      { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) { return errorResponse(err); }
}
