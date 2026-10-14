import "server-only";
import { asc, count, eq, ilike, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { conversations, userExternalGroups, users } from "@/db/schema";
import type { Principal } from "@/lib/auth/groups";
import { HttpError } from "@/lib/authz";
import { ADMIN_PAGE_SIZE, containsPattern, pageWindow } from "./listing";

export async function listAdminUsers(principal: Principal, search: string, requested = 1) {
  if (!principal.isAdmin) throw new HttpError(403, "Admin only");
  const pattern = containsPattern(search);
  const where = search ? or(ilike(users.name, pattern), ilike(users.upn, pattern)) : undefined;
  const [{ total }] = await db.select({ total: count() }).from(users).where(where);
  const window = pageWindow(total, requested);
  // Grouped joins preserve user attribution. A raw correlated selection lets Drizzle's
  // single-table renderer strip users.id to id, which then binds to conversations.id.
  const chats = db.select({ userId: conversations.userId, total: count().as("chat_count") })
    .from(conversations).groupBy(conversations.userId).as("user_chats");
  const groups = db.select({ userId: userExternalGroups.userId, total: count().as("group_count") })
    .from(userExternalGroups).groupBy(userExternalGroups.userId).as("user_groups");
  const rows = await db.select({
    user: users,
    groupCount: sql<number>`coalesce(${groups.total}, 0)`.mapWith(Number),
    chats: sql<number>`coalesce(${chats.total}, 0)`.mapWith(Number),
  }).from(users).leftJoin(chats, eq(chats.userId, users.id)).leftJoin(groups, eq(groups.userId, users.id))
    .where(where).orderBy(sql`${users.lastLoginAt} desc nulls last`, asc(users.id))
    .limit(ADMIN_PAGE_SIZE).offset(window.offset);
  return { rows, window };
}
