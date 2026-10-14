import { errorResponse, requirePrincipal } from "@/lib/session";
import { computerViewForConversation } from "@/lib/computer/access";
import { computerStatusForView } from "@/lib/computer/viewer";
import { queryConversationId } from "@/lib/computer/http";

export async function GET(request: Request) {
  try {
    const principal = await requirePrincipal();
    const view = await computerViewForConversation(principal, queryConversationId(request));
    return Response.json(await computerStatusForView(view, request.signal), { headers: { "Cache-Control": "private, no-store", Vary: "Cookie" } });
  } catch (error) { return errorResponse(error); }
}
