import { revalidatePath } from "next/cache";
import { z } from "zod";
import { openBotHome } from "@/lib/chat/home";
import { openSideChat } from "@/lib/chat/side";
import { newId } from "@/lib/ids";
import { errorResponse, requirePrincipal } from "@/lib/session";

const Body = z.object({ kind: z.enum(["home", "side"]).default("home") });

/** Opens the bot's home chat (created on first use), or a new side chat with it. */
export async function POST(req: Request, ctx: RouteContext<"/api/mobile/v1/bots/[id]/chat">) {
  try {
    const p = await requirePrincipal();
    const { id } = await ctx.params;
    const body = Body.safeParse(await req.json().catch(() => ({})));
    if (!body.success || id.length > 64) return Response.json({ error: "Invalid request" }, { status: 400 });
    const conv = body.data.kind === "side" ? await openSideChat(p, id, newId()) : await openBotHome(p, id);
    revalidatePath("/", "layout");
    return Response.json({ conversationId: conv.id });
  } catch (err) {
    return errorResponse(err);
  }
}
