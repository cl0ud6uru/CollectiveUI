import { loadRecentTasks } from "@/lib/chat/recent-tasks";
import { errorResponse, requirePrincipal } from "@/lib/session";

export async function GET() {
  try {
    const p = await requirePrincipal();
    return Response.json(await loadRecentTasks(p), { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) { return errorResponse(err); }
}
