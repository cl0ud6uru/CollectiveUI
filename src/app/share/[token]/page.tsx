import { isPersonalHermesConversation } from "@/lib/docker-hermes/store";
import { stripTaskLinks } from "@/lib/delegation/receipts";
import { and, eq, isNull } from "drizzle-orm";
import { notFound } from "next/navigation";
import { SharedView } from "@/components/chat/shared-view";
import { db } from "@/db";
import { conversations, sharedLinks, users } from "@/db/schema";
import { loadMessageRows, pathTo, rowToUIMessage } from "@/lib/chat/store";
import { requirePagePrincipal } from "@/lib/session";
import { getSetting } from "@/lib/settings";

/** Read-only snapshot of a shared chat. Requires sign-in, so links stay inside the organization. */
export default async function SharedPage(props: PageProps<"/share/[token]">) {
  await requirePagePrincipal();
  const { token } = await props.params;
  const [link] = await db.select().from(sharedLinks).where(and(eq(sharedLinks.id, token), isNull(sharedLinks.revokedAt)));
  if (!link) notFound();
  const [conv] = await db.select().from(conversations).where(eq(conversations.id, link.conversationId));
  if (!conv || conv.source === "delegation" || await isPersonalHermesConversation(conv)) notFound();
  const [author] = await db.select({ name: users.name }).from(users).where(eq(users.id, link.createdBy));
  const path = pathTo(await loadMessageRows(conv.id), link.cutoffMessageId).map(r => rowToUIMessage({ ...r, parts: stripTaskLinks(r.parts as unknown[]) }));
  const branding = await getSetting("branding");
  return (
    <SharedView
      token={token}
      title={conv.title}
      author={author?.name ?? "Someone"}
      createdAt={link.createdAt.toISOString()}
      messages={path}
      appName={branding.appName}
    />
  );
}
