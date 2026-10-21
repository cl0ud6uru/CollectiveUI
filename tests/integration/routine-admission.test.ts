import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { Pool } from "pg";
import { routineFixtureURL } from "../fixtures/routines/disposable-database";
import { db, pool, schema } from "@/db";
import { getBoss, QUEUES } from "@/lib/jobs";
import { lockRoutineAdmission, MAX_ACTIVE_ROUTINE_RUNS_PER_USER, queueRoutineRun } from "@/lib/routines/admission";
import { executeRoutineRun, scheduleDueRoutines } from "@/lib/agent/routine-runner";
import { claimRun } from "@/lib/runs/state";
import { POST } from "@/app/api/routines/webhook/[id]/route";
import type { Principal } from "@/lib/auth/groups";
import { deleteRoutine, runRoutineNow, saveRoutine } from "@/app/(chat)/bots/actions";

const auth = vi.hoisted(() => ({ principal: null as Principal | null }));
vi.mock("@/lib/session", () => ({ requirePrincipal: async () => auth.principal }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const enabled = process.env.ROUTINE_ADMISSION_TEST === "1";
if (enabled) routineFixtureURL("admission"); // Pool constructors are lazy; guard before all connections and destructive queries.
const suite = enabled ? describe : describe.skip;
suite("bounded routine admission on real PostgreSQL and pg-boss", () => {
  let boss: Awaited<ReturnType<typeof getBoss>>;
  let owners: string[];
  let principals: Principal[];
  let appId: string;
  let a: typeof schema.routines.$inferSelect, b: typeof a, cron: typeof a, webhook: typeof a;
  const rows = () => db.select().from(schema.routineRuns).where(inArray(schema.routineRuns.routineId, [a.id, b.id, cron.id, webhook.id]));
  const manual = async (routine = a) => {
    auth.principal = principals.find(p => p.user.id === routine.ownerId)!;
    const { runId } = await runRoutineNow(routine.id);
    return { run: (await db.select().from(schema.routineRuns).where(eq(schema.routineRuns.id, runId)))[0] };
  };
  const hook = () => POST(new Request("http://fixture.invalid/api/routines/webhook/fixture", {
    method: "POST", headers: { authorization: "Bearer synthetic-only" }, body: '{"fixture":true}',
  }), { params: Promise.resolve({ id: webhook.id }) });

  beforeAll(async () => {
    boss = await getBoss();
    [ { id: appId } ] = await db.insert(schema.aiApps).values({ name: "Synthetic admission fixture", model: "never-execute", baseUrl: "http://127.0.0.1:1/v1" }).returning();
  });
  beforeEach(async () => {
    owners = [0, 1].map(i => `routine-admission-${process.pid}-${Date.now()}-${i}`);
    const users = await db.insert(schema.users).values(owners.map(id => ({ id, upn: `${id}@fixture.invalid`, name: id, authSource: "ldap" as const }))).returning();
    principals = users.map(user => ({ user, groupIds: [], isAdmin: false, canCreateBots: true }));
    auth.principal = principals[0];
    const bots = await db.insert(schema.bots).values(owners.map(ownerId => ({ ownerId, appId, name: "Synthetic admission fixture" }))).returning();
    const inserted = await db.insert(schema.routines).values([
      { ownerId: owners[0], botId: bots[0].id, name: "Manual A", prompt: "Never execute", triggerType: "cron", cron: "*/5 * * * *" },
      { ownerId: owners[1], botId: bots[1].id, name: "Manual B", prompt: "Never execute", triggerType: "cron", cron: "*/5 * * * *" },
      { ownerId: owners[0], botId: bots[0].id, name: "Cron A", prompt: "Never execute", triggerType: "cron", cron: "*/5 * * * *" },
      { ownerId: owners[0], botId: bots[0].id, name: "Webhook A", prompt: "Never execute", triggerType: "webhook", webhookSecret: "synthetic-only" },
    ]).returning();
    [a, b, cron, webhook] = inserted;
  });
  afterEach(async () => {
    // This database is exclusive to this opt-in suite. No workers or providers run.
    await boss.deleteAllJobs(QUEUES.routineRun);
    await boss.deleteAllJobs(QUEUES.agentRunBackground);
    await db.delete(schema.users).where(inArray(schema.users.id, owners));
  });
  afterAll(async () => { await boss?.stop({ graceful: false }); if (appId) await db.delete(schema.aiApps).where(eq(schema.aiApps.id, appId)); await pool.end(); });

  it("enforces frequency validation through the actual save action", async () => {
    const input = { id: a.id, botId: a.botId, name: a.name, prompt: a.prompt, triggerType: "cron" as const, timezone: "UTC", enabled: true, notifyEmail: false };
    for (const cron of ["* * * * * *", "0,1 * * * *", "*/7 * * * *"])
      await expect(saveRoutine({ ...input, cron })).rejects.toMatchObject({ status: 400 });
    expect((await db.select().from(schema.routines).where(eq(schema.routines.id, a.id)))[0].nextRunAt).toBeNull();
    await saveRoutine({ ...input, cron: "*/5 * * * *" });
    expect((await db.select().from(schema.routines).where(eq(schema.routines.id, a.id)))[0].nextRunAt).toBeInstanceOf(Date);
  });

  it("serializes simultaneous manual requests at the per-owner cap", async () => {
    const attempts = await Promise.allSettled(Array.from({ length: 24 }, () => manual()));
    expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(MAX_ACTIVE_ROUTINE_RUNS_PER_USER);
    for (const result of attempts) if (result.status === "rejected") expect(result.reason.status).toBe(429);
    const accepted = await rows();
    expect(accepted).toHaveLength(3);
    expect(accepted.every(run => run.status === "queued" && run.lastEnqueueAt != null)).toBe(true);
    expect(await boss.fetch(QUEUES.routineRun, { batchSize: 50 })).toHaveLength(3);
  });

  it.each(["queued", "running"] as const)("counts retained %s background work after each source routine is deleted", async status => {
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No HTTP or model requests are allowed in this fixture"));
    const retained: string[] = [];
    try {
      for (let n = 0; n < MAX_ACTIVE_ROUTINE_RUNS_PER_USER; n++) {
        auth.principal = principals[0];
        const name = `Retained ${status} source ${n}`;
        await saveRoutine({ botId: a.botId, name, prompt: "Never execute", triggerType: "cron", cron: "*/5 * * * *", timezone: "UTC", enabled: true, notifyEmail: false });
        const [source] = await db.select().from(schema.routines).where(and(eq(schema.routines.ownerId, a.ownerId), eq(schema.routines.name, name)));
        const { runId } = await runRoutineNow(source.id);
        // The routine runner creates a durable queued agent and its pg-boss job; no agent worker or model runs.
        await executeRoutineRun(runId);
        const [agent] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.routineRunId, runId));
        expect(agent).toMatchObject({ status: "queued", background: true, userId: a.ownerId });
        if (status === "running") expect(await claimRun(agent.id, "synthetic-retained-cap-fixture")).toMatchObject({ status: "running" });
        await deleteRoutine(source.id);
        expect(await db.select().from(schema.routineRuns).where(eq(schema.routineRuns.id, runId))).toHaveLength(0);
        expect((await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, agent.id)))[0]).toMatchObject({ routineRunId: null, status });
        retained.push(agent.id);
      }
      await expect(manual()).rejects.toMatchObject({ status: 429 });
      await manual(b); // Another owner retains independent capacity.
      await db.update(schema.agentRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(schema.agentRuns.id, retained[0]));
      await manual(); // Completing retained work frees exactly one slot.
      await expect(manual()).rejects.toMatchObject({ status: 429 });
    } finally {
      try { expect(network).not.toHaveBeenCalled(); }
      finally { network.mockRestore(); }
    }
  });

  it("counts a routine and its still-linked background agent only once", async () => {
    for (let n = 0; n < MAX_ACTIVE_ROUTINE_RUNS_PER_USER; n++) {
      const { run } = await manual();
      await executeRoutineRun(run.id);
    }
    expect(await rows()).toHaveLength(3);
    const agents = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.userId, a.ownerId));
    expect(agents).toHaveLength(3);
    expect(agents.every(agent => agent.routineRunId !== null && agent.background && agent.status === "queued")).toBe(true);
    await expect(manual()).rejects.toMatchObject({ status: 429 });
  });

  it("does not count ordinary chat, foreground, paused or finished orphan agents", async () => {
    const excluded = [
      { source: "chat", background: true, status: "queued" },
      { source: "routine", background: false, status: "queued" },
      { source: "routine", background: true, status: "waiting" },
      { source: "routine", background: true, status: "waiting_tasks" },
      { source: "routine", background: true, status: "succeeded" },
    ] as const;
    for (const sample of excluded) {
      const [conversation] = await db.insert(schema.conversations).values({ userId: a.ownerId, source: sample.source }).returning();
      await db.insert(schema.agentRuns).values({ userId: a.ownerId, conversationId: conversation.id, messageId: conversation.id, background: sample.background, status: sample.status });
    }
    await manual(); await manual(); await manual();
    await expect(manual()).rejects.toMatchObject({ status: 429 });
  });

  it("shares the cap across triggers and running work while another owner stays admissible", async () => {
    const first = await manual();
    await db.update(schema.routineRuns).set({ status: "running" }).where(eq(schema.routineRuns.id, first.run.id));
    expect((await hook()).status).toBe(202);
    await manual();
    expect((await hook()).status).toBe(429);
    const now = new Date();
    await db.update(schema.routines).set({ nextRunAt: new Date(+now - 1000) }).where(eq(schema.routines.id, cron.id));
    expect(await scheduleDueRoutines(now)).toBe(0);
    expect((await db.select().from(schema.routines).where(eq(schema.routines.id, cron.id)))[0].nextRunAt!.getTime()).toBeGreaterThan(+now);
    await manual(b);
    const flood = await Promise.allSettled(Array.from({ length: 20 }, () => manual()));
    expect(flood.every(result => result.status === "rejected" && result.reason.status === 429)).toBe(true);
    const accepted = await rows();
    expect(accepted.filter(run => run.routineId !== b.id)).toHaveLength(3);
    const jobs = await boss.fetch<{ runId: string }>(QUEUES.routineRun, { batchSize: 50 });
    expect(jobs).toHaveLength(4);
    expect(jobs.findIndex(job => job.data.runId === accepted.find(run => run.routineId === b.id)!.id)).toBeLessThanOrEqual(3);
  });

  it("serializes simultaneous manual, webhook and scheduler admission through the same owner fence", async () => {
    const now = new Date();
    await db.update(schema.routines).set({ nextRunAt: new Date(+now - 1000) }).where(eq(schema.routines.id, cron.id));
    const attempts = await Promise.allSettled([
      ...Array.from({ length: 12 }, () => manual()),
      ...Array.from({ length: 12 }, () => hook()),
      ...Array.from({ length: 8 }, () => scheduleDueRoutines(now)),
    ]);
    for (const attempt of attempts) if (attempt.status === "rejected") expect(attempt.reason.status).toBe(429);
    expect(await rows()).toHaveLength(3);
    expect(await boss.fetch(QUEUES.routineRun, { batchSize: 50 })).toHaveLength(3);
  });

  it("coalesces concurrent scheduler ticks and ticks while the same routine is queued or running", async () => {
    const now = new Date("2026-10-21T10:00:00Z");
    await db.update(schema.routines).set({ nextRunAt: new Date(+now - 1000) }).where(eq(schema.routines.id, cron.id));
    const counts = await Promise.all(Array.from({ length: 8 }, () => scheduleDueRoutines(now)));
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(1);
    expect(await scheduleDueRoutines(new Date(+now + 300_000))).toBe(0);
    const [first] = await rows();
    await db.update(schema.routineRuns).set({ status: "running" }).where(eq(schema.routineRuns.id, first.id));
    expect(await scheduleDueRoutines(new Date(+now + 600_000))).toBe(0);
    expect(await rows()).toHaveLength(1);
    await db.update(schema.routineRuns).set({ status: "succeeded" }).where(eq(schema.routineRuns.id, first.id));
    expect(await scheduleDueRoutines(new Date(+now + 900_000))).toBe(1);
    expect(await rows()).toHaveLength(2);
  });

  it("does not enqueue legacy seconds or frequent cron expressions and continues other routines", async () => {
    const now = new Date();
    await db.update(schema.routines).set({ cron: "* * * * * *", nextRunAt: new Date(+now - 1000) }).where(eq(schema.routines.id, a.id));
    await db.update(schema.routines).set({ cron: "0,1 * * * *", nextRunAt: new Date(+now - 1000) }).where(eq(schema.routines.id, cron.id));
    await db.update(schema.routines).set({ nextRunAt: new Date(+now - 1000) }).where(eq(schema.routines.id, b.id));
    expect(await scheduleDueRoutines(now)).toBe(1);
    expect((await rows()).map(run => run.routineId)).toEqual([b.id]);
    const invalid = await db.select().from(schema.routines).where(inArray(schema.routines.id, [a.id, cron.id]));
    expect(invalid.every(routine => routine.nextRunAt === null)).toBe(true);
  });

  it("does not admit a due occurrence at the short spring-DST boundary even when the future slot is safe", async () => {
    const now = new Date("2026-03-08T07:00:00Z");
    await db.update(schema.routines).set({ cron: "0,59 1,3 * * *", timezone: "America/New_York", nextRunAt: now }).where(eq(schema.routines.id, cron.id));
    expect(await scheduleDueRoutines(now)).toBe(0);
    expect(await rows()).toHaveLength(0);
    expect((await db.select().from(schema.routines).where(eq(schema.routines.id, cron.id)))[0].nextRunAt).toBeNull();
  });

  it("rejects an authenticated webhook paused while waiting for admission", async () => {
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const holder = db.transaction(async tx => {
      await lockRoutineAdmission(tx, a.ownerId);
      await tx.update(schema.routines).set({ enabled: false }).where(eq(schema.routines.id, webhook.id));
      entered(); await hold;
    });
    await ready;
    const request = queueRoutineRun({ routineId: webhook.id, ownerId: webhook.ownerId, trigger: "webhook", webhookSecret: webhook.webhookSecret });
    // Release without waiting for a second checkout, so this also proves pool=1.
    release(); await holder;
    await expect(request).rejects.toMatchObject({ status: 409 });
    expect(await rows()).toHaveLength(0);
  });

  it("does not let a caller admit another owner's routine", async () => {
    await expect(queueRoutineRun({ routineId: b.id, ownerId: a.ownerId, trigger: "manual" })).rejects.toMatchObject({ status: 404 });
    expect(await rows()).toHaveLength(0);
  });

  it("uses a database lock scoped to one owner and releases it at commit", async () => {
    // A separate real connection models another web process, including when the
    // application pool has a single client. Never hold that client while enqueueing.
    const otherProcess = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    const holder = await otherProcess.connect();
    let pending: ReturnType<typeof manual> | undefined;
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtextextended('routine-admission:' || $1, 0))", [a.ownerId]);
      await manual(b);
      let settled = false;
      pending = manual().finally(() => { settled = true; });
      await vi.waitFor(async () => {
        const waiting = await holder.query("SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory' AND NOT granted");
        expect(waiting.rows[0].count).toBe(1);
      });
      expect(settled).toBe(false);
      await holder.query("COMMIT");
      await pending;
      expect(await rows()).toHaveLength(2);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
      await pending;
      await otherProcess.end();
    }
  });

  it("releases capacity after completion, but retains durable acceptance on queue failure", async () => {
    await boss.deleteQueue(QUEUES.routineRun);
    try {
      const accepted = await Promise.all([manual(), manual(), manual()]);
      await expect(manual()).rejects.toMatchObject({ status: 429 });
      expect(await rows()).toHaveLength(3);
      await db.update(schema.routineRuns).set({ status: "failed" }).where(eq(schema.routineRuns.id, accepted[0].run.id));
      await manual();
      expect((await rows()).filter(run => ["queued", "running"].includes(run.status))).toHaveLength(3);
    } finally { await boss.createQueue(QUEUES.routineRun); }
  });
});
