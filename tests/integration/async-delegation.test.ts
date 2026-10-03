import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentCtx } from "@/lib/agent/types";
import { startMockLlm } from "./helpers/mock-llm";

vi.mock("@/lib/jobs", async original => ({ ...(await original<typeof import("@/lib/jobs")>()),
  enqueueRun: vi.fn(async () => "synthetic-job"), enqueue: vi.fn(async () => null), scheduleMemoryExtraction: vi.fn(async () => {}),
  getBoss: () => Promise.reject(new Error("No queue transport in async integration tests")) }));
vi.mock("@/lib/llm/apps", async original => ({ ...(await original<typeof import("@/lib/llm/apps")>()), embeddingApp: async () => undefined }));
const suite = process.env.DATABASE_URL ? describe : describe.skip;

suite("native asynchronous delegation: real Postgres and local model", () => {
  let mock: Awaited<ReturnType<typeof startMockLlm>>;
  let userId: string, appId: string, sourceId: string, receiverId: string, nestedId: string;
  beforeAll(async () => {
    if (new URL(process.env.DATABASE_URL!).pathname !== "/collective_coordinator_async_test") throw new Error("Named disposable async test database required");
    const { db, schema } = await import("@/db");
    const { newId } = await import("@/lib/ids");
    const { sealAppSecret } = await import("@/lib/llm/secrets");
    const { runHost } = await import("@/lib/runs/host");
    mock = await startMockLlm(); userId = `async-test-${newId()}`; appId = newId();
    await db.insert(schema.users).values({ id: userId, upn: `${userId}@test.invalid`, name: "Async owner", authSource: "ldap" });
    await db.insert(schema.aiApps).values({ id: appId, name: "Local mock", provider: "openai", model: "mock-gpt", supportsTools: true, baseUrl: `${mock.url}/v1`, apiKeyEnc: sealAppSecret(appId, "synthetic-only") });
    const bots = await db.insert(schema.bots).values(["Assigner", "Receiver", "Nested specialist"].map(name => ({ ownerId: userId, appId, name }))).returning();
    [sourceId, receiverId, nestedId] = bots.map(b => b.id);
    await db.insert(schema.botDelegates).values([{ botId: sourceId, delegateBotId: receiverId }, { botId: receiverId, delegateBotId: nestedId }]);
    runHost().start();
  });
  afterEach(async () => {
    const { db, schema } = await import("@/db");
    await db.delete(schema.conversations).where(eq(schema.conversations.userId, userId));
    await db.delete(schema.delegatedTasks).where(eq(schema.delegatedTasks.userId, userId));
    await db.delete(schema.settings).where(eq(schema.settings.key, "coordinator"));
    await db.update(schema.bots).set({ coordinatorEligible: false, executionMode: "caller", publishedRevision: null, publishedConfigHash: null }).where(eq(schema.bots.id, receiverId));
    await db.update(schema.aiApps).set({ isPublic: true, supportsTools: true }).where(eq(schema.aiApps.id, appId));
    await db.insert(schema.botDelegates).values({ botId: sourceId, delegateBotId: receiverId }).onConflictDoNothing();
    await db.insert(schema.botDelegates).values({ botId: receiverId, delegateBotId: nestedId }).onConflictDoNothing();
    vi.clearAllMocks();
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
  async function createParent(text = "delegate [async] explain cats") {
    const { db, schema } = await import("@/db");
    const { loadPrincipal } = await import("@/lib/auth/groups");
    const { startRun } = await import("@/lib/runs/store");
    const { newId } = await import("@/lib/ids");
    const principal = (await loadPrincipal(userId))!;
    const [bot] = await db.select().from(schema.bots).where(eq(schema.bots.id, sourceId));
    const [app] = await db.select().from(schema.aiApps).where(eq(schema.aiApps.id, appId));
    const [conversation] = await db.insert(schema.conversations).values({ userId, botId: sourceId, title: "Async origin" }).returning();
    const run = await startRun({ principal, conversation, bot, app, parentId: null, userMessage: { id: newId(), role: "user", parts: [{ type: "text", text }] } });
    return { run, principal, bot, app, conversation };
  }
  async function assignments(parentId: string) {
    const { db, schema } = await import("@/db");
    return db.select().from(schema.delegatedTasks).where(eq(schema.delegatedTasks.parentRunId, parentId));
  }
  async function enableAutomatic() {
    const { db, schema } = await import("@/db");
    const { setSetting } = await import("@/lib/settings");
    await db.delete(schema.botDelegates).where(and(eq(schema.botDelegates.botId, sourceId), eq(schema.botDelegates.delegateBotId, receiverId)));
    await db.update(schema.bots).set({ coordinatorEligible: true }).where(eq(schema.bots.id, receiverId));
    await setSetting("coordinator", { enabled: true, defaultBotId: sourceId, starterBotId: null });
  }
  async function checkpoint(count = 1, approval = false) {
    const setup = await createParent("Synthetic assignment fixture");
    const { claimRun } = await import("@/lib/runs/state");
    const { runHost } = await import("@/lib/runs/host");
    const { newUsageScope } = await import("@/lib/llm");
    const { getSetting } = await import("@/lib/settings");
    const { startAsyncDelegation, suspendForTasks } = await import("@/lib/delegation/async");
    const { saveAssistantMessage } = await import("@/lib/agent/persist");
    const { appendEvents } = await import("@/lib/runs/log");
    const run = (await claimRun(setup.run.id, runHost().instanceId))!;
    const native = { deadlineAt: Date.now() + 60_000, sessionVersion: setup.principal.user.sessionVersion, stepsUsed: 1, maxSteps: 20, taskIds: [] as string[] };
    const ctx: AgentCtx = { principal: setup.principal, bot: setup.bot, app: setup.app, conversationId: setup.conversation.id, depth: 0, background: false,
      toolSettings: await getSetting("tools"), usage: newUsageScope({ messageId: run.messageId, runId: run.id }), execution: { holder: runHost().instanceId, deadlineAt: native.deadlineAt, segment: 0 }, awaitTask: id => native.taskIds.push(id) };
    const parts = [];
    for (let i = 0; i < count; i++) {
      const output = await startAsyncDelegation(ctx, receiverId, `Assignment ${i}`, `async-call-${i}`);
      parts.push({ type: "tool-ask_receiver" as const, toolCallId: `async-call-${i}`, state: "output-available" as const, input: { task: `Assignment ${i}`, mode: "async" }, output });
    }
    const message = { id: run.messageId, role: "assistant" as const, parts: [
      ...parts,
      ...(approval ? [{ type: "tool-fetch_url" as const, toolCallId: "needs-approval", state: "approval-requested" as const, input: { url: "https://example.invalid" }, approval: { id: "synthetic-approval" } }] : []),
    ] };
    await appendEvents(run.id, 0, [{ kind: "chunk", chunk: { type: "start", messageId: run.messageId } }, ...parts.flatMap(p => [
      { kind: "chunk" as const, chunk: { type: "tool-input-available" as const, toolName: "ask_receiver", toolCallId: p.toolCallId, input: p.input } },
      { kind: "chunk" as const, chunk: { type: "tool-output-available" as const, toolCallId: p.toolCallId, output: p.output } },
    ])]);
    await saveAssistantMessage({ userId, botId: sourceId, conversationId: run.conversationId, runId: run.id, responseMessage: message, parentId: run.parentMessageId, isContinuation: false, background: false, extra: { model: "mock-gpt", inputTokens: null, outputTokens: null } });
    return { ...setup, run, ctx, native, suspend: () => suspendForTasks(run, runHost().instanceId, native, []) };
  }
  async function finishChild(runId: string, text = "Stored specialist result") {
    const { db, schema } = await import("@/db");
    const { insertMessage } = await import("@/lib/chat/store");
    const [run] = await db.update(schema.agentRuns).set({ status: "succeeded", holder: null, finishedAt: sql`now()` }).where(eq(schema.agentRuns.id, runId)).returning();
    await insertMessage(run.conversationId, { id: run.messageId, role: "assistant", parts: [{ type: "text", text }] }, run.parentMessageId);
  }

  it("releases the parent slot, runs the independent child, and continues exactly once with committed output", async () => {
    const { db, schema } = await import("@/db");
    const { executeRun } = await import("@/lib/runs/execute");
    const { getRun } = await import("@/lib/runs/state");
    const { runHost } = await import("@/lib/runs/host");
    const { reconcileAsyncTasks } = await import("@/lib/delegation/async");
    const { run } = await createParent();
    await executeRun(run.id);
    expect(await getRun(run.id)).toMatchObject({ status: "waiting_tasks", holder: null, segment: 0 });
    expect(runHost().tracked()).not.toContain(run.id);
    const [task] = await assignments(run.id);
    expect(task.mode).toBe("async");
    expect(await getRun(task.childRunId!)).toMatchObject({ status: "queued", background: true, executionMode: "async_delegate" });
    await executeRun(task.childRunId!);
    expect(await getRun(task.childRunId!)).toMatchObject({ status: "succeeded" });
    expect(await getRun(run.id)).toMatchObject({ status: "queued", segment: 1 });
    const [message] = await db.select().from(schema.messages).where(eq(schema.messages.id, run.messageId));
    expect(message.parts).toEqual(expect.arrayContaining([expect.objectContaining({ output: expect.objectContaining({ status: "done", answer: 'You said: "explain cats"' }) })]));
    expect((await assignments(run.id))[0].returnedAt).not.toBeNull();
    const usage = await db.select().from(schema.usageEvents).where(eq(schema.usageEvents.runId, task.childRunId!));
    await Promise.all([executeRun(task.childRunId!), reconcileAsyncTasks(), reconcileAsyncTasks()]);
    expect(await db.select().from(schema.usageEvents).where(eq(schema.usageEvents.runId, task.childRunId!))).toHaveLength(usage.length);
    expect(await getRun(run.id)).toMatchObject({ status: "queued", segment: 1 });
    expect(await db.select().from(schema.inboxItems).where(eq(schema.inboxItems.id, `task_${task.id}`))).toHaveLength(1);
    await Promise.all([executeRun(run.id), executeRun(run.id)]);
    expect(await getRun(run.id)).toMatchObject({ status: "succeeded", segment: 1 });
    expect(await assignments(run.id)).toHaveLength(1);
  }, 20_000);

  it("cannot claim an admitted child until its parent checkpoint commits", async () => {
    const { claimRun, getRun } = await import("@/lib/runs/state");
    const setup = await checkpoint(); const [task] = await assignments(setup.run.id);
    expect(await claimRun(task.childRunId!, "other-worker")).toBeNull();
    expect((await getRun(task.childRunId!))?.startedAt).toBeNull();
    await setup.suspend();
    expect(await claimRun(task.childRunId!, "other-worker")).toMatchObject({ status: "running", holder: "other-worker" });
  });

  it("keeps completed task delivery pending until a receipt commits or its parent ends", async () => {
    const { taskView } = await import("@/lib/delegation/view");
    const { reconcileAsyncParent } = await import("@/lib/delegation/async");
    const { stopRuns } = await import("@/lib/runs/store");
    const setup = await checkpoint(); await setup.suspend(); const [task] = await assignments(setup.run.id);
    await finishChild(task.childRunId!);
    expect(await taskView(setup.principal, task.childConversationId!)).toMatchObject({ status: "succeeded", returnedAt: null, deliveryPending: true });
    await reconcileAsyncParent(setup.run.id);
    expect(await taskView(setup.principal, task.childConversationId!)).toMatchObject({ deliveryPending: false, returnedAt: expect.any(String) });
    const stopped = await checkpoint(); await stopped.suspend(); const [undelivered] = await assignments(stopped.run.id);
    await finishChild(undelivered.childRunId!);
    await stopRuns(stopped.principal, stopped.conversation.id);
    expect(await taskView(stopped.principal, undelivered.childConversationId!)).toMatchObject({ deliveryPending: false, returnedAt: null });
  });

  it("suspends nested async work without holding either parent slot", async () => {
    const { executeRun } = await import("@/lib/runs/execute");
    const { getRun } = await import("@/lib/runs/state");
    const { runHost } = await import("@/lib/runs/host");
    const { run } = await createParent("delegate [async] delegate [async] explain cats");
    await executeRun(run.id); const [first] = await assignments(run.id);
    await executeRun(first.childRunId!); const [second] = await assignments(first.childRunId!);
    expect(second).toMatchObject({ depth: 2, parentTaskId: first.id, receiverBotId: nestedId, mode: "async" });
    expect((await getRun(first.childRunId!))?.status).toBe("waiting_tasks");
    expect(runHost().tracked()).toEqual([]);
    await executeRun(second.childRunId!); await executeRun(first.childRunId!); await executeRun(run.id);
    expect((await getRun(run.id))?.status).toBe("succeeded");
  }, 20_000);

  it("enforces four running tasks across competing worker claims", async () => {
    const { claimRun } = await import("@/lib/runs/state");
    const setup = await checkpoint(8); await setup.suspend();
    const tasks = await assignments(setup.run.id);
    const claims = await Promise.all(tasks.map((t, i) => claimRun(t.childRunId!, `worker-${i}`)));
    expect(claims.filter(Boolean)).toHaveLength(4);
  });

  it("a stopped suspended parent cannot continue, and queued children never execute", async () => {
    const { executeRun } = await import("@/lib/runs/execute");
    const { stopRuns } = await import("@/lib/runs/store");
    const { getRun } = await import("@/lib/runs/state");
    const { reconcileAsyncTasks } = await import("@/lib/delegation/async");
    const setup = await checkpoint(); await setup.suspend(); const [task] = await assignments(setup.run.id);
    await stopRuns(setup.principal, setup.run.conversationId);
    await executeRun(task.childRunId!); await reconcileAsyncTasks(); await executeRun(setup.run.id);
    expect((await getRun(setup.run.id))?.status).toBe("cancelled");
    expect(await getRun(task.childRunId!)).toMatchObject({ status: "cancelled", startedAt: null });
  });

  it("revocation before dispatch prevents child execution and successful result delivery", async () => {
    const { db, schema } = await import("@/db");
    const { executeRun } = await import("@/lib/runs/execute");
    const { getRun } = await import("@/lib/runs/state");
    const setup = await checkpoint(); await setup.suspend(); const [task] = await assignments(setup.run.id);
    await db.delete(schema.botDelegates).where(and(eq(schema.botDelegates.botId, sourceId), eq(schema.botDelegates.delegateBotId, receiverId)));
    try {
      await executeRun(task.childRunId!);
      expect((await getRun(task.childRunId!))?.status).toBe("failed");
      const [message] = await db.select().from(schema.messages).where(eq(schema.messages.id, setup.run.messageId));
      expect(JSON.stringify(message.parts)).toContain("no longer authorized");
      expect(await db.select().from(schema.usageEvents).where(eq(schema.usageEvents.runId, task.childRunId!))).toHaveLength(0);
    } finally { await db.insert(schema.botDelegates).values({ botId: sourceId, delegateBotId: receiverId }); }
  });

  it("session revocation while suspended fails the parent without returning a saved successful result", async () => {
    const { db, schema } = await import("@/db");
    const { reconcileAsyncParent } = await import("@/lib/delegation/async");
    const { getRun } = await import("@/lib/runs/state");
    const setup = await checkpoint(); await setup.suspend(); const [task] = await assignments(setup.run.id);
    await finishChild(task.childRunId!, "DO NOT DELIVER");
    await db.update(schema.users).set({ sessionVersion: setup.principal.user.sessionVersion + 1 }).where(eq(schema.users.id, userId));
    try {
      await reconcileAsyncParent(setup.run.id);
      expect((await getRun(setup.run.id))?.status).toBe("failed");
      const [saved] = await db.select().from(schema.messages).where(eq(schema.messages.id, setup.run.messageId));
      expect(JSON.stringify(saved.parts)).not.toContain("DO NOT DELIVER");
    } finally { await db.update(schema.users).set({ sessionVersion: setup.principal.user.sessionVersion }).where(eq(schema.users.id, userId)); }
  });

  it("mixed approval and async results keep the human approval pending", async () => {
    const { db, schema } = await import("@/db");
    const { reconcileAsyncParent } = await import("@/lib/delegation/async");
    const { getRun } = await import("@/lib/runs/state");
    const { continueRun } = await import("@/lib/runs/store");
    const { runQueue, QUEUES } = await import("@/lib/jobs");
    const setup = await checkpoint(1, true);
    Object.assign(setup.native, { background: true });
    await db.update(schema.agentRuns).set({ background: true }).where(eq(schema.agentRuns.id, setup.run.id));
    await setup.suspend(); const [task] = await assignments(setup.run.id);
    await finishChild(task.childRunId!); await reconcileAsyncParent(setup.run.id);
    const parent = (await getRun(setup.run.id))!;
    expect(parent).toMatchObject({ status: "waiting", segment: 1 });
    expect(parent.resumeState).toMatchObject({ native: { taskIds: [], stepsUsed: 1 } });
    const [message] = await db.select().from(schema.messages).where(eq(schema.messages.id, parent.messageId));
    expect(JSON.stringify(message.parts)).toContain("Stored specialist result");
    expect(JSON.stringify(message.parts)).not.toContain("no longer authorized");
    expect((await assignments(parent.id))[0].returnedAt).not.toBeNull();
    const approved = await continueRun({ principal: setup.principal, conversation: setup.conversation, messageId: parent.messageId,
      decisions: new Map([["synthetic-approval", { approved: true }]]) });
    expect(approved.resumeState).toMatchObject({ native: { background: false } });
    expect(runQueue(approved)).toBe(QUEUES.agentRun);
  });

  it("untracks a claimed child if task setup loses the database, then recovers it without reexecution", async () => {
    const { db, schema } = await import("@/db");
    const { executeRun } = await import("@/lib/runs/execute");
    const { getRun } = await import("@/lib/runs/state");
    const { runHost } = await import("@/lib/runs/host");
    const { sweepRuns } = await import("@/lib/runs/sweeper");
    const setup = await checkpoint(); await setup.suspend(); const [task] = await assignments(setup.run.id);
    const realSelect = db.select.bind(db);
    const failSelect = vi.spyOn(db, "select").mockImplementation(((...args: Parameters<typeof db.select>) => {
      if (runHost().tracked().includes(task.childRunId!)) throw new Error("Injected setup DB loss");
      return realSelect(...args);
    }) as typeof db.select);
    try { await executeRun(task.childRunId!); } finally { failSelect.mockRestore(); }
    expect(runHost().tracked()).not.toContain(task.childRunId);
    expect((await getRun(task.childRunId!))?.status).toBe("running");
    await db.update(schema.agentRuns).set({ heartbeatAt: sql`now() - interval '2 minutes'` }).where(eq(schema.agentRuns.id, task.childRunId!));
    await sweepRuns(); await executeRun(task.childRunId!);
    expect((await getRun(task.childRunId!))?.status).toBe("interrupted");
    expect(await db.select().from(schema.usageEvents).where(eq(schema.usageEvents.runId, task.childRunId!))).toHaveLength(0);
  });

  it("does not reset the model-step budget on continuation", async () => {
    const { db, schema } = await import("@/db");
    const { executeRun } = await import("@/lib/runs/execute");
    const { getRun } = await import("@/lib/runs/state");
    const { reconcileAsyncParent } = await import("@/lib/delegation/async");
    const setup = await checkpoint(); setup.native.maxSteps = 1; await setup.suspend(); const [task] = await assignments(setup.run.id);
    await finishChild(task.childRunId!); await reconcileAsyncParent(setup.run.id); await executeRun(setup.run.id);
    expect(await getRun(setup.run.id)).toMatchObject({ status: "failed", error: expect.stringContaining("budget") });
    expect(await db.select().from(schema.usageEvents).where(eq(schema.usageEvents.runId, setup.run.id))).toHaveLength(0);
  });

  it("expires suspended parents and refuses duplicate automatic attempts", async () => {
    const { db, schema } = await import("@/db");
    const { startAsyncDelegation, reconcileAsyncParent } = await import("@/lib/delegation/async");
    const { getRun } = await import("@/lib/runs/state");
    const setup = await checkpoint();
    await expect(startAsyncDelegation(setup.ctx, receiverId, "Assignment 0", "different-provider-call")).rejects.toThrow("already started");
    await setup.suspend();
    await db.update(schema.agentRuns).set({ resumeState: { native: { ...setup.native, deadlineAt: Date.now() - 1 } } }).where(eq(schema.agentRuns.id, setup.run.id));
    await reconcileAsyncParent(setup.run.id);
    expect(await getRun(setup.run.id)).toMatchObject({ status: "failed", error: expect.stringContaining("deadline") });
  });

  it("rejects switching a queued native assignment to Hermes before it can call a provider", async () => {
    const { db, schema } = await import("@/db");
    const { executeRun } = await import("@/lib/runs/execute");
    const { getRun } = await import("@/lib/runs/state");
    const setup = await checkpoint(); await setup.suspend(); const [task] = await assignments(setup.run.id);
    await db.update(schema.aiApps).set({ provider: "hermes" }).where(eq(schema.aiApps.id, appId));
    try {
      await executeRun(task.childRunId!);
      expect((await getRun(task.childRunId!))?.status).toBe("failed");
      expect(await db.select().from(schema.usageEvents).where(eq(schema.usageEvents.runId, task.childRunId!))).toHaveLength(0);
    } finally { await db.update(schema.aiApps).set({ provider: "openai" }).where(eq(schema.aiApps.id, appId)); }
  });

  it("rotates recovery batches so more than 100 waiting parents cannot starve a completed task", async () => {
    const { db, schema } = await import("@/db");
    const { newId } = await import("@/lib/ids");
    const { getRun } = await import("@/lib/runs/state");
    const { reconcileAsyncTasks } = await import("@/lib/delegation/async");
    const setup = await checkpoint(); await setup.suspend(); const [task] = await assignments(setup.run.id);
    const child = (await getRun(task.childRunId!))!;
    // Bulk fixtures deliberately bypass per-user admission limits to exercise the global recovery batch.
    for (let i = 0; i < 100; i++) {
      const parentId = newId(), childId = newId(), parentConversation = newId(), childConversation = newId(), taskId = newId(), messageId = newId();
      await db.insert(schema.conversations).values([
        { id: parentConversation, userId, botId: sourceId },
        { id: childConversation, userId, botId: receiverId, source: "delegation" },
      ]);
      await db.insert(schema.agentRuns).values([
        { ...setup.run, id: parentId, conversationId: parentConversation, messageId, parentMessageId: null, status: "waiting_tasks", holder: null,
          resumeState: { native: { ...setup.native, taskIds: [taskId] } }, updatedAt: new Date(Date.now() - 100_000 + i) },
        { ...child, id: childId, conversationId: childConversation, messageId: newId(), parentMessageId: null },
      ]);
      await db.insert(schema.delegatedTasks).values({ ...task, id: taskId, parentRunId: parentId, originConversationId: parentConversation,
        originMessageId: messageId, rootTaskId: taskId, rootMessageId: messageId, childRunId: childId, childConversationId: childConversation });
    }
    await finishChild(child.id);
    await reconcileAsyncTasks();
    expect((await getRun(setup.run.id))?.status).toBe("waiting_tasks");
    await reconcileAsyncTasks();
    expect(await getRun(setup.run.id)).toMatchObject({ status: "queued", segment: 1 });
  }, 30_000);

  it("denies a captured builtin after its tool permission is removed, before invoking its effect", async () => {
    const { db, schema } = await import("@/db");
    const toolsets = await import("@/lib/agent/toolset");
    const { executeRun } = await import("@/lib/runs/execute");
    const { getRun } = await import("@/lib/runs/state");
    const setup = await checkpoint(); await setup.suspend(); const [task] = await assignments(setup.run.id);
    const child = (await getRun(task.childRunId!))!;
    await db.update(schema.messages).set({ parts: [{ type: "text", text: '[tool:fetch_url {"url":"https://example.invalid"}]' }] }).where(eq(schema.messages.id, child.parentMessageId!));
    await db.insert(schema.botTools).values({ botId: receiverId, toolKey: "fetch_url", approval: "auto" });
    const effect = vi.fn(async () => "Synthetic effect; no network");
    const realBuild = toolsets.buildToolset;
    let captured = false;
    const build = vi.spyOn(toolsets, "buildToolset").mockImplementation(async ctx => {
      const result = await realBuild(ctx);
      if (ctx.taskId === task.id) {
        expect(result.tools.fetch_url).toBeDefined();
        result.tools.fetch_url.execute = effect;
        await db.delete(schema.botTools).where(and(eq(schema.botTools.botId, receiverId), eq(schema.botTools.toolKey, "fetch_url")));
        captured = true;
      }
      return result;
    });
    try {
      await executeRun(child.id);
      expect(captured).toBe(true); expect(effect).not.toHaveBeenCalled();
      const [message] = await db.select().from(schema.messages).where(eq(schema.messages.id, child.messageId));
      expect(JSON.stringify(message.parts)).toContain("permissions or configuration changed");
    } finally { build.mockRestore(); await db.delete(schema.botTools).where(eq(schema.botTools.botId, receiverId)); }
  });

  it("allows terminal owner replay after the parent finishes without retaining execution authority", async () => {
    const { db, schema } = await import("@/db");
    const { authorizeTaskRead } = await import("@/lib/delegation/view");
    const { assertTaskExecution } = await import("@/lib/delegation/store");
    const setup = await checkpoint(); await setup.suspend(); const [task] = await assignments(setup.run.id);
    await finishChild(task.childRunId!);
    await db.update(schema.agentRuns).set({ status: "succeeded" }).where(eq(schema.agentRuns.id, setup.run.id));
    await expect(authorizeTaskRead(setup.principal, task.childConversationId!, task.childRunId!)).resolves.toBeUndefined();
    await expect(assertTaskExecution(task)).rejects.toThrow("no longer running");
    await db.update(schema.users).set({ sessionVersion: setup.principal.user.sessionVersion + 1 }).where(eq(schema.users.id, userId));
    try { await expect(authorizeTaskRead(setup.principal, task.childConversationId!, task.childRunId!)).rejects.toThrow("session changed"); }
    finally { await db.update(schema.users).set({ sessionVersion: setup.principal.user.sessionVersion }).where(eq(schema.users.id, userId)); }
  });

  it("resolves nested provenance from its stored root and rejects forged automatic edge authority", async () => {
    const { db, schema } = await import("@/db");
    const { resolveTaskSource } = await import("@/lib/delegation/source");
    const { assertTaskExecution } = await import("@/lib/delegation/store");
    const setup = await checkpoint(); await setup.suspend(); const [task] = await assignments(setup.run.id);
    const source = await resolveTaskSource(task);
    expect(source).toMatchObject({ userId, sessionVersion: setup.principal.user.sessionVersion, conversationId: setup.run.conversationId,
      runId: setup.run.id, messageId: setup.run.messageId, toolCallId: task.originToolCallId, inputHash: task.inputHash, run: { background: false }, conversation: { source: "chat" } });
    await expect(resolveTaskSource({ ...task, rootMessageId: "forged" })).rejects.toThrow("original authority");
    const [automatic] = await db.update(schema.delegatedTasks).set({ ancestry: [{ from: sourceId, to: receiverId, mode: "coordinator" }] }).where(eq(schema.delegatedTasks.id, task.id)).returning();
    await expect(assertTaskExecution(automatic)).rejects.toMatchObject({ status: 403 });
  });

  it("cancels a parent that suspends between Stop's initial read and its row lock", async () => {
    const { db } = await import("@/db");
    const { stopRuns } = await import("@/lib/runs/store");
    const { getRun } = await import("@/lib/runs/state");
    const { executeRun } = await import("@/lib/runs/execute");
    const setup = await checkpoint(); const [task] = await assignments(setup.run.id);
    const realTransaction = db.transaction.bind(db);
    const transaction = vi.spyOn(db, "transaction").mockImplementationOnce(async (...args: Parameters<typeof db.transaction>) => {
      await setup.suspend();
      return realTransaction(...args);
    });
    try { await stopRuns(setup.principal, setup.run.conversationId); }
    finally { transaction.mockRestore(); }
    expect((await getRun(setup.run.id))?.status).toBe("cancelled");
    await executeRun(task.childRunId!);
    expect(await getRun(task.childRunId!)).toMatchObject({ status: "cancelled", startedAt: null });
  });

  it("retains unattended policy and queue after an automatic routine continuation", async () => {
    const { db, schema } = await import("@/db");
    const { getRun } = await import("@/lib/runs/state");
    const { executeRun } = await import("@/lib/runs/execute");
    const { reconcileAsyncParent } = await import("@/lib/delegation/async");
    const { getSetting, setSetting } = await import("@/lib/settings");
    const { runQueue, QUEUES } = await import("@/lib/jobs");
    const setup = await checkpoint(); const [task] = await assignments(setup.run.id);
    Object.assign(setup.native, { background: true });
    await db.update(schema.agentRuns).set({ background: true }).where(eq(schema.agentRuns.id, setup.run.id));
    await db.update(schema.conversations).set({ source: "routine" }).where(eq(schema.conversations.id, setup.run.conversationId));
    await setup.suspend(); await finishChild(task.childRunId!);
    const previous = await getSetting("chatgpt");
    try {
      await setSetting("chatgpt", { ...previous, enabled: true, access: "everyone", allowBackground: false });
      await db.update(schema.aiApps).set({ provider: "chatgpt", credentialMode: "user" }).where(eq(schema.aiApps.id, appId));
      await reconcileAsyncParent(setup.run.id);
      const resumed = (await getRun(setup.run.id))!;
      expect(runQueue(resumed)).toBe(QUEUES.agentRunBackground);
      await executeRun(resumed.id);
      expect(await getRun(resumed.id)).toMatchObject({ status: "failed", error: expect.stringContaining("routines can't use") });
      expect(await db.select().from(schema.usageEvents).where(eq(schema.usageEvents.runId, resumed.id))).toHaveLength(0);
    } finally {
      await setSetting("chatgpt", previous);
      await db.update(schema.aiApps).set({ provider: "openai", credentialMode: "org" }).where(eq(schema.aiApps.id, appId));
    }
  });

  it("rejects a same-ID connection change before a captured model is dispatched", async () => {
    const { db, schema } = await import("@/db");
    const toolsets = await import("@/lib/agent/toolset");
    const { executeRun } = await import("@/lib/runs/execute");
    const { getRun } = await import("@/lib/runs/state");
    const setup = await checkpoint(); await setup.suspend(); const [task] = await assignments(setup.run.id);
    const realBuild = toolsets.buildToolset;
    const build = vi.spyOn(toolsets, "buildToolset").mockImplementation(async ctx => {
      const result = await realBuild(ctx);
      if (ctx.taskId === task.id) await db.update(schema.aiApps).set({ model: "changed-after-capture" }).where(eq(schema.aiApps.id, appId));
      return result;
    });
    try {
      await executeRun(task.childRunId!);
      expect(await getRun(task.childRunId!)).toMatchObject({ status: "failed", error: expect.stringContaining("permissions or configuration changed") });
      expect(await db.select().from(schema.usageEvents).where(eq(schema.usageEvents.runId, task.childRunId!))).toHaveLength(0);
    } finally {
      build.mockRestore(); await db.update(schema.aiApps).set({ model: "mock-gpt" }).where(eq(schema.aiApps.id, appId));
    }
  });

  it("excludes suspended routines from the bounded orphan-recovery batch", async () => {
    const { db, schema } = await import("@/db");
    const { sweepRuns } = await import("@/lib/runs/sweeper");
    const setup = await checkpoint(); await setup.suspend();
    const [routine] = await db.insert(schema.routines).values({ ownerId: userId, botId: sourceId, name: "Waiting fixture", prompt: "Assignment", triggerType: "webhook" }).returning();
    const [rr] = await db.insert(schema.routineRuns).values({ routineId: routine.id, trigger: "manual", status: "running", conversationId: setup.conversation.id,
      createdAt: new Date(Date.now() - 180_000) }).returning();
    await db.update(schema.agentRuns).set({ routineRunId: rr.id }).where(eq(schema.agentRuns.id, setup.run.id));
    expect((await sweepRuns()).routines).toBe(0);
    expect((await db.select().from(schema.routineRuns).where(eq(schema.routineRuns.id, rr.id)))[0].status).toBe("running");
  });

  it("runs a coordinator assignment without a manual edge using its durable human source", async () => {
    const { db, schema } = await import("@/db");
    const { executeRun } = await import("@/lib/runs/execute");
    const { getRun } = await import("@/lib/runs/state");
    const { assertDelegationPath } = await import("@/lib/coordinator/delegation");
    const { getSetting } = await import("@/lib/settings");
    const { newUsageScope } = await import("@/lib/llm");
    await enableAutomatic(); const setup = await createParent();
    await executeRun(setup.run.id); const [task] = await assignments(setup.run.id);
    expect(task.ancestry).toEqual([{ from: sourceId, to: receiverId, mode: "coordinator" }]);
    const [receiver] = await db.select().from(schema.bots).where(eq(schema.bots.id, receiverId));
    const child = (await getRun(task.childRunId!))!;
    expect(child).toMatchObject({ background: true, status: "queued", userId });
    expect(child.conversationId).not.toBe(setup.conversation.id);
    const ctx: AgentCtx = { principal: setup.principal, bot: receiver, app: setup.app, background: true,
      conversationId: child.conversationId, taskId: task.id, depth: 1, delegationPath: task.ancestry,
      usage: newUsageScope({ runId: child.id, messageId: child.messageId }), toolSettings: await getSetting("tools") };
    // This is also the shared MCP path gate; background is not spoofed to bypass the direct-source rule.
    expect((await assertDelegationPath(ctx)).user.id).toBe(userId);
    const { authorizeMcpInvocation, mcpAuthorityBinding } = await import("@/lib/mcp/authorization");
    const { setSetting } = await import("@/lib/settings");
    const def = { name: "read", inputSchema: { type: "object" as const, properties: {} } };
    const [server] = await db.insert(schema.mcpServers).values({ name: "Authorization only", url: "http://127.0.0.1:1/mcp", isPublic: true,
      status: "enabled", toolsSnapshot: [def] }).returning();
    const config = { tools: ["read"] };
    await db.insert(schema.botTools).values({ botId: receiverId, toolKey: `mcp:${server.id}`, config });
    try {
      const binding = await mcpAuthorityBinding(ctx, server, config, []);
      // Authorization only: no MCP client is created and no network request is made.
      expect((await authorizeMcpInvocation(ctx, binding, server, def, {})).principal.user.id).toBe(userId);
      await setSetting("coordinator", { enabled: false, defaultBotId: null, starterBotId: null });
      await expect(authorizeMcpInvocation(ctx, binding, server, def, {})).rejects.toMatchObject({ status: 403 });
      await setSetting("coordinator", { enabled: true, defaultBotId: sourceId, starterBotId: null });
      await db.update(schema.mcpServers).set({ isPublic: false }).where(eq(schema.mcpServers.id, server.id));
      await expect(authorizeMcpInvocation(ctx, binding, server, def, {})).rejects.toMatchObject({ status: 403 });
    } finally {
      await db.delete(schema.botTools).where(and(eq(schema.botTools.botId, receiverId), eq(schema.botTools.toolKey, `mcp:${server.id}`)));
      await db.delete(schema.mcpServers).where(eq(schema.mcpServers.id, server.id));
    }
    await executeRun(child.id); await executeRun(setup.run.id);
    expect((await getRun(setup.run.id))?.status).toBe("succeeded");
    expect((await assignments(setup.run.id))[0].returnedAt).not.toBeNull();
    expect(await db.select().from(schema.botDelegates).where(eq(schema.botDelegates.botId, sourceId))).toHaveLength(0);
  });

  it("retains a coordinator first edge and manual nested edge across two async waits", async () => {
    const { executeRun } = await import("@/lib/runs/execute");
    const { getRun } = await import("@/lib/runs/state");
    await enableAutomatic(); const { run } = await createParent("delegate [async] delegate [async] explain cats");
    await executeRun(run.id); const [first] = await assignments(run.id);
    await executeRun(first.childRunId!); const [second] = await assignments(first.childRunId!);
    expect(second.ancestry).toEqual([{ from: sourceId, to: receiverId, mode: "coordinator" }, { from: receiverId, to: nestedId }]);
    await executeRun(second.childRunId!); await executeRun(first.childRunId!); await executeRun(run.id);
    expect((await getRun(run.id))?.status).toBe("succeeded");
  });

  it("withholds a completed coordinator answer when opt-in is revoked before result return", async () => {
    const { db, schema } = await import("@/db");
    const { executeRun } = await import("@/lib/runs/execute");
    const { reconcileAsyncParent } = await import("@/lib/delegation/async");
    const { readEvents } = await import("@/lib/runs/log");
    await enableAutomatic(); const { run } = await createParent(); await executeRun(run.id);
    const [task] = await assignments(run.id);
    await finishChild(task.childRunId!, "Revoked answer marker 7294");
    await db.update(schema.bots).set({ coordinatorEligible: false }).where(eq(schema.bots.id, receiverId));
    await reconcileAsyncParent(run.id);
    const [saved] = await db.select().from(schema.messages).where(eq(schema.messages.id, run.messageId));
    expect(JSON.stringify(saved.parts)).toContain("no longer authorized");
    expect(JSON.stringify(saved.parts)).not.toContain("Revoked answer marker 7294");
    expect(JSON.stringify(await readEvents(run.id, 0, 1000))).not.toContain("Revoked answer marker 7294");
  });

  it("rejects a queued receiver converted to a service bot without borrowing another pool connection", async () => {
    const { db, schema } = await import("@/db");
    const { executeRun } = await import("@/lib/runs/execute");
    const { getRun } = await import("@/lib/runs/state");
    const { serviceConfigHash } = await import("@/lib/bots/service");
    await enableAutomatic(); const { run } = await createParent(); await executeRun(run.id);
    const [task] = await assignments(run.id);
    await db.delete(schema.botDelegates).where(eq(schema.botDelegates.botId, receiverId));
    const [service] = await db.update(schema.bots).set({ executionMode: "service" }).where(eq(schema.bots.id, receiverId)).returning();
    await db.update(schema.bots).set({ publishedRevision: service.revision, publishedConfigHash: await serviceConfigHash(service) }).where(eq(schema.bots.id, receiverId));
    await executeRun(task.childRunId!);
    expect((await getRun(task.childRunId!))?.status).toBe("failed");
    expect(await db.select().from(schema.usageEvents).where(eq(schema.usageEvents.runId, task.childRunId!))).toHaveLength(0);
  });

  it.each(["selection", "opt-in", "model-audience", "tool-capability", "archive", "routine-source"])("rechecks coordinator %s before queued dispatch", async change => {
    const { db, schema } = await import("@/db");
    const { executeRun } = await import("@/lib/runs/execute");
    const { getRun } = await import("@/lib/runs/state");
    const { setSetting } = await import("@/lib/settings");
    await enableAutomatic(); const { run } = await createParent(); await executeRun(run.id);
    const [task] = await assignments(run.id);
    if (change === "selection") await setSetting("coordinator", { enabled: false, defaultBotId: null, starterBotId: null });
    if (change === "opt-in") await db.update(schema.bots).set({ coordinatorEligible: false }).where(eq(schema.bots.id, receiverId));
    if (change === "model-audience") await db.update(schema.aiApps).set({ isPublic: false }).where(eq(schema.aiApps.id, appId));
    if (change === "tool-capability") await db.update(schema.aiApps).set({ supportsTools: false }).where(eq(schema.aiApps.id, appId));
    if (change === "archive") await db.update(schema.conversations).set({ archived: true }).where(eq(schema.conversations.id, run.conversationId));
    if (change === "routine-source") {
      await db.update(schema.conversations).set({ source: "routine" }).where(eq(schema.conversations.id, run.conversationId));
      await db.update(schema.agentRuns).set({ background: true }).where(eq(schema.agentRuns.id, run.id));
    }
    await executeRun(task.childRunId!);
    expect((await getRun(task.childRunId!))?.status).toBe("failed");
    expect(await db.select().from(schema.usageEvents).where(eq(schema.usageEvents.runId, task.childRunId!))).toHaveLength(0);
    const [saved] = await db.select().from(schema.messages).where(eq(schema.messages.id, run.messageId));
    expect(JSON.stringify(saved.parts)).not.toContain('You said:');
  });
});
