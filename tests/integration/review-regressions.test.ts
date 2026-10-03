import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Principal } from "@/lib/auth/groups";
import type { AgentCtx } from "@/lib/agent/types";
import { startMockLlm } from "./helpers/mock-llm";
import type { Tool } from "ai";
import type { Bot } from "@/db/schema";
import { newId } from "@/lib/ids";
import { newUsageScope } from "@/lib/llm";
import { runHost } from "@/lib/runs/host";

const mocks = vi.hoisted(() => ({
  principal: null as Principal | null,
  enqueue: vi.fn<(name: string, data: object, options?: object) => Promise<string | null>>(async () => null),
  enqueueRun: vi.fn(async () => "job"),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/session", () => ({ requirePrincipal: async () => mocks.principal }));
vi.mock("@/lib/jobs", async (original) => ({ ...(await original<typeof import("@/lib/jobs")>()), enqueue: mocks.enqueue, enqueueRun: mocks.enqueueRun }));

const suite = process.env.DATABASE_URL ? describe : describe.skip;
suite("verified review regressions (isolated Postgres, synthetic data)", () => {
  let alice: Principal, bob: Principal, ctx: AgentCtx;
  let mock: Awaited<ReturnType<typeof startMockLlm>>;
  let appId: string, groupId: string;
  const userIds: string[] = [];
  const stamp = `review-${process.pid}-${Date.now()}`;
  async function newBot(extra: Partial<Bot> = {}) {
    const { db, schema } = await import("@/db");
    return (await db.insert(schema.bots).values({ ownerId: alice.user.id, name: "Specialist", appId, visibility: "org", ...extra }).returning())[0];
  }
  async function rootContext(principal: Principal): Promise<AgentCtx> {
    const { db, schema } = await import("@/db");
    const [conversation] = await db.insert(schema.conversations).values({ userId: principal.user.id, botId: ctx.bot!.id }).returning();
    const [run] = await db.insert(schema.agentRuns).values({ userId: principal.user.id, conversationId: conversation.id,
      botId: ctx.bot!.id, appId, messageId: newId(), status: "running", holder: runHost().instanceId,
      heartbeatAt: new Date(), startedAt: new Date() }).returning();
    return { ...ctx, principal, conversationId: conversation.id, usage: newUsageScope({ runId: run.id, messageId: run.messageId }),
      execution: { holder: runHost().instanceId, deadlineAt: Date.now() + 60_000, segment: 0 } };
  }
  async function nestedContext(parent: AgentCtx, bot: Bot): Promise<AgentCtx> {
    const { db, schema } = await import("@/db");
    const { admitDelegation } = await import("@/lib/delegation/store");
    const { task } = await admitDelegation(parent, bot.id, "Synthetic nested context", newId(), runHost().instanceId);
    const [run] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, task.childRunId!));
    return { ...parent, bot, conversationId: task.childConversationId!, taskId: task.id, depth: task.depth,
      delegationPath: task.ancestry, usage: newUsageScope({ runId: run.id, messageId: run.messageId }) };
  }
  beforeAll(async () => {
    mock = await startMockLlm();
    const { db, schema } = await import("@/db");
    for (const name of ["alice", "bob"]) {
      const [user] = await db.insert(schema.users).values({ id: `${stamp}-${name}`, upn: `${stamp}-${name}@test.invalid`, name, authSource: "ldap" }).returning();
      userIds.push(user.id);
      const p = { user, groupIds: [], isAdmin: false, canCreateBots: true };
      if (name === "alice") alice = p; else bob = p;
    }
    const [app] = await db.insert(schema.aiApps).values({ name: stamp, model: "mock", baseUrl: `${mock.url}/v1`, isPublic: true, supportsTools: true }).returning();
    appId = app.id;
    const [group] = await db.insert(schema.groups).values({ name: stamp }).returning();
    groupId = group.id;
    const { getSetting } = await import("@/lib/settings");
    ctx = { principal: bob, app, bot: await newBot({ name: "Shared" }), conversationId: "synthetic", depth: 0, background: false, toolSettings: await getSetting("tools") };
    const [conv] = await db.insert(schema.conversations).values({ userId: bob.user.id, botId: ctx.bot!.id }).returning();
    ctx.conversationId = conv.id;
    mocks.principal = alice;
  });
  afterAll(async () => {
    const { db, pool, schema } = await import("@/db");
    await runHost().shutdown(2000);
    const { runListener } = await import("@/lib/runs/listener");
    await runListener().close();
    await db.delete(schema.usageEvents).where(inArray(schema.usageEvents.userId, userIds));
    await db.delete(schema.users).where(inArray(schema.users.id, userIds));
    if (appId) await db.delete(schema.aiApps).where(eq(schema.aiApps.id, appId));
    if (groupId) await db.delete(schema.groups).where(eq(schema.groups.id, groupId));
    await pool.end();
    mock?.stop();
  });

  it("does not discover private delegates through a shared bot", async () => {
    const { db, schema } = await import("@/db");
    const { getUsableBot } = await import("@/lib/authz");
    const { buildToolset } = await import("@/lib/agent/toolset");
    const secret = await newBot({ visibility: "private", instructions: "syntheticprivateknowledge" });
    await db.insert(schema.botDelegates).values({ botId: ctx.bot!.id, delegateBotId: secret.id });
    await expect(getUsableBot(bob, secret.id)).rejects.toMatchObject({ status: 403 });
    const ts = await buildToolset(ctx);
    expect(ts.delegates.map(b => b.id)).not.toContain(secret.id);
    expect(Object.values(ts.tools)).toHaveLength(0);
    expect((await buildToolset({ ...ctx, principal: alice })).delegates.map(b => b.id)).toContain(secret.id);
  });

  it("rolls back content and all relations when a group was deleted", async () => {
    const { db, schema } = await import("@/db");
    const { updateBot } = await import("@/app/(chat)/bots/actions");
    const bot = await newBot({ instructions: "old audience safe", visibility: "groups" });
    await db.insert(schema.botAccess).values({ botId: bot.id, groupId });
    await db.insert(schema.botTools).values({ botId: bot.id, toolKey: "knowledge", approval: "auto" });
    await expect(updateBot(bot.id, { name: "changed", appId, instructions: "new audience secret", visibility: "groups", groupIds: ["deleted-group"], tools: [], delegateIds: [], maxSteps: 10, starters: [] })).rejects.toThrow();
    expect((await db.select().from(schema.bots).where(eq(schema.bots.id, bot.id)))[0].instructions).toBe("old audience safe");
    expect(await db.select().from(schema.botAccess).where(eq(schema.botAccess.botId, bot.id))).toMatchObject([{ groupId }]);
    expect(await db.select().from(schema.botTools).where(eq(schema.botTools.botId, bot.id))).toHaveLength(1);
  });

  it("reports failed admission and the sweeper retries the same queued routine", async () => {
    const { db, schema } = await import("@/db");
    const { scheduleDueRoutines, executeRoutineRun } = await import("@/lib/agent/routine-runner");
    const { sweepRuns } = await import("@/lib/runs/sweeper");
    const now = new Date();
    const [routine] = await db.insert(schema.routines).values({ ownerId: alice.user.id, botId: ctx.bot!.id, name: stamp, prompt: "test", triggerType: "cron", cron: "* * * * *", nextRunAt: new Date(+now - 1000) }).returning();
    mocks.enqueue.mockResolvedValue(null);
    expect(await scheduleDueRoutines(now)).toBe(0);
    const runs = await db.select().from(schema.routineRuns).where(eq(schema.routineRuns.routineId, routine.id));
    expect(runs).toHaveLength(1);
    await db.update(schema.routineRuns).set({ createdAt: new Date(+now - 300_000) }).where(eq(schema.routineRuns.id, runs[0].id));
    mocks.enqueue.mockClear();
    mocks.enqueue.mockResolvedValue("recovered-job");
    await sweepRuns({ startup: true });
    expect(mocks.enqueue).toHaveBeenCalledWith("routine.run", { runId: runs[0].id }, expect.anything());
    await Promise.all(Array.from({ length: 8 }, () => executeRoutineRun(runs[0].id)));
    expect(await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.routineRunId, runs[0].id))).toHaveLength(1);
    expect(await db.select().from(schema.conversations).where(and(eq(schema.conversations.userId, alice.user.id), eq(schema.conversations.source, "routine")))).toHaveLength(1);
    expect(await scheduleDueRoutines(now)).toBe(0);
  });
  async function invoke(tool: Tool, task = "hello") {
    const execute = tool.execute as unknown as (input: { task: string }, opts: object) => AsyncIterable<{ status: string; answer?: string; error?: string }>;
    const results = [];
    for await (const result of execute({ task }, { toolCallId: newId(), messages: [], context: undefined })) results.push(result);
    return results;
  }

  it("checks group access again on execution, including membership, access, edge and disabled revocation", async () => {
    const { db, schema } = await import("@/db");
    const { buildToolset } = await import("@/lib/agent/toolset");
    const { loadPrincipal } = await import("@/lib/auth/groups");
    const target = await newBot({ visibility: "groups", name: "GroupSpecialist" });
    await db.insert(schema.botAccess).values({ botId: target.id, groupId });
    await db.insert(schema.botDelegates).values({ botId: ctx.bot!.id, delegateBotId: target.id });
    await db.insert(schema.groupMappings).values({ groupId, source: "ldap", externalId: stamp });
    const membership = { userId: bob.user.id, source: "ldap" as const, externalId: stamp };
    await db.insert(schema.userExternalGroups).values(membership);
    const principal = (await loadPrincipal(bob.user.id))!;
    const parent = await rootContext(principal);
    const entry = async () => (await buildToolset(parent)).entries.find(e => e.key === `delegate:${target.id}`)!.tool;
    const allowed = await entry();
    expect((await invoke(allowed)).at(-1)?.status).toBe("done");
    await db.delete(schema.userExternalGroups).where(eq(schema.userExternalGroups.userId, bob.user.id));
    expect(await invoke(allowed)).toEqual([expect.objectContaining({ status: "error", error: "You don't have access to this bot" })]);
    // Stale session principals cannot advertise a delegate after membership revocation either.
    expect((await buildToolset(parent)).delegates.map(b => b.id)).not.toContain(target.id);
    await db.insert(schema.userExternalGroups).values(membership);
    const withAccess = await entry();
    await db.delete(schema.botAccess).where(eq(schema.botAccess.botId, target.id));
    expect((await invoke(withAccess))[0].status).toBe("error");
    await db.insert(schema.botAccess).values({ botId: target.id, groupId });
    const withEdge = await entry();
    await db.delete(schema.botDelegates).where(eq(schema.botDelegates.delegateBotId, target.id));
    expect((await invoke(withEdge))[0].status).toBe("error");
    await db.insert(schema.botDelegates).values({ botId: ctx.bot!.id, delegateBotId: target.id });
    for (const id of [target.id, ctx.bot!.id]) {
      const tool = await entry();
      await db.update(schema.bots).set({ enabled: false }).where(eq(schema.bots.id, id));
      expect((await invoke(tool))[0].status).toBe("error");
      await db.update(schema.bots).set({ enabled: true }).where(eq(schema.bots.id, id));
    }
    const tool = await entry();
    await db.update(schema.users).set({ disabled: true }).where(eq(schema.users.id, bob.user.id));
    expect((await invoke(tool))[0].status).toBe("error");
    await db.update(schema.users).set({ disabled: false }).where(eq(schema.users.id, bob.user.id));
    // Every revoked invocation is rejected before another child can be admitted.
    expect(await db.select().from(schema.delegatedTasks).where(eq(schema.delegatedTasks.receiverBotId, target.id))).toHaveLength(1);
  });

  it("allows owner knowledge retrieval but does not expose private knowledge through nested delegation", async () => {
    const { db, schema } = await import("@/db");
    const { buildToolset } = await import("@/lib/agent/toolset");
    const middle = await newBot({ name: "Middle" });
    const secret = await newBot({ name: "Secret", visibility: "private" });
    const beyond = await newBot({ name: "Beyond depth limit" });
    await db.insert(schema.botDelegates).values([{ botId: ctx.bot!.id, delegateBotId: middle.id }, { botId: middle.id, delegateBotId: secret.id }]);
    await db.insert(schema.botDelegates).values({ botId: secret.id, delegateBotId: beyond.id });
    const [file] = await db.insert(schema.attachments).values({ userId: alice.user.id, filename: "private.txt", mediaType: "text/plain", storageKey: stamp, size: 1 }).returning();
    await db.insert(schema.knowledgeChunks).values({ botId: secret.id, attachmentId: file.id, chunkIndex: 0, content: "syntheticprivateknowledge restricted marker 4927" });
    await db.insert(schema.botTools).values({ botId: secret.id, toolKey: "knowledge" });
    // Both users enter through their own persisted root and admitted middle task.
    const ownerContext = await nestedContext(await rootContext(alice), middle);
    const sharedContext = await nestedContext(await rootContext(bob), middle);
    const owner = await buildToolset(ownerContext);
    const answer = await invoke(owner.entries.find(e => e.key === `delegate:${secret.id}`)!.tool, '[tool:search_knowledge {"query":"syntheticprivateknowledge"}]');
    expect(answer.at(-1)?.status).toBe("done");
    expect(JSON.stringify(answer)).toContain("restricted marker 4927");
    expect((await buildToolset(sharedContext)).delegates).toEqual([]);
    const deepest = await nestedContext(ownerContext, secret);
    expect(deepest.depth).toBe(2);
    expect((await buildToolset(deepest)).delegates).toEqual([]);
    const before = await buildToolset(ownerContext);
    await db.update(schema.bots).set({ ownerId: bob.user.id }).where(eq(schema.bots.id, secret.id));
    expect((await invoke(before.entries.find(e => e.key === `delegate:${secret.id}`)!.tool))[0].status).toBe("error");
  });

  it("concurrent edits keep instructions paired with tools, delegates and audience", async () => {
    const { db, schema } = await import("@/db");
    const { updateBot, createBot } = await import("@/app/(chat)/bots/actions");
    mocks.principal = alice;
    const [otherGroup] = await db.insert(schema.groups).values({ name: `${stamp}-other` }).returning();
    try {
      const bot = await newBot();
      const a = await newBot(), b = await newBot();
      const inputs = [
        { name: "first", appId, instructions: "first", visibility: "groups" as const, groupIds: [groupId], tools: [{ key: "knowledge", approval: "auto" as const }], delegateIds: [a.id], maxSteps: 10, starters: [] },
        { name: "second", appId, instructions: "second", visibility: "groups" as const, groupIds: [otherGroup.id], tools: [{ key: "fetch_url", approval: "ask" as const }], delegateIds: [b.id], maxSteps: 10, starters: [] },
      ];
      for (let i = 0; i < 8; i++) {
        await Promise.all(inputs.map(input => updateBot(bot.id, input)));
        const saved = (await db.select().from(schema.bots).where(eq(schema.bots.id, bot.id)))[0];
        const expected = inputs.find(input => input.instructions === saved.instructions)!;
        expect(await db.select().from(schema.botAccess).where(eq(schema.botAccess.botId, bot.id))).toMatchObject([{ groupId: expected.groupIds[0] }]);
        expect(await db.select().from(schema.botTools).where(eq(schema.botTools.botId, bot.id))).toMatchObject([{ toolKey: expected.tools[0].key, approval: expected.tools[0].approval }]);
        expect(await db.select().from(schema.botDelegates).where(eq(schema.botDelegates.botId, bot.id))).toMatchObject([{ delegateBotId: expected.delegateIds[0] }]);
      }
      const before = await db.select().from(schema.bots).where(eq(schema.bots.ownerId, alice.user.id));
      await expect(createBot({ ...inputs[0], name: "failed creation", groupIds: ["deleted-group"] })).rejects.toThrow();
      expect(await db.select().from(schema.bots).where(eq(schema.bots.ownerId, alice.user.id))).toHaveLength(before.length);
    } finally { await db.delete(schema.groups).where(eq(schema.groups.id, otherGroup.id)); }
  });

  it("claims schedules once under concurrency and recovers admission crashes across batch boundaries", async () => {
    const { db, schema } = await import("@/db");
    const { scheduleDueRoutines } = await import("@/lib/agent/routine-runner");
    const { sweepRuns } = await import("@/lib/runs/sweeper");
    const now = new Date();
    const [routine] = await db.insert(schema.routines).values({ ownerId: alice.user.id, botId: ctx.bot!.id, name: "concurrent", prompt: "test", triggerType: "cron", cron: "* * * * *", nextRunAt: new Date(+now - 1000) }).returning();
    mocks.enqueue.mockResolvedValue(null);
    await Promise.all(Array.from({ length: 12 }, () => scheduleDueRoutines(now)));
    expect(await db.select().from(schema.routineRuns).where(eq(schema.routineRuns.routineId, routine.id))).toHaveLength(1);
    const rows = await db.insert(schema.routineRuns).values(Array.from({ length: 205 }, () => ({ routineId: routine.id, trigger: "manual" as const }))).returning();
    mocks.enqueue.mockClear();
    await Promise.all([sweepRuns(), sweepRuns()]);
    await sweepRuns();
    const delivered = new Set(mocks.enqueue.mock.calls.map(call => (call[1] as { runId: string }).runId));
    expect(rows.every(r => delivered.has(r.id))).toBe(true);
    expect(mocks.enqueue.mock.calls.length).toBe(delivered.size);
    await db.delete(schema.routineRuns).where(inArray(schema.routineRuns.id, rows.map(r => r.id)));
  });

  it("failed manual/webhook admission remains durably accepted; poison configuration ends once", async () => {
    const { db, schema } = await import("@/db");
    const { runRoutineNow } = await import("@/app/(chat)/bots/actions");
    const { POST } = await import("@/app/api/routines/webhook/[id]/route");
    const { newWebhookSecret, openWebhookSecret } = await import("@/lib/routines");
    const { executeRoutineRun } = await import("@/lib/agent/routine-runner");
    const [routine] = await db.insert(schema.routines).values({ ownerId: alice.user.id, botId: ctx.bot!.id, name: "bad timezone", prompt: "test", triggerType: "webhook", timezone: "not-a-zone", webhookSecret: newWebhookSecret() }).returning();
    mocks.enqueue.mockResolvedValue(null);
    mocks.principal = alice;
    const manual = await runRoutineNow(routine.id);
    const response = await POST(new Request("http://localhost/api/routines/webhook/test", { method: "POST", headers: { authorization: `Bearer ${openWebhookSecret(routine.webhookSecret)}` }, body: '{}' }), { params: Promise.resolve({ id: routine.id }) });
    expect(response.status).toBe(202);
    const webhook = await response.json();
    expect(await db.select().from(schema.routineRuns).where(inArray(schema.routineRuns.id, [manual.runId, webhook.runId]))).toMatchObject([{ status: "queued" }, { status: "queued" }]);
    await Promise.all(Array.from({ length: 4 }, () => executeRoutineRun(manual.runId)));
    expect((await db.select().from(schema.routineRuns).where(eq(schema.routineRuns.id, manual.runId)))[0].status).toBe("failed");
    expect(await db.select().from(schema.inboxItems).where(eq(schema.inboxItems.routineRunId, manual.runId))).toHaveLength(1);
    expect(await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.routineRunId, manual.runId))).toHaveLength(0);
  });

  it("rolls back the scheduled claim when recording its durable outbox row fails", async () => {
    const { db, schema } = await import("@/db");
    const { scheduleDueRoutines } = await import("@/lib/agent/routine-runner");
    const now = new Date();
    const [routine] = await db.insert(schema.routines).values({ ownerId: alice.user.id, botId: ctx.bot!.id, name: "insert failure", prompt: "test", triggerType: "cron", cron: "* * * * *", nextRunAt: new Date(+now - 1000) }).returning();
    // An isolated test-only DB constraint injects a real insert failure after the schedule update.
    await db.execute(sql.raw(`ALTER TABLE routine_runs ADD CONSTRAINT review_reject_insert CHECK (routine_id <> '${routine.id}')`));
    try {
      await expect(scheduleDueRoutines(now)).rejects.toThrow();
      const [saved] = await db.select().from(schema.routines).where(eq(schema.routines.id, routine.id));
      expect(saved.nextRunAt).toEqual(routine.nextRunAt);
      expect(await db.select().from(schema.routineRuns).where(eq(schema.routineRuns.routineId, routine.id))).toHaveLength(0);
    } finally { await db.execute(sql`ALTER TABLE routine_runs DROP CONSTRAINT review_reject_insert`); }
    mocks.enqueue.mockRejectedValueOnce(new Error("crash after commit"));
    await expect(scheduleDueRoutines(now)).rejects.toThrow("crash after commit");
    const [recorded] = await db.select().from(schema.routineRuns).where(eq(schema.routineRuns.routineId, routine.id));
    expect(recorded.status).toBe("queued");
    const { sweepRuns } = await import("@/lib/runs/sweeper");
    mocks.enqueue.mockResolvedValue("recovered");
    await sweepRuns({ startup: true });
    expect(mocks.enqueue).toHaveBeenCalledWith("routine.run", { runId: recorded.id }, expect.anything());
  });

});
