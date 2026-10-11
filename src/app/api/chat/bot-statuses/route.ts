import { botStatusSnapshot } from "@/lib/chat/bot-statuses";
import { errorResponse, requirePrincipal } from "@/lib/session";

export async function GET() {
  try {
    return Response.json(await botStatusSnapshot(await requirePrincipal()), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}
