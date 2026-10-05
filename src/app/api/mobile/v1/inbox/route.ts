import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { inboxItems } from "@/db/schema";
import { errorResponse, requirePrincipal } from "@/lib/session";

/** Routine and task results and approval requests, newest first (the web Inbox page). */
export async function GET() {
  try {
    const p = await requirePrincipal();
    const items = await db.select().from(inboxItems).where(eq(inboxItems.userId, p.user.id)).orderBy(desc(inboxItems.createdAt)).limit(100);
    return Response.json({
      items: items.map((i) => ({
        id: i.id, kind: i.kind, title: i.title, body: i.body, conversationId: i.conversationId,
        createdAt: i.createdAt.toISOString(), read: !!i.readAt,
      })),
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
