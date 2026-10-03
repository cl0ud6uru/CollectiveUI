import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db, schema, pool } from "@/db";
import type { AgentCtx } from "@/lib/agent/types";
import { loadPrincipal } from "@/lib/auth/groups";
import { newId } from "@/lib/ids";
import { newUsageScope } from "@/lib/llm";
import { sealAppSecret } from "@/lib/llm/secrets";
import { getSetting } from "@/lib/settings";
import { insertMessage, loadMessageRows, pathTo } from "@/lib/chat/store";
import { conversationSnapshot } from "@/lib/chat/snapshot";
import { loadRecentTasks } from "@/lib/chat/recent-tasks";
import { admitDelegation } from "@/lib/delegation/store";
import { startAsyncDelegation, suspendForTasks } from "@/lib/delegation/async";
import { markTaskRead } from "@/lib/delegation/read";
import { authorizeTaskRead, taskView } from "@/lib/delegation/view";
import { claimRun, getRun } from "@/lib/runs/state";
import { executeRun } from "@/lib/runs/execute";
import { runHost } from "@/lib/runs/host";
import { runListener } from "@/lib/runs/listener";
import { abortQueuedRun, stopRuns } from "@/lib/runs/store";
import { appendEvents } from "@/lib/runs/log";
import { startMockLlm } from "./helpers/mock-llm";

vi.mock("@/lib/jobs", async original => ({ ...(await original<typeof import("@/lib/jobs")>()),
  enqueueRun: vi.fn(async () => "local-job"), enqueue: vi.fn(async () => null), scheduleMemoryExtraction: vi.fn(async () => {}),
  getBoss: () => Promise.reject(new Error("No queue transport in follow-up integration tests")) }));
vi.mock("@/lib/llm/apps", async original => ({ ...(await original<typeof import("@/lib/llm/apps")>()), embeddingApp: async () => undefined }));

const suite = process.env.DATABASE_URL ? describe : describe.skip;
suite("related native delegation turns (Postgres and local model)", () => {
  let mock: Awaited<ReturnType<typeof startMockLlm>>;
  let owner: string, other: string, appId: string, sourceId: string, receiverId: string, nestedId: string;
  beforeAll(async () => {
    mock = await startMockLlm(); owner = newId(); other = newId(); appId = newId();
    await db.insert(schema.users).values([owner, other].map(id => ({ id, upn: `${id}@followup.test`, name: "Follow-up owner", authSource: "ldap" as const })));
    await db.insert(schema.aiApps).values({ id: appId, name: "Local follow-ups", provider: "openai", model: "mock-gpt", supportsTools: true, baseUrl: `${mock.url}/v1`, apiKeyEnc: sealAppSecret(appId, "test-only") });
    const bots = await db.insert(schema.bots).values(["Source", "Receiver", "Nested"].map(name => ({ name, appId, ownerId: owner, visibility: "org" as const }))).returning();
    [sourceId, receiverId, nestedId] = bots.map(b => b.id);
    await db.insert(schema.botDelegates).values([{ botId: sourceId, delegateBotId: receiverId }, { botId: receiverId, delegateBotId: nestedId }, { botId: sourceId, delegateBotId: nestedId }]);
    runHost().start();
  });
  afterEach(async () => {
    await db.delete(schema.conversations).where(inArray(schema.conversations.userId, [owner, other]));
    await db.delete(schema.delegatedTasks).where(inArray(schema.delegatedTasks.userId, [owner, other]));
    await db.insert(schema.botDelegates).values({ botId: sourceId, delegateBotId: receiverId }).onConflictDoNothing();
    await db.update(schema.aiApps).set({ provider: "openai", enabled: true }).where(eq(schema.aiApps.id, appId));
  });
  afterAll(async () => {
    await runHost().shutdown(2000); await runListener().close();
    await db.delete(schema.usageEvents).where(inArray(schema.usageEvents.userId, [owner, other]));
    await db.delete(schema.users).where(inArray(schema.users.id, [owner, other]));
    await db.delete(schema.aiApps).where(eq(schema.aiApps.id, appId));
    await pool.end(); mock?.stop();
  });
  async function context(conversationId?: string, userId = owner) {
    const principal = (await loadPrincipal(userId))!;
    const [bot] = await db.select().from(schema.bots).where(eq(schema.bots.id, sourceId));
    const [app] = await db.select().from(schema.aiApps).where(eq(schema.aiApps.id, appId));
    const [conversation] = conversationId ? await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId)) :
      await db.insert(schema.conversations).values({ userId, botId: sourceId, title: "Origin" }).returning();
    const promptId = newId();
    await insertMessage(conversation.id, { id: promptId, role: "user", parts: [{ type: "text", text: "Please continue the related work" }] }, conversation.currentLeafId);
    const [run] = await db.insert(schema.agentRuns).values({ userId, conversationId: conversation.id, botId: sourceId, appId, messageId: newId(), parentMessageId: promptId,
      status: "running", holder: runHost().instanceId, startedAt: sql`now()`, heartbeatAt: sql`now()` }).returning();
    const native = { deadlineAt: Date.now() + 120_000, sessionVersion: principal.user.sessionVersion, stepsUsed: 1, maxSteps: 20, taskIds: [] as string[] };
    const ctx: AgentCtx = { principal, bot, app, conversationId: conversation.id, depth: 0, background: false, toolSettings: await getSetting("tools"),
      usage: newUsageScope({ messageId: run.messageId, runId: run.id }), execution: { holder: runHost().instanceId, deadlineAt: native.deadlineAt, segment: 0 },
      awaitTask: id => { if (!native.taskIds.includes(id)) native.taskIds.push(id); } };
    async function checkpoint() {
      const tasks = await db.select().from(schema.delegatedTasks).where(eq(schema.delegatedTasks.parentRunId, run.id));
      const parts = tasks.map(task => ({ type: "tool-ask_receiver" as const, toolCallId: task.originToolCallId, state: "output-available" as const,
        input: { task: "Assignment" }, output: { taskId: task.id, conversationId: task.childConversationId, status: "queued" } }));
      await insertMessage(conversation.id, { id: run.messageId, role: "assistant", parts }, promptId);
      await suspendForTasks(run, runHost().instanceId, native, []);
    }
    return { ctx, run, checkpoint };
  }
  const start = (ctx: AgentCtx, prompt: string, prior?: string, call = newId()) => startAsyncDelegation(ctx, receiverId, prompt, call, "manual", prior);
  const taskOf = async (id: string) => (await db.select().from(schema.delegatedTasks).where(eq(schema.delegatedTasks.id, id)))[0];
  const observed = async (id: string) => { const view = await taskView((await loadPrincipal(owner))!, id); return { runId: view.runId, status: view.status, lastSeq: view.lastSeq }; };
  async function completed() {
    const first = await context(); const output = await start(first.ctx, "Original temperature question");
    await first.checkpoint(); const task = await taskOf(output.taskId);
    await executeRun(task.childRunId!); await executeRun(first.run.id);
    expect((await getRun(first.run.id))?.status).toBe("succeeded");
    return { first, task };
  }

  it("resumes a completed task with its entire context, a fresh invocation, and one Recent entry", async () => {
    const { first, task } = await completed();
    const old = await observed(task.childConversationId!);
    await markTaskRead(first.ctx.principal, task.childConversationId!, old);
    // Historical execution is expired; continuation obtains a fresh deadline and parent authority.
    await db.update(schema.delegatedTasks).set({ deadlineAt: new Date(0) }).where(eq(schema.delegatedTasks.id, task.id));
    const next = await context(first.ctx.conversationId);
    const result = await start(next.ctx, "[history] What about the same sensor now?", task.id);
    const second = await taskOf(result.taskId);
    expect(second).toMatchObject({ childConversationId: task.childConversationId, turn: 2, continuedFromTaskId: task.id, rootTaskId: second.id, rootMessageId: next.run.messageId });
    expect(second.childRunId).not.toBe(task.childRunId);
    await expect(markTaskRead(next.ctx.principal, task.childConversationId!, old)).rejects.toMatchObject({ status: 409 });
    await next.checkpoint(); await executeRun(second.childRunId!); await executeRun(next.run.id);
    const run = (await getRun(second.childRunId!))!;
    const rows = await loadMessageRows(task.childConversationId!);
    expect(pathTo(rows, run.parentMessageId).map(r => r.role)).toEqual(["user", "assistant", "user"]);
    const reply = rows.find(r => r.id === run.messageId)!;
    expect(JSON.stringify(reply.parts)).toContain("Original temperature question");
    expect((await loadRecentTasks(next.ctx.principal)).filter(c => c.id === task.childConversationId)).toMatchObject([{ taskActivity: { status: "succeeded", unread: true } }]);
    await authorizeTaskRead(next.ctx.principal, task.childConversationId!, task.childRunId!);
    await expect(markTaskRead(next.ctx.principal, task.childConversationId!, old)).rejects.toMatchObject({ status: 409 });
    await markTaskRead(next.ctx.principal, task.childConversationId!, await observed(task.childConversationId!));
    expect((await loadRecentTasks(next.ctx.principal)).find(c => c.id === task.childConversationId)?.taskActivity?.unread).toBe(false);
  }, 20_000);

  it("queues concurrent related turns FIFO, fences duplicate claims and preserves receipts per turn", async () => {
    const { first, task } = await completed(); const next = await context(first.ctx.conversationId);
    const [a, duplicate] = await Promise.all([start(next.ctx, "Follow-up A", task.id, "same-call"), start(next.ctx, "Follow-up A", task.id, "same-call")]);
    expect(a.taskId).toBe(duplicate.taskId);
    await expect(start(next.ctx, "Changed prompt", task.id, "same-call")).rejects.toThrow("different assignment");
    await expect(start(next.ctx, "Follow-up A", task.id, "different-call")).rejects.toThrow("already started");
    const b = await start(next.ctx, "Follow-up B", task.id);
    await expect(start(next.ctx, "Follow-up A", a.taskId, "alternate-history-ref")).rejects.toThrow("already started");
    const ta = await taskOf(a.taskId), tb = await taskOf(b.taskId);
    expect([ta.turn, tb.turn]).toEqual([2, 3]);
    const before = (await db.select().from(schema.conversations).where(eq(schema.conversations.id, task.childConversationId!)))[0].currentLeafId;
    expect(before).toBe((await getRun(task.childRunId!))!.messageId);
    await next.checkpoint();
    expect(await claimRun(tb.childRunId!, "out-of-order-worker")).toBeNull();
    // Real delayed model proves a claimed predecessor prevents a concurrent successor.
    await db.update(schema.messages).set({ parts: [{ type: "text", text: "[slow] Follow-up A with sufficient text for a busy run" }] }).where(eq(schema.messages.id, (await getRun(ta.childRunId!))!.parentMessageId!));
    const running = executeRun(ta.childRunId!);
    await vi.waitFor(async () => expect((await getRun(ta.childRunId!))?.status).toBe("running"));
    expect(await claimRun(tb.childRunId!, "other-worker")).toBeNull();
    const recent = (await loadRecentTasks(next.ctx.principal)).filter(c => c.id === task.childConversationId);
    expect(recent).toHaveLength(1); expect(recent[0].taskActivity?.status).toBe("running");
    expect(await taskView(next.ctx.principal, task.childConversationId!)).toMatchObject({ runId: ta.childRunId, queuedCount: 1 });
    await running;
    await Promise.all([executeRun(tb.childRunId!), executeRun(tb.childRunId!)]);
    await executeRun(next.run.id);
    const rows = await loadMessageRows(task.childConversationId!);
    expect(pathTo(rows, (await getRun(tb.childRunId!))!.messageId).map(r => r.role)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
    expect((await taskOf(ta.id)).returnedAt).not.toBeNull(); expect((await taskOf(tb.id)).returnedAt).not.toBeNull();
    const usage = await db.select().from(schema.usageEvents).where(eq(schema.usageEvents.runId, tb.childRunId!));
    await executeRun(tb.childRunId!);
    expect(await db.select().from(schema.usageEvents).where(eq(schema.usageEvents.runId, tb.childRunId!))).toHaveLength(usage.length);
    // A late result from A cannot acknowledge B or append a second receipt to the parent log.
    const seq = (await getRun(next.run.id))!.lastSeq;
    await appendEvents(next.run.id, 1, [{ kind: "chunk", chunk: { type: "tool-output-available", toolCallId: ta.originToolCallId, output: { taskId: ta.id, status: "done", answer: "late" } } }]);
    expect((await getRun(next.run.id))!.lastSeq).toBe(seq);
  }, 30_000);

  it("keeps unrelated assignments to the same bot separate", async () => {
    const ctx = await context();
    const a = await start(ctx.ctx, "temperature"), b = await start(ctx.ctx, "calendar planning");
    expect(a.conversationId).not.toBe(b.conversationId);
    expect(await loadRecentTasks(ctx.ctx.principal)).toHaveLength(2);
  });

  it("denies cross-user, origin, source, target, unknown IDs and revoked access without admission", async () => {
    const { first, task } = await completed(); const next = await context(first.ctx.conversationId);
    const count = async () => (await db.select().from(schema.delegatedTasks)).length;
    const before = await count();
    const outsider = await context(undefined, other), separate = await context();
    await expect(start(outsider.ctx, "steal", task.id)).rejects.toMatchObject({ status: 404 });
    await expect(start(separate.ctx, "wrong origin", task.id)).rejects.toMatchObject({ status: 404 });
    await expect(start(next.ctx, "unknown", "invented-id")).rejects.toMatchObject({ status: 404 });
    await expect(startAsyncDelegation(next.ctx, nestedId, "wrong target", newId(), "manual", task.id)).rejects.toMatchObject({ status: 404 });
    const [differentBot] = await db.select().from(schema.bots).where(eq(schema.bots.id, receiverId));
    await expect(start({ ...next.ctx, bot: differentBot }, "wrong source", task.id)).rejects.toThrow();
    await db.delete(schema.botDelegates).where(and(eq(schema.botDelegates.botId, sourceId), eq(schema.botDelegates.delegateBotId, receiverId)));
    await expect(start(next.ctx, "revoked", task.id)).rejects.toMatchObject({ status: 403 });
    expect(await count()).toBe(before);
    await expect(markTaskRead(outsider.ctx.principal, task.childConversationId!, await observed(task.childConversationId!))).rejects.toMatchObject({ status: 404 });
    await expect(authorizeTaskRead(next.ctx.principal, task.childConversationId!, next.run.id)).rejects.toMatchObject({ status: 404 });
  });

  it("preserves queued cancellation history, never hides an older active turn, and resumes explicitly", async () => {
    const { first, task } = await completed(); const next = await context(first.ctx.conversationId);
    const a = await start(next.ctx, "A", task.id), b = await start(next.ctx, "Cancel B", task.id), c = await start(next.ctx, "[history] Continue C", task.id);
    const ta = await taskOf(a.taskId), tb = await taskOf(b.taskId), tc = await taskOf(c.taskId);
    await next.checkpoint();
    await abortQueuedRun(tb.childRunId!, { status: "cancelled" });
    expect((await loadRecentTasks(next.ctx.principal)).find(r => r.id === task.childConversationId)?.taskActivity?.status).toBe("queued");
    await executeRun(ta.childRunId!); await executeRun(tc.childRunId!); await executeRun(next.run.id);
    const rows = await loadMessageRows(task.childConversationId!);
    const path = pathTo(rows, (await getRun(tc.childRunId!))!.parentMessageId);
    expect(path.map(r => r.searchText)).toContain("Cancel B");
    const awaitedCancelledRun = (await getRun(tb.childRunId!))!;
    expect(path.find(r => r.id === awaitedCancelledRun.messageId)?.searchText).toContain("cancelled before execution");
    expect((await getRun(tb.childRunId!))!.startedAt).toBeNull();
    const snap = await conversationSnapshot(next.ctx.principal, task.childConversationId!);
    expect(snap.initialRows.map(r => r.message.id)).toEqual(pathTo(rows, (await getRun(tc.childRunId!))!.messageId).map(r => r.id));
  }, 20_000);

  it("stopping the child cancels all queued turns; fresh follow-up is allowed and old completions stay fenced", async () => {
    const { first, task } = await completed(); const next = await context(first.ctx.conversationId);
    const a = await start(next.ctx, "A", task.id), b = await start(next.ctx, "B", task.id);
    await next.checkpoint(); await stopRuns(next.ctx.principal, task.childConversationId!);
    for (const result of [a, b]) expect((await getRun((await taskOf(result.taskId)).childRunId!))?.status).toBe("cancelled");
    await executeRun(next.run.id);
    const last = await context(first.ctx.conversationId);
    const c = await start(last.ctx, "Resume after stop", task.id); await last.checkpoint();
    await executeRun((await taskOf(c.taskId)).childRunId!); await executeRun(last.run.id);
    expect((await taskView(last.ctx.principal, task.childConversationId!)).status).toBe("succeeded");
  }, 20_000);


  it("retains FIFO through nested suspension and lets a specialist continue its own prior subtask", async () => {
    const { first, task } = await completed(); const next = await context(first.ctx.conversationId);
    const a = await start(next.ctx, "delegate [async] Nested sensor detail", task.id);
    const b = await start(next.ctx, "After nested work", task.id);
    const ta = await taskOf(a.taskId), tb = await taskOf(b.taskId);
    await next.checkpoint(); await executeRun(ta.childRunId!);
    expect((await getRun(ta.childRunId!))?.status).toBe("waiting_tasks");
    expect(await claimRun(tb.childRunId!, "out-of-order")).toBeNull();
    const [nested] = await db.select().from(schema.delegatedTasks).where(eq(schema.delegatedTasks.parentRunId, ta.childRunId!));
    await executeRun(nested.childRunId!);
    expect((await getRun(ta.childRunId!))?.status).toBe("queued");
    expect(await claimRun(tb.childRunId!, "out-of-order")).toBeNull();
    await executeRun(ta.childRunId!); await executeRun(tb.childRunId!); await executeRun(next.run.id);
    const final = await context(first.ctx.conversationId);
    const tool = `continue_nested_${nestedId.slice(-10)}`;
    const c = await start(final.ctx, `[tool:${tool} ${JSON.stringify({ taskId: nested.id, task: "Related nested follow-up" })}]`, task.id);
    const tc = await taskOf(c.taskId);
    await final.checkpoint(); await executeRun(tc.childRunId!);
    const [continued] = await db.select().from(schema.delegatedTasks).where(eq(schema.delegatedTasks.parentRunId, tc.childRunId!));
    expect(continued).toMatchObject({ childConversationId: nested.childConversationId, turn: 2, depth: 2, parentTaskId: tc.id, rootTaskId: tc.id });
    await executeRun(continued.childRunId!); await executeRun(tc.childRunId!); await executeRun(final.run.id);
    expect((await getRun(final.run.id))?.status).toBe("succeeded");
  }, 20_000);

  it("fails removed history terminally rather than endlessly requeueing it", async () => {
    const { first, task } = await completed(); const next = await context(first.ctx.conversationId);
    const output = await start(next.ctx, "Follow-up after missing history", task.id);
    const child = await taskOf(output.taskId); await next.checkpoint();
    const previous = (await getRun(task.childRunId!))!;
    await db.delete(schema.messages).where(eq(schema.messages.id, previous.parentMessageId!));
    await executeRun(child.childRunId!);
    expect(await getRun(child.childRunId!)).toMatchObject({ status: "failed", error: "A prior task assignment was removed." });
    expect(await claimRun(child.childRunId!, "retry-worker")).toBeNull();
    await (await import("@/lib/delegation/async")).reconcileAsyncTasks();
    await executeRun(next.run.id);
    expect((await getRun(next.run.id))?.status).toBe("succeeded");
    expect((await taskOf(child.id)).returnedAt).not.toBeNull();
  });

  it("does not offer a continuation outside a durable native context and rejects Hermes reuse", async () => {
    const { first, task } = await completed(); const next = await context(first.ctx.conversationId);
    const { buildToolset } = await import("@/lib/agent/toolset");
    const toolset = await buildToolset(next.ctx);
    expect(Object.keys(toolset.tools).some(n => n.startsWith("continue_"))).toBe(true); await toolset.close();
    const inline = await buildToolset({ ...next.ctx, awaitTask: undefined });
    expect(Object.keys(inline.tools).some(n => n.startsWith("continue_"))).toBe(false); await inline.close();
    await expect(admitDelegation(next.ctx, receiverId, "followup", newId(), runHost().instanceId, "sync", "manual", task.id)).rejects.toMatchObject({ status: 400 });
    await db.update(schema.aiApps).set({ provider: "hermes" }).where(eq(schema.aiApps.id, appId));
    await expect(start(next.ctx, "Hermes followup", task.id)).rejects.toMatchObject({ status: 403 });
  });
});
