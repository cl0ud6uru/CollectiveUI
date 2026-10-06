import { and, eq, isNull, lt, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentRuns, aiApps, botLearnings, bots, hermesTeamDefinitions, routines } from "@/db/schema";
import { loadPrincipal } from "@/lib/auth/groups";
import { getSetting } from "@/lib/settings";
import { learningIsEnabled, recordLearningRevision } from "./store";
import { botUsesNativeLearning } from "@/lib/hermes-team/learning";

/** Deterministic maintenance: no inference, deletion, or changes to authored skills/policies. */
export async function curateLearnedSkills(now = new Date()) {
  return db.transaction(async tx => {
    const settings = await getSetting("tools", tx);
    if (settings.learningEnabled === false || settings.learningMaintenanceEnabled === false || settings.learningRequireApproval === true || settings.disabledTools.includes("skills")) return 0;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('native-learning-curator'))`);
    const cutoff = new Date(now.getTime() - 30 * 86400000);
    const eligible = and(
      eq(botLearnings.status, "active"), eq(botLearnings.kind, "procedure"), eq(botLearnings.pinned, false),
      ...(settings.learningConsolidationEnabled ? [] : [lt(botLearnings.createdAt, cutoff), lt(botLearnings.updatedAt, cutoff), sql`(${botLearnings.lastUsedAt} is null or ${botLearnings.lastUsedAt} < ${cutoff})`]),
    );
    // Filter known native contexts before the bounded scan so retained Team lessons cannot
    // starve ordinary maintenance. Recheck after locking the bot before any lesson mutation.
    const candidates = await tx.select({ id: botLearnings.id, botId: botLearnings.botId }).from(botLearnings)
      .innerJoin(bots, eq(bots.id, botLearnings.botId)).innerJoin(aiApps, eq(aiApps.id, bots.appId))
      .where(and(eligible, eq(bots.enabled, true), eq(bots.hermesTeam, false), ne(bots.executionMode, "service"), ne(aiApps.provider, "hermes"),
        sql`not exists (select 1 from ${hermesTeamDefinitions} where ${hermesTeamDefinitions.botId} = ${bots.id})`))
      .orderBy(sql`${botLearnings.lastCuratedAt} asc nulls first`).limit(100);
    let archived = 0;
    for (const candidate of candidates) {
      const [bot] = await tx.select().from(bots).where(eq(bots.id, candidate.botId)).for("share");
      if (!bot?.enabled || bot.executionMode === "service" || await botUsesNativeLearning(candidate.botId, tx)) continue;
      const [app] = bot?.appId ? await tx.select().from(aiApps).where(eq(aiApps.id, bot.appId)) : [];
      if (!app || app.provider === "hermes") continue;
      const [row] = await tx.select().from(botLearnings).where(and(eq(botLearnings.id, candidate.id), eligible)).for("update", { skipLocked: true });
      if (!row) continue;
      await tx.update(botLearnings).set({ lastCuratedAt: now }).where(eq(botLearnings.id, row.id));
      if (row.userId) {
        const p = await loadPrincipal(row.userId, tx);
        if (!p || !(await learningIsEnabled(p, tx))) continue;
      }
      const [running] = await tx.select({ id: agentRuns.id }).from(agentRuns).where(and(eq(agentRuns.botId, row.botId), sql`${agentRuns.status} in ('queued', 'running', 'waiting', 'waiting_tasks')`)).limit(1);
      if (running) continue;
      const scheduled = await tx.select({ prompt: routines.prompt }).from(routines).where(eq(routines.botId, row.botId));
      const slug = `learned-${row.userId ? "personal" : "shared"}-${row.topic}`;
      // Preserve both current slash references and references saved before readable names shipped.
      if (scheduled.some(r => [slug, `learned-${row.id}`, row.content.name].some(name => r.prompt.includes(name)))) continue;
      let duplicateOf: string | null = null;
      if (settings.learningConsolidationEnabled) {
        const peers = await tx.select().from(botLearnings).where(and(eq(botLearnings.botId, row.botId), row.userId ? eq(botLearnings.userId, row.userId) : isNull(botLearnings.userId), eq(botLearnings.status, "active"), eq(botLearnings.kind, "procedure")));
        const body = (r: typeof row) => [r.content.description, r.content.instructions, r.content.expectedOutput, r.content.boundaries].join("\n").replace(/\r\n/g, "\n").trim();
        const preferred = peers.find(peer => peer.id !== row.id && body(peer) === body(row) && (peer.pinned || peer.createdAt < row.createdAt || (peer.createdAt.getTime() === row.createdAt.getTime() && peer.id < row.id)));
        duplicateOf = preferred?.content.name ?? null;
      }
      const unused = Math.max(row.createdAt.getTime(), row.updatedAt.getTime(), row.lastUsedAt?.getTime() ?? 0) < cutoff.getTime();
      if (!duplicateOf && !unused) continue;
      const [next] = await tx.update(botLearnings).set({ status: "archived", verification: duplicateOf ? `${row.verification}\nIdentical procedure consolidated into: ${duplicateOf}`.slice(0, 1000) : row.verification, version: row.version + 1, updatedAt: now }).where(eq(botLearnings.id, row.id)).returning();
      await recordLearningRevision(tx, next);
      archived++;
    }
    return archived;
  });
}
