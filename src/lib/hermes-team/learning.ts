import { eq } from 'drizzle-orm';
import { db, type DbOrTx, type Tx } from '@/db';
import { bots, conversations, hermesTeamChats } from '@/db/schema';
/** The durable context keeps old jobs native-only even after the bot definition changes. */
export async function teamUsesNativeLearning(conversationId: string, q: DbOrTx = db) {
  const [binding] = await q.select({ id: hermesTeamChats.conversationId }).from(hermesTeamChats).where(eq(hermesTeamChats.conversationId, conversationId));
  if (binding) return true;
  const [row] = await q.select({ team: bots.hermesTeam }).from(conversations).innerJoin(bots, eq(bots.id, conversations.botId)).where(eq(conversations.id, conversationId));
  return !!row?.team;
}

/**
 * Admit ordinary utility learning under the same bot row lock used by Team conversion.
 * The shared lock remains held through model/embedding work and persistence. Every body
 * query must use q; a second pooled client would escape this transaction (and block PGlite).
 */
export async function withNonTeamLearning<T>(conversationId: string, skip: T, work: (q: Tx) => Promise<T>, onSkip?: (q: Tx) => Promise<void>): Promise<T> {
  return db.transaction(async q => {
    const [conversation] = await q.select({ botId: conversations.botId }).from(conversations).where(eq(conversations.id, conversationId));
    if (conversation?.botId) await q.select({ id: bots.id }).from(bots).where(eq(bots.id, conversation.botId)).for('share');
    if (await teamUsesNativeLearning(conversationId, q)) { await onSkip?.(q); return skip; }
    return work(q);
  });
}
