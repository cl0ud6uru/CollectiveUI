import { isDockerHermes } from "@/lib/docker-hermes/policy";
import { authorizeDockerStream } from "@/lib/docker-hermes/store";
import { resolveTurnTarget } from "@/lib/agent/target";
import { authorizeTaskRead, ownedTask } from "@/lib/delegation/view";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { conversations } from "@/db/schema";
import { HttpError } from "@/lib/authz";
import { sseResponse } from "@/lib/runs/sse";
import { resumableRun } from "@/lib/runs/store";
import { getRun } from "@/lib/runs/state";
import { tailRun } from "@/lib/runs/tail";
import { errorResponse, requirePrincipal } from "@/lib/session";
import { isTeamRuntimeApp } from '@/lib/agent/team-target';
import { authorizeTeamConversation } from '@/lib/hermes-team/conversations';

/**
 * Resume (useChat `resume`, after a reload): replays the conversation's current reply from its first event and keeps
 * tailing it until it ends or pauses. 204 when there is nothing to resume (the saved messages are all there is).
 */
export async function GET(req: Request, ctx: RouteContext<"/api/chat/[id]/stream">) {
  try {
    const p = await requirePrincipal();
    const { id } = await ctx.params;
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, id));
    if (!conv || conv.userId !== p.user.id) throw new HttpError(404, "Conversation not found");
    // Group chats run in the request; there is no run to resume.
    if (conv.isGroup) return new Response(null, { status: 204 });
    const requestedRun = conv.source === "delegation" ? new URL(req.url).searchParams.get("runId") : null;
    const run = requestedRun ? await getRun(requestedRun) : await resumableRun(conv.id);
    if (!run) return new Response(null, { status: 204 });
    if (run.conversationId !== conv.id || run.userId !== p.user.id) throw new HttpError(404, "Task not found.");
    let authorize: (() => Promise<void>) | undefined;
    if (conv.source === "delegation") {
      const { run: child } = await ownedTask(p, id, db, run.id);
      if (child.id !== run.id || !["queued", "running", "waiting_tasks"].includes(child.status)) return new Response(null, { status: 204 });
      authorize = () => authorizeTaskRead(p, id, run.id);
      await authorize();
    }
    if (conv.source === "chat" && conv.botId) {
      const { app } = await resolveTurnTarget(p, conv);
      if (isTeamRuntimeApp(app)) { authorize = async () => { await authorizeTeamConversation(p, conv.id); }; await authorize(); }
      else if (isDockerHermes(app)) { authorize = () => authorizeDockerStream(p, conv.botId!); await authorize(); }
    }
    // Transient chunks (title, notices) of the backlog are dropped; ones written after this point arrive live.
    return sseResponse(tailRun(run.id, { afterSeq: 0, targetSegment: run.segment, replay: true, liveAfterSeq: run.lastSeq, authorize }));
  } catch (err) {
    return errorResponse(err);
  }
}
