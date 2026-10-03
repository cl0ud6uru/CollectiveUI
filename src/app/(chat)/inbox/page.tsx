import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { AlertTriangle, Bot, ShieldQuestion } from "lucide-react";
import { InboxActions, MarkAllRead } from "@/components/bots/inbox-actions";
import { PageFrame } from "@/components/page-frame";
import { db } from "@/db";
import { inboxItems } from "@/db/schema";
import { requirePagePrincipal } from "@/lib/session";
import { cn } from "@/lib/utils";

export default async function InboxPage() {
  const p = await requirePagePrincipal();
  const items = await db.select().from(inboxItems).where(eq(inboxItems.userId, p.user.id)).orderBy(desc(inboxItems.createdAt)).limit(100);
  return (
    <PageFrame title="Inbox" description={<>Results from your bots&apos; tasks and routines, and actions waiting for your approval.</>} actions={items.some((i) => !i.readAt) && <MarkAllRead />}>
      <div className="space-y-2">
        {items.map((i) => {
          const failed = i.kind === "routine_error" || i.kind === "task_error";
          const Icon = i.kind === "approval" ? ShieldQuestion : failed ? AlertTriangle : Bot;
          return (
            <div key={i.id} className={cn("flex gap-3 rounded-2xl border border-border p-4", !i.readAt && "bg-surface-2")}>
              <Icon className={cn("mt-0.5 h-5 w-5 shrink-0", i.kind === "approval" ? "text-warn" : failed ? "text-danger" : "text-accent")} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{i.title}</span>
                  {!i.readAt && <span className="h-2 w-2 rounded-full bg-accent" />}
                  <span className="ml-auto shrink-0 text-xs text-subtle">{i.createdAt.toLocaleString()}</span>
                </div>
                {i.body && <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-sm text-muted">{i.body}</p>}
                <div className="mt-2 flex items-center gap-3 text-sm">
                  {i.conversationId && (
                    <Link href={`/c/${i.conversationId}`} className="underline">
                      {i.kind === "approval" ? "Review in chat" : "Open conversation"}
                    </Link>
                  )}
                  <InboxActions id={i.id} unread={!i.readAt} />
                </div>
              </div>
            </div>
          );
        })}
        {!items.length && <div className="py-16 text-center text-muted">You&apos;re all caught up.</div>}
      </div>
    </PageFrame>
  );
}
