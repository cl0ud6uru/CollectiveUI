import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentRuns, conversations, delegatedTasks, inboxItems } from "@/db/schema";
import type { Principal } from "@/lib/auth/groups";
import type { ConversationSummary } from "@/components/chat/types";
import { isFinal } from "@/lib/runs/types";

/** Only the human owner's saved task chats. No prompts, ancestry, errors or other users' work. */
export async function loadRecentTasks(p: Principal): Promise<ConversationSummary[]> {
  const rows = await db.select({
    id: conversations.id, title: conversations.title, pinned: conversations.pinned,
    folderId: conversations.folderId, botId: conversations.botId, appId: conversations.appId,
    source: conversations.source, updatedAt: conversations.updatedAt,
    status: agentRuns.status,
    read: sql<boolean>`exists (select 1 from ${inboxItems} where ${inboxItems.id} = 'task_' || ${delegatedTasks.id}
      and ${inboxItems.userId} = ${p.user.id} and ${inboxItems.conversationId} = ${conversations.id} and ${inboxItems.readAt} is not null)`,
  }).from(conversations)
    .innerJoin(delegatedTasks, and(eq(delegatedTasks.childConversationId, conversations.id), eq(delegatedTasks.userId, p.user.id)))
    .innerJoin(agentRuns, and(eq(agentRuns.id, delegatedTasks.childRunId), eq(agentRuns.conversationId, conversations.id), eq(agentRuns.userId, p.user.id)))
    .where(and(eq(conversations.userId, p.user.id), eq(conversations.source, "delegation"), eq(conversations.archived, false),
      // One entry: executing turn, then earliest queued turn, otherwise latest terminal turn.
      // A cancelled successor must never hide an earlier turn that is still working.
      sql`${delegatedTasks.id} = (select d.id from delegated_tasks d join agent_runs r on r.id = d.child_run_id
        where d.child_conversation_id = ${conversations.id} and d.user_id = ${p.user.id}
        order by case when r.status in ('running', 'waiting_tasks', 'waiting') then 0 when r.status = 'queued' then 1 else 2 end,
          case when r.status in ('queued', 'running', 'waiting_tasks', 'waiting') then d.turn end, d.turn desc limit 1)`))
    .orderBy(desc(conversations.updatedAt), desc(conversations.id)).limit(500);
  return rows.map(({ status, read, updatedAt, ...c }) => ({ ...c, updatedAt: updatedAt.toISOString(), taskActivity: { status, unread: isFinal(status) && !read } }));
}
