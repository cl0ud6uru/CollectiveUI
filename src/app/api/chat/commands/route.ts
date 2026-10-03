import { z } from "zod";
import { revalidatePath } from "next/cache";
import { commandCatalog, executeHermesCommand, resolveCommandTarget } from "@/lib/chat/hermes-command-service";
import { CLIENT_ID_RE } from "@/lib/ids";
import { errorResponse, requirePrincipal } from "@/lib/session";

const Target = z.object({ conversationId: z.string().regex(CLIENT_ID_RE), appId: z.string().max(100).optional(), botId: z.string().max(100).optional() }).strict();
const Command = Target.extend({ text: z.string().min(1).max(2000), revision: z.number().int().nonnegative().optional(), newConversationId: z.string().regex(CLIENT_ID_RE).optional(), messageId: z.string().regex(CLIENT_ID_RE).optional() }).strict();
const fail = (err: unknown) => err instanceof z.ZodError ? Response.json({ error: "Invalid command request" }, { status: 400 }) : errorResponse(err);

export async function GET(req: Request) {
  try {
    const p = await requirePrincipal();
    const input = Target.parse(Object.fromEntries(new URL(req.url).searchParams));
    return Response.json(await commandCatalog(await resolveCommandTarget(p, input)), { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) { return fail(err); }
}

export async function POST(req: Request) {
  try {
    const p = await requirePrincipal();
    const input = Command.parse(await req.json());
    const result = await executeHermesCommand(p, input);
    if (result.navigateTo) revalidatePath("/", "layout");
    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) { return fail(err); }
}
