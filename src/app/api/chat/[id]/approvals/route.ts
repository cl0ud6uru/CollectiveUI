import { z } from "zod";
import { pendingTaskApprovals, answerTaskApproval } from "@/lib/delegation/approvals";
import { hasBearer } from "@/lib/public-routes";
import { errorResponse, requirePrincipal } from "@/lib/session";

const answer = z.object({ runId: z.string().min(1).max(100), approvalId: z.string().min(1).max(2048), approved: z.boolean(), reason: z.string().max(500).optional() }).strict();
export async function GET(_req: Request, ctx: RouteContext<"/api/chat/[id]/approvals">) {
  try { return Response.json({ requests: await pendingTaskApprovals(await requirePrincipal(), (await ctx.params).id) }, { headers: { "Cache-Control": "private, no-store" } }); }
  catch (err) { return errorResponse(err); }
}
export async function POST(req: Request, ctx: RouteContext<"/api/chat/[id]/approvals">) {
  try {
    const p = await requirePrincipal();
    if (!hasBearer(req.headers.get("authorization")) && req.headers.get("origin") !== new URL(process.env.AUTH_URL || req.url).origin)
      return Response.json({ error: "Invalid origin" }, { status: 403 });
    const input = answer.safeParse(await req.json().catch(() => null));
    if (!input.success) return Response.json({ error: "Invalid approval response" }, { status: 400 });
    return Response.json(await answerTaskApproval(p, (await ctx.params).id, input.data));
  } catch (err) { return errorResponse(err); }
}
