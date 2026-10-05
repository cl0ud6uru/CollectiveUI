import { z } from "zod";
import { archiveConversation, deleteConversation, renameConversation, setConversationPinned } from "@/app/(chat)/actions";
import { errorResponse, requirePrincipal } from "@/lib/session";

const Patch = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
}).strict();

/** Rename, pin or archive one of the person's chats (the same actions as the web sidebar). */
export async function PATCH(req: Request, ctx: RouteContext<"/api/mobile/v1/conversations/[id]">) {
  try {
    await requirePrincipal();
    const { id } = await ctx.params;
    const body = Patch.safeParse(await req.json().catch(() => null));
    if (!body.success) return Response.json({ error: "Invalid request" }, { status: 400 });
    const { title, pinned, archived } = body.data;
    if (title !== undefined) await renameConversation(id, title);
    if (pinned !== undefined) await setConversationPinned(id, pinned);
    if (archived !== undefined) await archiveConversation(id, archived);
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(_req: Request, ctx: RouteContext<"/api/mobile/v1/conversations/[id]">) {
  try {
    await requirePrincipal();
    await deleteConversation((await ctx.params).id);
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
