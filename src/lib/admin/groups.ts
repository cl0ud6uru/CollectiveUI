import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { groupMappings, groupMembers, groups, users } from "@/db/schema";
import { HttpError } from "@/lib/authz";
import { teamBotsEnabled } from "@/lib/hermes-team/policy";

export const GroupInput = z.object({
  id: z.string().optional(), name: z.string().trim().min(1).max(100), description: z.string().max(500).nullable().optional(),
  isAdmin: z.boolean(), canCreateBots: z.boolean(),
  mappings: z.array(z.object({ source: z.enum(["entra", "ldap"]), externalId: z.string().trim().min(1).max(500), displayName: z.string().max(200).nullable().optional() })).max(100),
  memberIds: z.array(z.string().min(1).max(100)).max(2000).optional(),
});
export type GroupInput = z.infer<typeof GroupInput>;

/** Called after admin authorization; all membership edits commit together. */
export async function savePortalGroup(raw: GroupInput, actorId: string) {
  const input = GroupInput.parse(raw);
  let teamBotIds: string[] = [];
  const groupId = await db.transaction(async tx => {
    const team = teamBotsEnabled() ? await import('@/lib/hermes-team/revocation') : undefined;
    const lockedBotIds = team ? await team.lockTeamAccessBots(tx) : [];
    const memberIds = input.memberIds === undefined ? undefined : [...new Set(input.memberIds)];
    if (memberIds?.length) {
      const found = await tx.select({ id: users.id }).from(users).where(inArray(users.id, memberIds));
      if (found.length !== memberIds.length) throw new HttpError(400, "One or more selected users no longer exist. Refresh and try again.");
    }
    const values = { name: input.name, description: input.description, isAdmin: input.isAdmin, canCreateBots: input.canCreateBots };
    const [group] = input.id
      ? await tx.update(groups).set(values).where(eq(groups.id, input.id)).returning({ id: groups.id })
      : await tx.insert(groups).values(values).returning({ id: groups.id });
    if (!group) throw new HttpError(404, "Group no longer exists");
    await tx.delete(groupMappings).where(eq(groupMappings.groupId, group.id));
    const mappings = [...new Map(input.mappings.map(m => [`${m.source}:${m.externalId.toLowerCase()}`, m])).values()];
    if (mappings.length) await tx.insert(groupMappings).values(mappings.map(m => ({ ...m, groupId: group.id, externalId: m.externalId.toLowerCase() })));
    // Older clients omit the new field; preserve individually assigned members.
    if (memberIds !== undefined) {
      await tx.delete(groupMembers).where(eq(groupMembers.groupId, group.id));
      if (memberIds.length) await tx.insert(groupMembers).values(memberIds.map(userId => ({ groupId: group.id, userId })));
    }
    if (team) teamBotIds = await team.queueTeamPrincipalAccessReconciliation(tx, lockedBotIds, actorId);
    return group.id;
  });
  if (teamBotIds.length) {
    const { reconcileTeamAccess } = await import('@/lib/hermes-team/revocation');
    for (const botId of teamBotIds) await reconcileTeamAccess(botId);
  }
  return groupId;
}

/** A cascading group deletion must revoke grants based on its removed membership/mappings. */
export async function deletePortalGroup(id: string, actorId: string) {
  const teamBotIds = await db.transaction(async tx => {
    const team = teamBotsEnabled() ? await import('@/lib/hermes-team/revocation') : undefined;
    const lockedBotIds = team ? await team.lockTeamAccessBots(tx) : [];
    await tx.delete(groups).where(eq(groups.id, id));
    return team ? team.queueTeamPrincipalAccessReconciliation(tx, lockedBotIds, actorId) : [];
  });
  if (teamBotIds.length) {
    const { reconcileTeamAccess } = await import('@/lib/hermes-team/revocation');
    for (const botId of teamBotIds) await reconcileTeamAccess(botId);
  }
}
