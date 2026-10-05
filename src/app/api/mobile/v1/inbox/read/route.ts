import { z } from "zod";
import { markInboxRead } from "@/app/(chat)/actions";
import { errorResponse, requirePrincipal } from "@/lib/session";

const Body = z.object({ id: z.string().min(1).max(64).optional() });

/** Marks one inbox item read, or all of them without an id. */
export async function POST(req: Request) {
  try {
    await requirePrincipal();
    const body = Body.safeParse(await req.json().catch(() => ({})));
    if (!body.success) return Response.json({ error: "Invalid request" }, { status: 400 });
    await markInboxRead(body.data.id);
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
