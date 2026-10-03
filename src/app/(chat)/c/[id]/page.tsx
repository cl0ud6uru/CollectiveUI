import { and, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { SavedChat } from "@/components/chat/saved-chat";
import { db } from "@/db";
import { conversations } from "@/db/schema";
import { requirePagePrincipal } from "@/lib/session";

export default async function ConversationPage(props: PageProps<"/c/[id]">) {
  const p = await requirePagePrincipal();
  const { id } = await props.params;
  const [conv] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, id), eq(conversations.userId, p.user.id)));
  if (!conv) notFound();

  return <SavedChat key={conv.id} conversationId={conv.id} />;
}
