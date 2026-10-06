import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { db, type DbOrTx } from '@/db';
import { bots, conversations, hermesTeamChats, hermesTeamProfiles, hermesTeamResourceStates } from '@/db/schema';
import type { Principal } from '@/lib/auth/groups';
import { HttpError } from '@/lib/authz';
import { authorizeTeam, reserveTeamProfile } from './store';
import type { TeamChatStatus, TeamMode } from './types';
/** A saved URL must not bypass Admin mode or private owner authorization. */
export async function authorizeTeamConversation(p: Principal, conversationId: string, q: DbOrTx = db) {
  const [row] = await q.select({ chat: hermesTeamChats, profile: hermesTeamProfiles, conversation: conversations })
    .from(hermesTeamChats).innerJoin(hermesTeamProfiles, eq(hermesTeamProfiles.id, hermesTeamChats.profileId))
    .innerJoin(conversations, eq(conversations.id, hermesTeamChats.conversationId)).where(eq(conversations.id, conversationId));
  if (!row || row.conversation.userId !== p.user.id || row.conversation.botId !== row.profile.botId || row.chat.mode !== row.profile.mode || row.conversation.source !== 'chat' || row.conversation.isGroup)
    throw new HttpError(404, 'Team conversation not found.');
  if (row.profile.mode === 'member' && row.profile.userId !== p.user.id) throw new HttpError(404, 'Team conversation not found.');
  const authorized = await authorizeTeam(p, row.profile.botId, row.chat.mode, q);
  return { ...authorized, ...row };
}
/** Mode changes always select/create another context, never mutate a private conversation. */
export async function openTeamConversation(p: Principal, botId: string, mode: TeamMode) {
  const profile = await reserveTeamProfile(p, botId, mode);
  return db.transaction(async tx => {
    await tx.select({ id: bots.id }).from(bots).where(eq(bots.id, botId)).for('update');
    const { bot } = await authorizeTeam(p, botId, mode, tx);
    const [existing] = await tx.select({ conversation: conversations }).from(hermesTeamChats)
      .innerJoin(conversations, eq(conversations.id, hermesTeamChats.conversationId))
      .where(and(eq(hermesTeamChats.profileId, profile.id), eq(conversations.userId, p.user.id), eq(conversations.archived, false)))
      .orderBy(desc(conversations.createdAt)).limit(1);
    if (existing) return { conversationId: existing.conversation.id, state: profile.state };
    const [created] = await tx.insert(conversations).values({ userId: p.user.id, botId, title: mode === 'admin' ? `${bot.name} · Admin mode` : bot.name }).returning();
    await tx.insert(hermesTeamChats).values({ conversationId: created.id, profileId: profile.id, mode });
    return { conversationId: created.id, state: profile.state };
  });
}
export async function teamChatStatus(p: Principal, botId: string, conversationId?: string): Promise<TeamChatStatus> {
  const context = conversationId ? await authorizeTeamConversation(p, conversationId) : undefined;
  if (context && context.profile.botId !== botId) throw new HttpError(404, 'Team conversation not found.');
  const mode = context?.chat.mode ?? 'member';
  const auth = context ?? await authorizeTeam(p, botId, mode).catch(async e => {
    if (!(e instanceof HttpError) || e.status !== 403 || conversationId) throw e;
    return authorizeTeam(p, botId, 'admin');
  });
  let canMaintain = false;
  try { await authorizeTeam(p, botId, 'admin'); canMaintain = true; } catch (e) { if (!(e instanceof HttpError) || e.status !== 403) throw e; }
  const [profile] = context ? [context.profile] : await db.select().from(hermesTeamProfiles)
    .where(and(eq(hermesTeamProfiles.botId, botId), eq(hermesTeamProfiles.mode, mode), mode === 'member' ? eq(hermesTeamProfiles.userId, p.user.id) : isNull(hermesTeamProfiles.userId)));
  const conflicts = profile ? await db.select({ id: hermesTeamResourceStates.packageId }).from(hermesTeamResourceStates)
    .where(and(eq(hermesTeamResourceStates.profileId, profile.id), eq(hermesTeamResourceStates.conflictRevision, auth.definition.publishedRevision))) : [];
  return { enabled: auth.definition.enabled, mode, canMaintain, state: profile?.state ?? 'preparing', installedRevision: profile?.installedRevision ?? null, publishedRevision: auth.definition.publishedRevision, conflictCount: conflicts.length };
}

/** Listing/search results must not leak revoked working history through snippets or previews. */
export async function filterTeamConversationViews<T>(p: Principal, rows: T[], idOf: (row: T) => string): Promise<T[]> {
  if (!rows.length) return rows;
  const contexts = await db.select({ id: hermesTeamChats.conversationId }).from(hermesTeamChats).where(inArray(hermesTeamChats.conversationId, rows.map(idOf)));
  const teamIds = new Set(contexts.map(c => c.id));
  const results = await Promise.all(rows.map(async row => {
    const conversationId = idOf(row);
    if (!teamIds.has(conversationId)) return { row, visible: true };
    try { await authorizeTeamConversation(p, conversationId); return { row, visible: true }; }
    catch (e) { if (e instanceof HttpError && (e.status === 403 || e.status === 404)) return { row, visible: false }; throw e; }
  }));
  return results.filter(r => r.visible).map(r => r.row);
}
