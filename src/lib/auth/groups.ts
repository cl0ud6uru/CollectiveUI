import { and, eq, inArray, or, sql } from "drizzle-orm";
import { db, type DbOrTx, type Tx } from "@/db";
import { groupMappings, groupMembers, groups, userExternalGroups, users, type User } from "@/db/schema";
import { teamBotsEnabled } from "@/lib/hermes-team/policy";

export type ExternalGroup = { externalId: string; displayName?: string };

export type SignInIdentity = {
  upn: string;
  name: string;
  email?: string;
  source: "entra" | "ldap";
  groups: ExternalGroup[];
};

/** Semicolon- or newline-separated list (LDAP DNs contain commas, so commas can't be the separator). */
const list = (v?: string) =>
  (v ?? "")
    .split(/[;\n]/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

/**
 * Upsert the user keyed on lower-cased UPN (so a hybrid user signing in via Entra or LDAP lands
 * on the same account) and replace their external group memberships for this source.
 */
export async function syncUserOnSignIn(identity: SignInIdentity, transaction?: Tx): Promise<User> {
  const upn = identity.upn.trim().toLowerCase();
  const sync = async (tx: Tx) => {
    const team = teamBotsEnabled() ? await import('@/lib/hermes-team/revocation') : undefined;
    const lockedBotIds = team ? await team.lockTeamAccessBots(tx) : [];
    const [user] = await tx
      .insert(users)
      .values({
        upn,
        name: identity.name || upn,
        email: identity.email?.toLowerCase() ?? (upn.includes("@") ? upn : null),
        authSource: identity.source,
        lastLoginAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [users.identityRealm, users.upn],
        set: {
          name: identity.name || upn,
          email: sql`coalesce(${identity.email?.toLowerCase() ?? null}, ${users.email})`,
          authSource: identity.source,
          lastLoginAt: new Date(),
        },
      })
      .returning();

    await tx
      .delete(userExternalGroups)
      .where(and(eq(userExternalGroups.userId, user.id), eq(userExternalGroups.source, identity.source)));
    const unique = new Map(identity.groups.map((g) => [g.externalId.toLowerCase(), g]));
    if (unique.size) {
      await tx.insert(userExternalGroups).values(
        [...unique.entries()].map(([externalId, g]) => ({
          userId: user.id,
          source: identity.source,
          externalId,
          displayName: g.displayName ?? null,
        })),
      );
    }
    if (team) await team.queueTeamPrincipalAccessReconciliation(tx, lockedBotIds, user.id, user.id);
    return user;
  };
  if (transaction) return sync(transaction);
  const user = await db.transaction(sync);
  if (teamBotsEnabled()) {
    const { reconcileTeamActorAccess } = await import('@/lib/hermes-team/revocation');
    await reconcileTeamActorAccess(user.id);
  }
  return user;
}

export type Principal = {
  user: User;
  groupIds: string[]; // portal group ids
  isAdmin: boolean;
  canCreateBots: boolean;
};

/** Resolve explicit and directory-derived portal groups and computed permissions. */
export async function resolvePrincipal(user: User, q: DbOrTx = db): Promise<Principal> {
  const ext = user.identityRealm === "local" ? [] : await q
    .select({ source: userExternalGroups.source, externalId: userExternalGroups.externalId })
    .from(userExternalGroups)
    .where(eq(userExternalGroups.userId, user.id));

  let portalGroups: { id: string; isAdmin: boolean; canCreateBots: boolean }[] = [];
  if (ext.length) {
    portalGroups = await q
      .selectDistinct({ id: groups.id, isAdmin: groups.isAdmin, canCreateBots: groups.canCreateBots })
      .from(groups)
      .innerJoin(groupMappings, eq(groupMappings.groupId, groups.id))
      .where(
        or(
          ...ext.map((e) =>
            and(eq(groupMappings.source, e.source), eq(sql`lower(${groupMappings.externalId})`, e.externalId)),
          ),
        ),
      );
  }

  const direct = await q.select({ id: groups.id, isAdmin: groups.isAdmin, canCreateBots: groups.canCreateBots })
    .from(groups).innerJoin(groupMembers, eq(groupMembers.groupId, groups.id)).where(eq(groupMembers.userId, user.id));
  portalGroups = [...new Map([...portalGroups, ...direct].map(g => [g.id, g])).values()];

  const adminUpns = list(process.env.ADMIN_UPNS);
  const adminGroups = list(process.env.ADMIN_GROUPS);
  const isAdmin =
    user.isAdmin ||
    (user.identityRealm !== "local" && adminUpns.includes(user.upn)) ||
    ext.some((e) => adminGroups.includes(e.externalId)) ||
    portalGroups.some((g) => g.isAdmin);

  return {
    user,
    groupIds: portalGroups.map((g) => g.id),
    isAdmin,
    canCreateBots: isAdmin || portalGroups.some((g) => g.canCreateBots),
  };
}

export async function loadPrincipal(userId: string, q: DbOrTx = db): Promise<Principal | null> {
  const [user] = await q.select().from(users).where(eq(users.id, userId));
  if (!user || user.disabled) return null;
  return resolvePrincipal(user, q);
}

export async function knownExternalGroups() {
  return db
    .selectDistinct({
      source: userExternalGroups.source,
      externalId: userExternalGroups.externalId,
      displayName: userExternalGroups.displayName,
    })
    .from(userExternalGroups)
    .orderBy(userExternalGroups.displayName)
    .limit(2000);
}

export async function usersInGroups(groupIds: string[]) {
  if (!groupIds.length) return [];
  const mapped = await db
    .selectDistinct({ userId: userExternalGroups.userId })
    .from(userExternalGroups)
    .innerJoin(
      groupMappings,
      and(eq(groupMappings.source, userExternalGroups.source), eq(groupMappings.externalId, userExternalGroups.externalId)),
    )
    .innerJoin(users, eq(users.id, userExternalGroups.userId))
    .where(and(inArray(groupMappings.groupId, groupIds), eq(users.identityRealm, "directory"), eq(users.disabled, false)));
  const direct = await db.selectDistinct({ userId: groupMembers.userId }).from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(and(inArray(groupMembers.groupId, groupIds), eq(users.disabled, false)));
  return [...new Map([...mapped, ...direct].map(u => [u.userId, u])).values()];
}
