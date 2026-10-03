import Link from "next/link";
import { and, desc, eq } from "drizzle-orm";
import { StartSideChat } from "@/components/chat/start-side-chat";
import { PageFrame } from "@/components/page-frame";
import { db } from "@/db";
import { conversations } from "@/db/schema";
import { requirePagePrincipal } from "@/lib/session";

/** Owner-only history remains accessible even when bot access is revoked or the bot is disabled. */
export default async function BotChatsPage(props: PageProps<"/bots/[id]/chats">) {
  const p = await requirePagePrincipal();
  const { id } = await props.params;
  const sp = await props.searchParams;
  const page = typeof sp.page === "string" && /^\d{1,5}$/.test(sp.page) ? Math.max(1, Number(sp.page)) : 1;
  const rows = await db.select().from(conversations)
    .where(and(eq(conversations.userId, p.user.id), eq(conversations.botId, id)))
    .orderBy(desc(conversations.updatedAt), desc(conversations.id)).limit(51).offset((page - 1) * 50);
  return <PageFrame title="Chat history" description="Your conversations with this bot, including earlier chats, routine results, delegated tasks and archives.">
    <div className="mb-4 flex flex-wrap gap-4 text-sm">
      <Link prefetch={false} href={`/?bot=${encodeURIComponent(id)}`} className="underline">Open home chat</Link>
      <StartSideChat botId={id} className="flex items-center gap-1 underline" />
    </div>
    <div className="space-y-2">
      {rows.slice(0, 50).map((c) => <Link key={c.id} href={`/c/${c.id}`} className="flex items-center justify-between gap-3 rounded-xl border border-border p-4 hover:bg-hover">
        <span className="min-w-0 truncate">{c.title}</span>
        <span className="shrink-0 text-xs text-subtle">{c.archived ? "Archived" : c.isBotHome ? "Home" : c.source === "delegation" ? "Delegated task" : c.source === "routine" ? "Routine" : c.isGroup ? "Group" : "Side chat"}</span>
      </Link>)}
      {!rows.length && <p className="py-8 text-muted">No chats yet.</p>}
    </div>
    <div className="flex gap-4 py-4 text-sm">
      {page > 1 && <Link href={`/bots/${encodeURIComponent(id)}/chats?page=${page - 1}`} className="underline">Newer chats</Link>}
      {rows.length > 50 && <Link href={`/bots/${encodeURIComponent(id)}/chats?page=${page + 1}`} className="underline">Older chats</Link>}
    </div>
  </PageFrame>;
}
