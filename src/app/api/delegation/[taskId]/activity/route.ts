import { taskActivity } from "@/lib/delegation/activity";
import { errorResponse, requirePrincipal } from "@/lib/session";

export async function GET(_req: Request, ctx: RouteContext<"/api/delegation/[taskId]/activity">) {
  try {
    const principal = await requirePrincipal();
    const { taskId } = await ctx.params;
    return Response.json(await taskActivity(principal, taskId), { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) { return errorResponse(err); }
}
