import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { groupMappings, groupMembers, groups, users } from "@/db/schema";
import { HttpError } from "@/lib/authz";

export const GroupInput = z.object({
  id: z.string().optional(), name: z.string().trim().min(1).max(100), description: z.string().max(500).nullable().optional(),
  isAdmin: z.boolean(), canCreateBots: z.boolean(),
  mappings: z.array(z.object({ source: z.enum(["entra", "ldap"]), externalId: z.string().trim().min(1).max(500), displayName: z.string().max(200).nullable().optional() })).max(100),
  memberIds: z.array(z.string().min(1).max(100)).max(2000).optional(),
});
export type GroupInput = z.infer<typeof GroupInput>;

/** Called after admin authorization; all membership edits commit together. */
export async function savePortalGroup(raw: GroupInput) {
  const input = GroupInput.parse(raw);
  return db.transaction(async tx => {
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
    return group.id;
  });
}
