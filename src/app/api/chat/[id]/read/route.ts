import { assertAuthOrigin } from "@/lib/auth/origin";
import { assertRequestContentType } from "@/lib/auth/mutation-request";
import { z } from "zod";
import { markTaskRead } from "@/lib/delegation/read";
import { errorResponse, requirePrincipal } from "@/lib/session";

const observed = z.object({ runId: z.string().min(1).max(100), status: z.enum(["succeeded", "failed", "cancelled", "interrupted"]), lastSeq: z.number().int().nonnegative() });
export async function POST(req: Request, ctx: RouteContext<"/api/chat/[id]/read">) {
  try {
    const p = await requirePrincipal();
    assertAuthOrigin(req.headers);
    assertRequestContentType(req);
    const body = observed.safeParse(await req.json());
    if (!body.success) return Response.json({ error: "Invalid task snapshot" }, { status: 400 });
    await markTaskRead(p, (await ctx.params).id, body.data);
    return new Response(null, { status: 204 });
  } catch (err) { return errorResponse(err); }
}
