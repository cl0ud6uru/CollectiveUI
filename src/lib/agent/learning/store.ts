import { and, desc, eq, isNull, ne, or, sql } from "drizzle-orm";
import { db, type DbOrTx, type Tx } from "@/db";
import { bots, botLearnings, botLearningRevisions, type Skill } from "@/db/schema";
import type { Principal } from "@/lib/auth/groups";
import { canEditBot } from "@/lib/bots/service";
import { getAccessibleBot, HttpError } from "@/lib/authz";
import { getSetting } from "@/lib/settings";
import type { LearningView, LessonContent, LessonStatus } from "./types";
import { botUsesNativeLearning } from "@/lib/hermes-team/learning";

export const visibleLearningScope = (botId: string, userId: string) => and(
  eq(botLearnings.botId, botId), or(isNull(botLearnings.userId), eq(botLearnings.userId, userId)),
);

async function publishedLearning(row: typeof botLearnings.$inferSelect, q: DbOrTx = db) {
  if (row.status === "active") return row;
  if (row.status !== "pending") return null;
  const [approved] = await q.select().from(botLearningRevisions).where(and(eq(botLearningRevisions.learningId, row.id), eq(botLearningRevisions.status, "active"))).orderBy(desc(botLearningRevisions.version)).limit(1);
  return approved ? { ...row, content: approved.content, verification: approved.verification, version: approved.version, status: "active" as const } : null;
}

export async function learnedSkillsForBot(botId: string, userId: string, q: DbOrTx = db): Promise<Skill[]> {
  if (await botUsesNativeLearning(botId, q)) return [];
  const visible = await q.select().from(botLearnings).where(and(visibleLearningScope(botId, userId), ne(botLearnings.kind, "preference"))).orderBy(botLearnings.topic);
  const rows = (await Promise.all(visible.map(row => publishedLearning(row, q)))).filter(row => row !== null);
  return rows.map(row => ({
    id: row.id, botId, ownerId: row.userId ?? "", slug: `learned-${row.userId ? "personal" : "shared"}-${row.topic}`,
    ...row.content, version: row.version, createdAt: row.createdAt, updatedAt: row.updatedAt,
    description: `${row.userId ? "Personal" : "Shared bot"} learning: ${row.content.description}`,
  }));
}

export async function learningViews(p: Principal, botId: string): Promise<LearningView[]> {
  const bot = await getAccessibleBot(p, botId);
  if (await botUsesNativeLearning(botId)) return [];
  const rows = await db.select().from(botLearnings).where(visibleLearningScope(botId, p.user.id)).orderBy(desc(botLearnings.updatedAt));
  const shown = await Promise.all(rows.map(row => row.status === "pending" && row.userId !== p.user.id && !canEditBot(p, bot) ? publishedLearning(row) : row));
  return shown.filter(row => row !== null).map(row => ({
    id: row.id, kind: row.kind, pinned: row.pinned, useCount: row.useCount, lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    stale: row.kind === "procedure" && row.status === "active" && !row.pinned && Date.now() - Math.max(row.createdAt.getTime(), row.updatedAt.getTime(), row.lastUsedAt?.getTime() ?? 0) >= 14 * 86400000,
    scope: row.userId ? "user" : "bot", status: row.status, content: row.content,
    verification: row.verification, version: row.version, updatedAt: row.updatedAt.toISOString(),
    canManage: row.userId === p.user.id || (!row.userId && canEditBot(p, bot)),
  }));
}

export async function recordLearningRevision(tx: Tx, row: typeof botLearnings.$inferSelect, source?: { conversationId: string; runId: string }) {
  await tx.insert(botLearningRevisions).values({
    learningId: row.id, version: row.version, status: row.status, content: row.content, verification: row.verification,
    sourceConversationId: source?.conversationId, sourceRunId: source?.runId,
  });
}

async function manageableLearning(p: Principal, id: string, tx: Tx) {
  const [candidate] = await tx.select({ botId: botLearnings.botId }).from(botLearnings).where(eq(botLearnings.id, id));
  if (!candidate) throw new HttpError(404, "Learning not found.");
  await tx.select({ id: bots.id }).from(bots).where(eq(bots.id, candidate.botId)).for("share");
  if (await botUsesNativeLearning(candidate.botId, tx)) throw new HttpError(403, "This bot uses its native learning controls.");
  const [row] = await tx.select().from(botLearnings).where(eq(botLearnings.id, id)).for("update");
  if (!row) throw new HttpError(404, "Learning not found.");
  if (row.botId !== candidate.botId) throw new HttpError(409, "This learning changed. Refresh before trying again.");
  const bot = await getAccessibleBot(p, row.botId, tx);
  if (bot.executionMode === "service") throw new HttpError(403, "Service bots do not support learned procedures.");
  if (row.userId ? row.userId !== p.user.id : !canEditBot(p, bot)) throw new HttpError(403, "You cannot manage this learning.");
  return row;
}

/** Every human change is a new revision. A stale browser cannot overwrite a newer lesson. */
export async function changeLearning(p: Principal, id: string, expectedVersion: number, change: {
  status?: LessonStatus; content?: LessonContent; restoreVersion?: number; pinned?: boolean;
}) {
  return db.transaction(async tx => {
    const row = await manageableLearning(p, id, tx);
    if (row.version !== expectedVersion) throw new HttpError(409, "This learning changed. Refresh before trying again.");
    let content = change.content ?? row.content;
    let verification = row.verification;
    if (change.restoreVersion !== undefined) {
      const [previous] = await tx.select().from(botLearningRevisions).where(and(eq(botLearningRevisions.learningId, id), eq(botLearningRevisions.version, change.restoreVersion)));
      if (!previous) throw new HttpError(404, "Revision not found.");
      content = previous.content;
      verification = previous.verification;
    }
    let status = change.status ?? row.status;
    if (row.status === "pending" && change.status === "archived") {
      const [approved] = await tx.select().from(botLearningRevisions).where(and(eq(botLearningRevisions.learningId, row.id), eq(botLearningRevisions.status, "active"))).orderBy(desc(botLearningRevisions.version)).limit(1);
      if (approved) { content = approved.content; verification = approved.verification; status = "active"; }
    }
    const [next] = await tx.update(botLearnings).set({ content, verification, pinned: change.pinned ?? row.pinned, status, version: row.version + 1, updatedAt: new Date() }).where(eq(botLearnings.id, id)).returning();
    await recordLearningRevision(tx, next);
    return next.botId;
  });
}

export async function learningHistory(p: Principal, id: string) {
  return db.transaction(async tx => {
    await manageableLearning(p, id, tx);
    return tx.select({ version: botLearningRevisions.version, content: botLearningRevisions.content, verification: botLearningRevisions.verification, createdAt: botLearningRevisions.createdAt })
      .from(botLearningRevisions).where(eq(botLearningRevisions.learningId, id)).orderBy(desc(botLearningRevisions.version));
  });
}

export async function learningIsEnabled(p: Principal, q: DbOrTx = db) {
  const settings = await getSetting("tools", q);
  return settings.learningEnabled !== false && !settings.disabledTools.includes("skills") && p.user.prefs.learningEnabled !== false && p.user.prefs.memoryEnabled !== false;
}

/** Usage metadata never revises or rewrites a lesson. */
export async function recordLearnedSkillUse(botId: string, userId: string, id: string) {
  await db.transaction(async tx => {
    await tx.select({ id: bots.id }).from(bots).where(eq(bots.id, botId)).for("share");
    if (await botUsesNativeLearning(botId, tx)) return;
    await tx.update(botLearnings).set({ lastUsedAt: new Date(), useCount: sql`${botLearnings.useCount} + 1` })
      .where(and(eq(botLearnings.id, id), visibleLearningScope(botId, userId), sql`${botLearnings.status} in ('active', 'pending')`, ne(botLearnings.kind, "preference")));
  });
}

/** Preferences are always-on private memory, rather than on-demand procedure skills. */
export async function learnedPreferences(userId: string, botId: string, limit = 5, q: DbOrTx = db) {
  if (await botUsesNativeLearning(botId, q)) return [];
  const { loadPrincipal } = await import("@/lib/auth/groups");
  const p = await loadPrincipal(userId, q);
  if (!p || !(await learningIsEnabled(p, q))) return [];
  const rows = await q.select().from(botLearnings).where(and(eq(botLearnings.botId, botId), eq(botLearnings.userId, userId), eq(botLearnings.kind, "preference"), sql`${botLearnings.status} in ('active', 'pending')`)).orderBy(desc(botLearnings.updatedAt)).limit(limit);
  const published = (await Promise.all(rows.map(row => publishedLearning(row, q)))).filter(row => row !== null);
  return published.map(row => ({ id: row.id, content: `${row.content.description}\n${row.content.instructions}\n${row.content.boundaries}`.slice(0, 1500), pinned: row.pinned, botId }));
}
