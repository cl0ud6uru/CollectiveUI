import { eq } from "drizzle-orm";
import { db } from "@/db";
import { conversations } from "@/db/schema";
import { HttpError } from "@/lib/authz";
import { CLIENT_ID_RE } from "@/lib/ids";
import { stopRunFor, stopRuns } from "@/lib/runs/store";
import { runConfig } from "@/lib/runs/types";
import { errorResponse, requirePrincipal } from "@/lib/session";

/**
 * Stop the conversation's reply: a queued one is cancelled at once, a running one is signalled (its worker aborts the
 * model and tools, then saves the partial reply). Replies waiting for an approval are left answerable. Group chats
 * have no runs (their Stop is the request closing), so this is a no-op for them.
 *
 * The body may name the message the reply answers (`{ messageId }`: the user message, or the assistant message of an
 * approval answer). Stop can be pressed before that reply's run exists (its request still being handled, or a new
 * chat not even created yet): then this waits briefly for it and stops it too.
 */
export async function POST(req: Request, ctx: RouteContext<"/api/chat/[id]/stop">) {
  try {
    const p = await requirePrincipal();
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => null)) as { messageId?: unknown } | null;
    const messageId = typeof body?.messageId === "string" && CLIENT_ID_RE.test(body.messageId) ? body.messageId : null;
    const load = async () => (await db.select().from(conversations).where(eq(conversations.id, id)))[0];
    let conv = await load();
    for (const deadline = Date.now() + runConfig().stopWaitMs; !conv && messageId && Date.now() < deadline; ) {
      await new Promise((r) => setTimeout(r, 200));
      conv = await load();
    }
    if (!conv || conv.userId !== p.user.id) throw new HttpError(404, "Conversation not found");
    const stopped = await stopRuns(p, conv.id);
    if (stopped.cancelled || stopped.signalled || !messageId || conv.isGroup) return Response.json(stopped);
    return Response.json(await stopRunFor(p, conv.id, messageId));
  } catch (err) {
    return errorResponse(err);
  }
}
