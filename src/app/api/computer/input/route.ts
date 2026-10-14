import { z } from "zod";
import { assertAuthOrigin } from "@/lib/auth/origin";
import { errorResponse, requirePrincipal } from "@/lib/session";
import { HttpError } from "@/lib/authz";
import { ComputerInputSchema } from "@/lib/computer/contracts";
import { computerViewForConversation } from "@/lib/computer/access";
import { computerInput } from "@/lib/computer/client";
import { readComputerJson } from "@/lib/computer/http";

const bodySchema = z.object({ conversationId: z.string().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/), input: ComputerInputSchema }).strict();

export async function POST(request: Request) {
  try {
    assertAuthOrigin(request.headers);
    const principal = await requirePrincipal();
    const parsed = bodySchema.safeParse(await readComputerJson(request, 20_000));
    if (!parsed.success) throw new HttpError(400, "Invalid computer input.");
    const view = await computerViewForConversation(principal, parsed.data.conversationId);
    await view.authorize();
    await computerInput(view, parsed.data.input, request.signal);
    return new Response(null, { status: 204, headers: { "Cache-Control": "private, no-store", Vary: "Cookie" } });
  } catch (error) { return errorResponse(error); }
}
