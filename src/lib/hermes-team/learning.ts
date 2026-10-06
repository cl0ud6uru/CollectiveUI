import { eq } from 'drizzle-orm';
import { db, type DbOrTx } from '@/db';
import { bots, conversations, hermesTeamChats } from '@/db/schema';
/** The durable context keeps old jobs native-only even after the bot definition changes. */
export async function teamUsesNativeLearning(conversationId: string, q: DbOrTx = db) {
  const [binding] = await q.select({ id: hermesTeamChats.conversationId }).from(hermesTeamChats).where(eq(hermesTeamChats.conversationId, conversationId));
  if (binding) return true;
  const [row] = await q.select({ team: bots.hermesTeam }).from(conversations).innerJoin(bots, eq(bots.id, conversations.botId)).where(eq(conversations.id, conversationId));
  return !!row?.team;
}
