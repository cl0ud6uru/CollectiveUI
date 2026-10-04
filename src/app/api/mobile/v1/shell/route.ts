import { loadShell } from "@/lib/chat/shell";
import { errorResponse, requirePrincipal } from "@/lib/session";

/** The app's home screen: the same chats, bots, models and inbox count as the web sidebar. */
export async function GET() {
  try {
    const p = await requirePrincipal();
    const { user, branding, conversations, folders, apps, bots, inboxUnread } = await loadShell(p);
    return Response.json({ user, branding, conversations, folders, apps, bots, inboxUnread }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
