import { conversationSnapshot } from "@/lib/chat/snapshot";
import { errorResponse, requirePrincipal } from "@/lib/session";

export async function GET(_req: Request, ctx: RouteContext<"/api/chat/[id]">) {
  try {
    const p = await requirePrincipal();
    const { id } = await ctx.params;
    return Response.json(await conversationSnapshot(p, id), { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
