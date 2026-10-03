import { eq } from "drizzle-orm";
import { expect, it } from "vitest";

// This test deliberately removes a queue to simulate admission failure; never run it on an app database.
const test = process.env.ROUTINE_QUEUE_TEST === "1" ? it : it.skip;
test("real pg-boss admission failure recovers the same routine exactly once", async () => {
  if (new URL(process.env.DATABASE_URL!).pathname !== "/collective_review_queue_test") throw new Error("Requires disposable collective_review_queue_test database");
  const { db, pool, schema } = await import("@/db");
  const { getBoss, QUEUES } = await import("@/lib/jobs");
  const { scheduleDueRoutines, executeRoutineRun } = await import("@/lib/agent/routine-runner");
  const { sweepRuns } = await import("@/lib/runs/sweeper");
  const stamp = `queue-${process.pid}-${Date.now()}`;
  const [user] = await db.insert(schema.users).values({ id: stamp, upn: `${stamp}@test.invalid`, name: stamp, authSource: "ldap" }).returning();
  const [app] = await db.insert(schema.aiApps).values({ name: stamp, model: "synthetic", baseUrl: "http://127.0.0.1:1/v1" }).returning();
  const boss = await getBoss();
  try {
    const [bot] = await db.insert(schema.bots).values({ ownerId: user.id, appId: app.id, name: stamp }).returning();
    const now = new Date();
    const [routine] = await db.insert(schema.routines).values({ ownerId: user.id, botId: bot.id, name: stamp, prompt: "synthetic", triggerType: "cron", cron: "* * * * *", nextRunAt: new Date(+now - 1000) }).returning();
    await boss.deleteQueue(QUEUES.routineRun);
    expect(await scheduleDueRoutines(now)).toBe(0);
    const [pending] = await db.select().from(schema.routineRuns).where(eq(schema.routineRuns.routineId, routine.id));
    expect(pending.status).toBe("queued");
    await boss.createQueue(QUEUES.routineRun);
    await sweepRuns({ startup: true });
    const jobs = await boss.fetch<{ runId: string }>(QUEUES.routineRun, { batchSize: 10 });
    expect(jobs.map(job => job.data.runId)).toEqual([pending.id]);
    await Promise.all([executeRoutineRun(pending.id), executeRoutineRun(pending.id)]);
    const runs = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.routineRunId, pending.id));
    expect(runs).toHaveLength(1);
    const background = await boss.fetch<{ runId: string }>(QUEUES.agentRunBackground, { batchSize: 10 });
    expect(background.map(job => job.data.runId)).toEqual([runs[0].id]);
    expect(await db.select().from(schema.conversations).where(eq(schema.conversations.userId, user.id))).toHaveLength(1);
    await boss.deleteJob(QUEUES.routineRun, jobs.map(job => job.id));
    await boss.deleteJob(QUEUES.agentRunBackground, background.map(job => job.id));
  } finally {
    await boss.createQueue(QUEUES.routineRun);
    await boss.stop({ graceful: false });
    await db.delete(schema.users).where(eq(schema.users.id, user.id));
    await db.delete(schema.aiApps).where(eq(schema.aiApps.id, app.id));
    await pool.end();
  }
}, 30_000);
