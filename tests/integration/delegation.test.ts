import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentCtx } from "@/lib/agent/types";
import { startMockLlm } from "./helpers/mock-llm";

vi.mock("@/lib/jobs", async importOriginal => {
  const real = await importOriginal<typeof import("@/lib/jobs")>();
  return { ...real, enqueueRun: vi.fn(real.enqueueRun), enqueue: vi.fn(async () => null),
    scheduleMemoryExtraction: vi.fn(async () => {}), getBoss: () => Promise.reject(new Error("No jobs in delegation tests")) };
});
vi.mock("@/lib/llm/apps", async importOriginal => ({ ...(await importOriginal<typeof import("@/lib/llm/apps")>()), embeddingApp: async () => undefined }));
const suite = process.env.DATABASE_URL ? describe : describe.skip;
suite("linked delegated tasks (Postgres + local mock only)", () => {
  let mock: Awaited<ReturnType<typeof startMockLlm>>;
  let userId: string, appId: string, sourceId: string, receiverId: string;
  beforeAll(async () => {
    const { db, schema } = await import("@/db");
    const { newId } = await import("@/lib/ids");
    const { sealAppSecret } = await import("@/lib/llm/secrets");
    mock = await startMockLlm();
    userId = `delegation-test-${newId()}`; appId = newId();
    await db.insert(schema.users).values({ id: userId, upn: `${userId}@test.local`, name: "Task owner", authSource: "ldap" });
    await db.insert(schema.aiApps).values({ id: appId, name: "Local test", model: "mock-gpt", provider: "openai", baseUrl: `${mock.url}/v1`, apiKeyEnc: sealAppSecret(appId, "test-only"), supportsTools: true });
    const [source, receiver] = await db.insert(schema.bots).values([{ ownerId: userId, appId, name: "Assigner" }, { ownerId: userId, appId, name: "Receiver" }]).returning();
    sourceId = source.id; receiverId = receiver.id;
    await db.insert(schema.botDelegates).values({ botId: sourceId, delegateBotId: receiverId });
  });
  afterAll(async () => {
    const { db, pool, schema } = await import("@/db");
    const { runHost } = await import("@/lib/runs/host");
    const { runListener } = await import("@/lib/runs/listener");
    await runHost().shutdown(2000); await runListener().close();
    await db.delete(schema.usageEvents).where(eq(schema.usageEvents.userId, userId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await db.delete(schema.aiApps).where(eq(schema.aiApps.id, appId));
    await pool.end(); mock?.stop();
  });
  async function context(group = false): Promise<AgentCtx> {
    const { db, schema } = await import("@/db");
    const { loadPrincipal } = await import("@/lib/auth/groups");
    const { runHost } = await import("@/lib/runs/host");
    const { newUsageScope } = await import("@/lib/llm");
    const { newId } = await import("@/lib/ids");
    const { getSetting } = await import("@/lib/settings");
    const principal = (await loadPrincipal(userId))!;
    const [bot] = await db.select().from(schema.bots).where(eq(schema.bots.id, sourceId));
    const [app] = await db.select().from(schema.aiApps).where(eq(schema.aiApps.id, appId));
    const [conv] = await db.insert(schema.conversations).values({ userId, botId: group ? null : sourceId, isGroup: group, title: "Origin" }).returning();
    const messageId = newId();
    let runId: string | undefined;
    if (group) await db.insert(schema.conversationBots).values({ conversationId: conv.id, botId: sourceId, position: 0 });
    else {
      const [run] = await db.insert(schema.agentRuns).values({ userId, conversationId: conv.id, botId: sourceId, appId, messageId, status: "running", holder: runHost().instanceId, startedAt: sql`now()`, heartbeatAt: sql`now()` }).returning(); runId = run.id;
    }
    return { principal, bot, app, conversationId: conv.id, depth: 0, background: false, inGroup: group, toolSettings: await getSetting("tools"), usage: newUsageScope({ messageId, runId }), execution: { holder: runHost().instanceId, deadlineAt: Date.now() + 60_000 } };
  }
  async function admit(ctx: AgentCtx, call = "provider-call", prompt = "Please explain cats.") {
    const { admitDelegation } = await import("@/lib/delegation/store");
    const { runHost } = await import("@/lib/runs/host");
    return admitDelegation(ctx, receiverId, prompt, call, runHost().instanceId);
  }
  it("reads exact task activity without arguments, unrelated events or revoked live access", async () => {
    const { db, schema } = await import("@/db");
    const { taskActivity } = await import("@/lib/delegation/activity");
    const ctx = await context();
    const { task } = await admit(ctx, "activity-call");
    await db.insert(schema.runEvents).values([
      { runId: task.childRunId!, seq: 1, segment: 0, chunk: { type: "tool-input-available", toolCallId: "live", toolName: "workspace_bash", input: { command: "private-argument-sentinel" } } },
      { runId: task.childRunId!, seq: 2, segment: 0, chunk: { type: "tool-output-available", toolCallId: "live", preliminary: true, output: "private-output-sentinel" } },
      { runId: ctx.usage!.runId!, seq: 1, segment: 0, chunk: { type: "reset-step" } },
    ]);
    const activity = await taskActivity(ctx.principal, task.id);
    expect(activity).toEqual({ taskId: task.id, status: "working", completed: 0, steps: [{ tool: "workspace_bash", status: "running" }] });
    expect(JSON.stringify(activity)).not.toContain("private-");
    await expect(taskActivity({ ...ctx.principal, user: { ...ctx.principal.user, id: "someone-else" } }, task.id)).rejects.toMatchObject({ status: 404 });
    await expect(taskActivity({ ...ctx.principal, user: { ...ctx.principal.user, sessionVersion: ctx.principal.user.sessionVersion + 1 } }, task.id)).rejects.toMatchObject({ status: 403 });
    await db.delete(schema.botDelegates).where(and(eq(schema.botDelegates.botId, sourceId), eq(schema.botDelegates.delegateBotId, receiverId)));
    try {
      await expect(taskActivity(ctx.principal, task.id)).rejects.toMatchObject({ status: 403 });
      await db.update(schema.agentRuns).set({ status: "cancelled" }).where(eq(schema.agentRuns.id, task.childRunId!));
      expect(await taskActivity(ctx.principal, task.id)).toMatchObject({ status: "cancelled", steps: [{ status: "error" }] });
    } finally { await db.insert(schema.botDelegates).values({ botId: sourceId, delegateBotId: receiverId }); }
  });
  it("atomically admits one child for duplicate calls, with a separate owned transcript and no routine hook", async () => {
    const { db, schema } = await import("@/db");
    const ctx = await context();
    const [a, b] = await Promise.all([admit(ctx), admit(ctx)]);
    expect(a.task.id).toBe(b.task.id); expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
    const [conv] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, a.task.childConversationId!));
    expect(conv).toMatchObject({ userId, botId: receiverId, source: "delegation", isBotHome: false, isGroup: false });
    const [run] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, a.task.childRunId!));
    expect(run).toMatchObject({ executionMode: "inline_delegate", status: "running", routineRunId: null, segment: 0, botId: receiverId });
    const [assignment] = await db.select().from(schema.messages).where(eq(schema.messages.conversationId, conv.id));
    expect(assignment.metadata).toMatchObject({ assignment: { botId: sourceId, name: "Assigner" } });
    await expect(admit(ctx, "provider-call", "different task")).rejects.toThrow("different assignment");
  });
  it("runs a real local-model child, persists its answer and usage, then attaches without executing again", async () => {
    const { db, schema } = await import("@/db");
    const { runDelegation } = await import("@/lib/delegation/execute");
    const { loadBotActivity } = await import("@/lib/chat/activity");
    const ctx = await context(); const outputs = [];
    for await (const output of runDelegation(ctx, receiverId, "Tell me about cats.", "real-call")) outputs.push(output);
    expect(outputs[0]).toMatchObject({ status: "working", conversationId: expect.any(String) });
    expect(outputs.at(-1)).toMatchObject({ status: "done", answer: expect.stringContaining("cats") });
    const [task] = await db.select().from(schema.delegatedTasks).where(eq(schema.delegatedTasks.id, outputs[0].taskId));
    expect(task.returnedAt).toBeNull();
    const before = await db.select().from(schema.usageEvents).where(eq(schema.usageEvents.runId, task.childRunId!));
    expect(before.length).toBeGreaterThan(0); expect(before.every(u => u.botId === receiverId && u.conversationId === task.childConversationId)).toBe(true);
    const replay = []; for await (const output of runDelegation(ctx, receiverId, "Tell me about cats.", "real-call")) replay.push(output);
    expect(replay.at(-1)).toEqual(outputs.at(-1));
    expect(await db.select().from(schema.usageEvents).where(eq(schema.usageEvents.runId, task.childRunId!))).toHaveLength(before.length);
    expect((await loadBotActivity(ctx.principal, receiverId)).activity.some(a => a.kind === "delegation" && a.conversationId === task.childConversationId)).toBe(true);
  }, 20_000);
  it("records one parent receipt in the same transaction as its final event", async () => {
    const { db, schema } = await import("@/db");
    const { appendEvents, readEvents } = await import("@/lib/runs/log");
    const ctx = await context(); const { task } = await admit(ctx);
    await db.update(schema.agentRuns).set({ status: "succeeded" }).where(eq(schema.agentRuns.id, task.childRunId!));
    const result = { type: "tool-output-available" as const, toolCallId: task.originToolCallId, output: { taskId: task.id, status: "done", answer: "result" } };
    await Promise.all([appendEvents(ctx.usage!.runId!, 0, [{ kind: "chunk", chunk: result }]), appendEvents(ctx.usage!.runId!, 0, [{ kind: "chunk", chunk: result }])]);
    const [saved] = await db.select().from(schema.delegatedTasks).where(eq(schema.delegatedTasks.id, task.id));
    expect(saved.returnedAt).not.toBeNull(); expect(saved.parentResultSeq).toBe(1);
    expect(await readEvents(ctx.usage!.runId!, 0, 10)).toHaveLength(1);
  });
  it("denies cross-owner reads, normal chat sends, approvals and queue admission", async () => {
    const { db, schema } = await import("@/db");
    const { ownedTask } = await import("@/lib/delegation/view");
    const { startRun, continueRun } = await import("@/lib/runs/store");
    const { enqueueRun } = await import("@/lib/jobs");
    const { claimRun, pauseRun } = await import("@/lib/runs/state");
    const ctx = await context(); const { task } = await admit(ctx);
    await expect(ownedTask({ ...ctx.principal, user: { ...ctx.principal.user, id: "another-owner" } }, task.childConversationId!)).rejects.toThrow("Task not found");
    const [conversation] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, task.childConversationId!));
    await expect(startRun({ principal: ctx.principal, conversation, bot: ctx.bot!, app: ctx.app, parentId: null })).rejects.toThrow("read-only");
    await expect(continueRun({ principal: ctx.principal, conversation, messageId: "x", decisions: new Map() })).rejects.toThrow("cannot resume");
    await expect(enqueueRun({ id: task.childRunId!, background: false, segment: 0 })).rejects.toThrow("cannot be queued");
    expect(await claimRun(task.childRunId!, "another-holder")).toBeNull();
    expect(await pauseRun({ id: task.childRunId!, segment: 0 }, ctx.execution!.holder, null)).toBeNull();
  });
  it("rechecks revoked edges for live work but preserves completed owner history", async () => {
    const { db, schema } = await import("@/db");
    const { assertTaskExecution } = await import("@/lib/delegation/store");
    const { taskView } = await import("@/lib/delegation/view");
    const { appendEvents, readEvents } = await import("@/lib/runs/log");
    const ctx = await context(); const { task } = await admit(ctx);
    await db.update(schema.agentRuns).set({ status: "succeeded" }).where(eq(schema.agentRuns.id, task.childRunId!));
    await db.delete(schema.botDelegates).where(and(eq(schema.botDelegates.botId, sourceId), eq(schema.botDelegates.delegateBotId, receiverId)));
    try {
      await expect(assertTaskExecution(task)).rejects.toMatchObject({ status: 403 });
      expect(await taskView(ctx.principal, task.childConversationId!)).toMatchObject({ status: "succeeded", receiver: "Receiver" });
      await appendEvents(ctx.usage!.runId!, 0, [{ kind: "chunk", chunk: { type: "tool-output-available", toolCallId: task.originToolCallId, output: { taskId: task.id, status: "done", answer: "must not return" } } }]);
      expect(JSON.stringify(await readEvents(ctx.usage!.runId!, 0, 10))).not.toContain("must not return");
      expect((await db.select().from(schema.delegatedTasks).where(eq(schema.delegatedTasks.id, task.id)))[0].returnedAt).toBeNull();
    } finally { await db.insert(schema.botDelegates).values({ botId: sourceId, delegateBotId: receiverId }); }
  });
  it("cancels children when the parent stops and rejects their late delivery", async () => {
    const { db } = await import("@/db");
    const { getRun, requestCancelTx } = await import("@/lib/runs/state");
    const { assertTaskExecution } = await import("@/lib/delegation/store");
    const ctx = await context(); const { task } = await admit(ctx);
    await db.transaction(tx => requestCancelTx(tx, ctx.usage!.runId!));
    expect((await getRun(task.childRunId!))?.cancelRequestedAt).not.toBeNull();
    await expect(assertTaskExecution(task)).rejects.toThrow("no longer running");
  });
  it("honors the shared active-task budget and rejects self/cyclic delegation", async () => {
    const { admitDelegation } = await import("@/lib/delegation/store");
    const ctx = await context();
    await expect(admitDelegation(ctx, sourceId, "loop", "cycle", ctx.execution!.holder)).rejects.toThrow("loop");
    await Promise.all([0, 1, 2, 3].map(i => admit(ctx, `call-${i}`)));
    await expect(admit(ctx, "too-many")).rejects.toThrow("budget");
  });
  it("links actual group tool delegation without inventing a parent run", async () => {
    const ctx = await context(true); const { task } = await admit(ctx);
    expect(task).toMatchObject({ parentRunId: null, originMessageId: ctx.usage!.messageId, assignerBotId: sourceId });
    await expect(admit({ ...ctx, inGroup: false }, "bad-group")).rejects.toThrow("live group turn");
  });
  it("sanitizes rejected outputs in both worker and group saved transcripts", async () => {
    const { db, schema } = await import("@/db");
    const { saveAssistantMessage } = await import("@/lib/agent/persist");
    const { receiveGroupResults } = await import("@/lib/delegation/receipts");
    const { insertMessage } = await import("@/lib/chat/store");
    for (const group of [false, true]) {
      const ctx = await context(group); const { task } = await admit(ctx);
      await db.update(schema.agentRuns).set({ status: "succeeded" }).where(eq(schema.agentRuns.id, task.childRunId!));
      const message = { id: ctx.usage!.messageId!, role: "assistant" as const, parts: [{ type: "tool-ask_receiver" as const, toolCallId: task.originToolCallId, state: "output-available" as const, input: { task: "cats" }, output: { taskId: task.id, status: "done", answer: "REVOKED ANSWER" } }] };
      await db.delete(schema.botDelegates).where(and(eq(schema.botDelegates.botId, sourceId), eq(schema.botDelegates.delegateBotId, receiverId)));
      try {
        await db.transaction(async tx => {
          if (group) {
            await receiveGroupResults(tx, userId, ctx.conversationId, message);
            await insertMessage(ctx.conversationId, message, null, {}, tx);
          } else await saveAssistantMessage({ userId, conversationId: ctx.conversationId, botId: sourceId, runId: ctx.usage!.runId, responseMessage: message, parentId: null, isContinuation: false, background: false, extra: { model: "mock", inputTokens: null, outputTokens: null } }, tx);
        });
        const [saved] = await db.select().from(schema.messages).where(eq(schema.messages.id, message.id));
        expect(JSON.stringify(saved.parts)).not.toContain("REVOKED ANSWER");
        expect(JSON.stringify(saved.parts)).toMatch(/no longer authorized|no authorized, committed result/);
      } finally { await db.insert(schema.botDelegates).values({ botId: sourceId, delegateBotId: receiverId }); }
    }
  });
  it("fails closed when a child is deleted after producing its result", async () => {
    const { db, schema } = await import("@/db");
    const { appendEvents, readEvents } = await import("@/lib/runs/log");
    const ctx = await context(); const { task } = await admit(ctx);
    await db.delete(schema.conversations).where(eq(schema.conversations.id, task.childConversationId!));
    await appendEvents(ctx.usage!.runId!, 0, [{ kind: "chunk", chunk: { type: "tool-output-available", toolCallId: task.originToolCallId, output: { taskId: task.id, status: "done", answer: "DELETED RESULT" } } }]);
    expect(JSON.stringify(await readEvents(ctx.usage!.runId!, 0, 10))).not.toContain("DELETED RESULT");
    await expect(admit(ctx)).rejects.toThrow("removed");
    expect((await db.select().from(schema.delegatedTasks).where(eq(schema.delegatedTasks.id, task.id)))[0]).toMatchObject({ childRunId: null, childConversationId: null, returnedAt: null });
  });
  it("ends an orphan from its saved events and never queues or resumes it", async () => {
    const { db, schema } = await import("@/db");
    const { appendEvents } = await import("@/lib/runs/log");
    const { sweepRuns } = await import("@/lib/runs/sweeper");
    const ctx = await context(); const { task } = await admit(ctx);
    await appendEvents(task.childRunId!, 0, [
      { kind: "chunk", chunk: { type: "start", messageId: "partial" } },
      { kind: "chunk", chunk: { type: "text-start", id: "text" } },
      { kind: "chunk", chunk: { type: "text-delta", id: "text", delta: "Saved partial work" } },
    ]);
    await db.update(schema.agentRuns).set({ heartbeatAt: sql`now() - interval '1 hour'` }).where(eq(schema.agentRuns.id, task.childRunId!));
    const swept = await sweepRuns(); expect(swept.interrupted).toBeGreaterThanOrEqual(1);
    const [run] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, task.childRunId!));
    expect(run).toMatchObject({ status: "interrupted", executionMode: "inline_delegate", segment: 0 });
    const [saved] = await db.select().from(schema.messages).where(eq(schema.messages.id, run.messageId));
    expect(JSON.stringify(saved.parts)).toContain("Saved partial work");
    const { enqueueRun } = await import("@/lib/jobs");
    expect(vi.mocked(enqueueRun).mock.calls.some(([run]) => run.id === task.childRunId)).toBe(false);
  });
  it("runs delegation through the parent executor and commits one linked result", async () => {
    const { db, schema } = await import("@/db");
    const { insertMessage, setCurrentLeaf } = await import("@/lib/chat/store");
    const { executeRun } = await import("@/lib/runs/execute");
    const { newId } = await import("@/lib/ids");
    const ctx = await context(); const promptId = newId();
    await insertMessage(ctx.conversationId, { id: promptId, role: "user", parts: [{ type: "text", text: "delegate explain cats" }] }, null);
    await setCurrentLeaf(ctx.conversationId, promptId);
    await db.update(schema.agentRuns).set({ status: "queued", holder: null, parentMessageId: promptId }).where(eq(schema.agentRuns.id, ctx.usage!.runId!));
    await executeRun(ctx.usage!.runId!);
    const [parent] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, ctx.usage!.runId!));
    expect(parent.status).toBe("succeeded");
    const tasks = await db.select().from(schema.delegatedTasks).where(eq(schema.delegatedTasks.parentRunId, parent.id));
    expect(tasks).toHaveLength(1); expect(tasks[0].returnedAt).not.toBeNull();
    const [saved] = await db.select().from(schema.messages).where(eq(schema.messages.id, parent.messageId));
    expect(JSON.stringify(saved.parts)).toContain(tasks[0].id);
  }, 20_000);

  it("keeps nested task ancestry and separate transcripts, and rejects a route back to an ancestor", async () => {
    const { db, schema } = await import("@/db");
    const { runDelegation } = await import("@/lib/delegation/execute");
    const { checkAncestry } = await import("@/lib/delegation/policy");
    const [third] = await db.insert(schema.bots).values({ ownerId: userId, appId, name: "Third specialist" }).returning();
    await db.insert(schema.botDelegates).values({ botId: receiverId, delegateBotId: third.id });
    const ctx = await context();
    const outputs = [];
    try {
      for await (const output of runDelegation(ctx, receiverId, "delegate explain cats", "nested-call")) outputs.push(output);
      expect(outputs.at(-1)?.status).toBe("done");
      const tasks = await db.select().from(schema.delegatedTasks).where(eq(schema.delegatedTasks.rootMessageId, ctx.usage!.messageId!));
      expect(tasks).toHaveLength(2);
      const root = tasks.find(t => t.depth === 1)!, nested = tasks.find(t => t.depth === 2)!;
      expect(nested).toMatchObject({ parentTaskId: root.id, parentRunId: root.childRunId, originConversationId: root.childConversationId, receiverBotId: third.id, rootTaskId: root.id });
      expect(nested.returnedAt).not.toBeNull(); expect(root.returnedAt).toBeNull();
      expect(() => checkAncestry([{ from: sourceId, to: receiverId }], receiverId, sourceId, 1)).toThrow("loop");
      expect(() => checkAncestry(nested.ancestry, third.id, "fourth", 2)).toThrow("depth");
    } finally { await db.delete(schema.bots).where(eq(schema.bots.id, third.id)); }
  }, 20_000);
  it("persists actual group delegations with scoped call IDs; plain mentions create no tasks", async () => {
    const { db, schema } = await import("@/db");
    const { runGroupTurn } = await import("@/lib/agent/group");
    const { insertMessage } = await import("@/lib/chat/store");
    const { newId } = await import("@/lib/ids");
    for (const delegate of [true, false]) {
      const ctx = await context(true);
      const [conversation] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, ctx.conversationId));
      const [receiver] = await db.select().from(schema.bots).where(eq(schema.bots.id, receiverId));
      await db.insert(schema.conversationBots).values({ conversationId: conversation.id, botId: receiverId, position: 1 });
      const prompt = { id: newId(), role: "user" as const, parts: [{ type: "text" as const, text: delegate ? "@Assigner delegate explain cats" : "@Receiver explain cats" }] };
      await insertMessage(conversation.id, prompt, null);
      const stream = await runGroupTurn({ principal: ctx.principal, conversation, members: [{ bot: ctx.bot!, app: ctx.app }, { bot: receiver, app: ctx.app }], history: [prompt] });
      const reader = stream.getReader();
      while (!(await reader.read()).done) { /* Drain the complete group turn and its persistence. */ }
      const tasks = await db.select().from(schema.delegatedTasks).where(eq(schema.delegatedTasks.originConversationId, conversation.id));
      expect(tasks).toHaveLength(delegate ? 1 : 0);
      if (delegate) {
        expect(tasks[0].originToolCallId).toContain(":"); expect(tasks[0].returnedAt).not.toBeNull(); expect(tasks[0].parentRunId).toBeNull();
        const [message] = await db.select().from(schema.messages).where(eq(schema.messages.id, tasks[0].originMessageId));
        expect(JSON.stringify(message.parts)).toContain(tasks[0].originToolCallId);
      }
    }
  }, 20_000);
  it("rejects expired deadlines and session revocation; completed attempts still count toward the root budget", async () => {
    const { db, schema } = await import("@/db");
    const { assertTaskExecution } = await import("@/lib/delegation/store");
    const ctx = await context();
    await expect(admit({ ...ctx, execution: { ...ctx.execution!, deadlineAt: Date.now() - 1 } })).rejects.toThrow("deadline");
    for (let i = 0; i < 8; i++) {
      const { task } = await admit(ctx, `budget-${i}`);
      await db.update(schema.agentRuns).set({ status: "succeeded" }).where(eq(schema.agentRuns.id, task.childRunId!));
      if (i === 0) {
        await db.update(schema.users).set({ sessionVersion: ctx.principal.user.sessionVersion + 1 }).where(eq(schema.users.id, userId));
        try { await expect(assertTaskExecution(task)).rejects.toThrow("session changed"); }
        finally { await db.update(schema.users).set({ sessionVersion: ctx.principal.user.sessionVersion }).where(eq(schema.users.id, userId)); }
      }
    }
    await expect(admit(ctx, "ninth-task")).rejects.toThrow("budget");
  });

  it("never saves a successful output before dispatch is committed, even if revocation arrives before the flush", async () => {
    const { db, schema } = await import("@/db");
    const { appendEvents, readEvents } = await import("@/lib/runs/log");
    const { saveAssistantMessage } = await import("@/lib/agent/persist");
    const ctx = await context(); const { task } = await admit(ctx);
    await db.update(schema.agentRuns).set({ status: "succeeded" }).where(eq(schema.agentRuns.id, task.childRunId!));
    const output = { taskId: task.id, status: "done", answer: "NOT DISPATCHED" };
    const message = { id: ctx.usage!.messageId!, role: "assistant" as const, parts: [{ type: "tool-ask_receiver" as const, toolCallId: task.originToolCallId, state: "output-available" as const, input: { task: "cats" }, output }] };
    await db.transaction(tx => saveAssistantMessage({ userId, conversationId: ctx.conversationId, botId: sourceId, runId: ctx.usage!.runId, responseMessage: message, parentId: null, isContinuation: false, background: false, extra: { model: "mock", inputTokens: null, outputTokens: null } }, tx));
    await db.delete(schema.botDelegates).where(and(eq(schema.botDelegates.botId, sourceId), eq(schema.botDelegates.delegateBotId, receiverId)));
    try {
      await appendEvents(ctx.usage!.runId!, 0, [{ kind: "chunk", chunk: { type: "tool-output-available", toolCallId: task.originToolCallId, output } }]);
      const [saved] = await db.select().from(schema.messages).where(eq(schema.messages.id, message.id));
      expect(JSON.stringify(saved.parts)).not.toContain("NOT DISPATCHED");
      expect(JSON.stringify(await readEvents(ctx.usage!.runId!, 0, 10))).not.toContain("NOT DISPATCHED");
    } finally { await db.insert(schema.botDelegates).values({ botId: sourceId, delegateBotId: receiverId }); }
  });
  it("retains a completed owned task after deleting its receiving bot", async () => {
    const { db, schema } = await import("@/db");
    const { admitDelegation, assertTaskExecution } = await import("@/lib/delegation/store");
    const { taskView } = await import("@/lib/delegation/view");
    const [temporary] = await db.insert(schema.bots).values({ ownerId: userId, appId, name: "Deleted specialist" }).returning();
    await db.insert(schema.botDelegates).values({ botId: sourceId, delegateBotId: temporary.id });
    const ctx = await context(); const { task } = await admitDelegation(ctx, temporary.id, "Task", "deleted-bot-call", ctx.execution!.holder);
    await db.update(schema.agentRuns).set({ status: "succeeded" }).where(eq(schema.agentRuns.id, task.childRunId!));
    await db.delete(schema.bots).where(eq(schema.bots.id, temporary.id));
    expect(await taskView(ctx.principal, task.childConversationId!)).toMatchObject({ status: "succeeded", receiver: "Deleted specialist" });
    await expect(assertTaskExecution(task)).rejects.toThrow();
  });

});
