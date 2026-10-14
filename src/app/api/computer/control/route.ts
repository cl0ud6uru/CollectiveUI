import { z } from "zod";
import { assertAuthOrigin } from "@/lib/auth/origin";
import { errorResponse, requirePrincipal } from "@/lib/session";
import { computerViewForConversation } from "@/lib/computer/access";
import { computerControl } from "@/lib/computer/client";
import { readComputerJson } from "@/lib/computer/http";
import { HttpError } from "@/lib/authz";

const bodySchema = z.object({ conversationId: z.string().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/), action: z.enum(["takeover", "release", "heartbeat"]) }).strict();

export async function POST(request: Request) {
  try {
    assertAuthOrigin(request.headers);
    const principal = await requirePrincipal();
    const parsed = bodySchema.safeParse(await readComputerJson(request, 1024));
    if (!parsed.success) throw new HttpError(400, "Invalid computer request.");
    const view = await computerViewForConversation(principal, parsed.data.conversationId);
    await view.authorize();
    const status = await computerControl(view, parsed.data.action, request.signal);
    return Response.json(status, { headers: { "Cache-Control": "private, no-store", Vary: "Cookie" } });
  } catch (error) { return errorResponse(error); }
}
