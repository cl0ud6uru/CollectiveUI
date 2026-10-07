import type { Principal } from '@/lib/auth/groups';
import type { Bot } from '@/db/schema';
import type { TeamMode } from './types';
export const teamBotsEnabled = () => process.env.HERMES_TEAM_BOTS_ENABLED === '1';
/** Team instance ownership and admin oversight are never audience grants. */
export function teamAudienceAllows(p: Pick<Principal, 'user' | 'groupIds'>, bot: Pick<Bot, 'visibility' | 'ownerId'>, groupIds: string[], userIds: string[]) {
  if (p.user.disabled) return false;
  if (bot.visibility === 'org') return true;
  if (bot.visibility === 'private') return bot.ownerId === p.user.id;
  return userIds.includes(p.user.id) || groupIds.some(id => p.groupIds.includes(id));
}
export function teamModeAllows(p: Pick<Principal, 'user' | 'groupIds' | 'isAdmin'>, bot: Pick<Bot, 'visibility' | 'ownerId'>, audience: { groupIds: string[]; userIds: string[] }, maintainerIds: string[], mode: TeamMode) {
  return !p.user.disabled && (mode === 'admin' ? p.isAdmin && maintainerIds.includes(p.user.id) : teamAudienceAllows(p, bot, audience.groupIds, audience.userIds));
}
export function teamOwnerKey(userId: string, botId: string, mode: TeamMode) {
  return mode === 'admin' ? `team-admin:${botId}` : userId;
}
