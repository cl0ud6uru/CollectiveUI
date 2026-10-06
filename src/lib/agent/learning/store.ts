import { and, desc, eq, isNull, or } from "drizzle-orm";
import { db, type DbOrTx, type Tx } from "@/db";
import { botLearnings, botLearningRevisions, type Skill } from "@/db/schema";
import type { Principal } from "@/lib/auth/groups";
import { canEditBot } from "@/lib/bots/service";
import { getAccessibleBot, HttpError } from "@/lib/authz";
import { getSetting } from "@/lib/settings";
import type { LearningView, LessonContent, LessonStatus } from "./types";

export const visibleLearningScope = (botId: string, userId: string) => and(
  eq(botLearnings.botId, botId), or(isNull(botLearnings.userId), eq(botLearnings.userId, userId)),
);

export async function learnedSkillsForBot(botId: string, userId: string): Promise<Skill[]> {
  const rows = await db.select().from(botLearnings).where(and(visibleLearningScope(botId, userId), eq(botLearnings.status, "active"))).orderBy(botLearnings.topic);
  return rows.map(row => ({
    id: row.id, botId, ownerId: row.userId ?? "", slug: `learned-${row.id}`,
    ...row.content, version: row.version, createdAt: row.createdAt, updatedAt: row.updatedAt,
    description: `${row.userId ? "Personal" : "Shared bot"} learning: ${row.content.description}`,
  }));
}

export async function learningViews(p: Principal, botId: string): Promise<LearningView[]> {
  const bot = await getAccessibleBot(p, botId);
  const rows = await db.select().from(botLearnings).where(visibleLearningScope(botId, p.user.id)).orderBy(desc(botLearnings.updatedAt));
  return rows.filter(row => row.status !== "pending" || row.userId === p.user.id || canEditBot(p, bot)).map(row => ({
    id: row.id, scope: row.userId ? "user" : "bot", status: row.status, content: row.content,
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
  const [row] = await tx.select().from(botLearnings).where(eq(botLearnings.id, id)).for("update");
  if (!row) throw new HttpError(404, "Learning not found.");
  const bot = await getAccessibleBot(p, row.botId, tx);
  if (bot.executionMode === "service") throw new HttpError(403, "Service bots do not support learned procedures.");
  if (row.userId ? row.userId !== p.user.id : !canEditBot(p, bot)) throw new HttpError(403, "You cannot manage this learning.");
  return row;
}

/** Every human change is a new revision. A stale browser cannot overwrite a newer lesson. */
export async function changeLearning(p: Principal, id: string, expectedVersion: number, change: {
  status?: LessonStatus; content?: LessonContent; restoreVersion?: number;
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
    const [next] = await tx.update(botLearnings).set({ content, verification, status: change.status ?? row.status, version: row.version + 1, updatedAt: new Date() }).where(eq(botLearnings.id, id)).returning();
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
