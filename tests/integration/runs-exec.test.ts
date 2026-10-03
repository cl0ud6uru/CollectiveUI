import { readUIMessageStream, type UIMessageChunk } from "ai";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startMockLlm } from "./helpers/mock-llm";

// A dev worker may be consuming agent.run on the same database: never send jobs from here (executeRun is called
// directly), and no memory-extraction jobs either.
const jobs = vi.hoisted(() => ({ enqueueRun: vi.fn<(runId: string, segment: number) => Promise<string>>(async () => "job") }));
vi.mock("@/lib/jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jobs")>()),
  enqueueRun: jobs.enqueueRun,
  enqueue: vi.fn(async () => null),
  scheduleMemoryExtraction: vi.fn(async () => {}),
  getBoss: () => Promise.reject(new Error("no pg-boss in tests")),
}));
// Keep turns self-contained: no embedding app (memory selection falls back to recent memories).
vi.mock("@/lib/llm/apps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/llm/apps")>()),
  embeddingApp: async () => undefined,
}));
// Counts turns (the claim race), otherwise the real agent loop.
vi.mock("@/lib/agent/run", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/agent/run")>();
  return { ...real, runTurn: vi.fn(real.runTurn) };
});

// Integration: needs DATABASE_URL pointing at a migrated database. Skipped otherwise.
const suite = process.env.DATABASE_URL ? describe : describe.skip;

type Part = { type: string; state?: string; text?: string; toolCallId?: string; approval?: { id: string; approved?: boolean }; output?: unknown };

suite("durable runs: the executor against Postgres and the mock LLM (integration)", () => {
  let mock: Awaited<ReturnType<typeof startMockLlm>>;
  const userId = `it-runs-${process.pid}-${Date.now()}`;
  let appId: string;
  let plainBotId: string;
  let toolBotId: string;

  beforeAll(async () => {
    mock = await startMockLlm();
    const { db } = await import("@/db");
    const { aiApps, botTools, bots, users } = await import("@/db/schema");
    const { newId } = await import("@/lib/ids");
    const { sealAppSecret } = await import("@/lib/llm/secrets");
    await db.insert(users).values({ id: userId, upn: `${userId}@corp.local`, name: "Runs Test", authSource: "ldap" });
    appId = newId();
    await db.insert(aiApps).values({
      id: appId,
      name: `IT runs ${userId}`,
      provider: "openai",
      baseUrl: `${mock.url}/v1`,
      apiKeyEnc: sealAppSecret(appId, "sk-integration"),
      model: "mock-gpt",
      supportsTools: true,
    });
    const [plain] = await db.insert(bots).values({ ownerId: userId, name: "IT plain bot", appId }).returning();
    const [tool] = await db.insert(bots).values({ ownerId: userId, name: "IT memory bot", appId, description: "Remembers things." }).returning();
    await db.insert(botTools).values({ botId: tool.id, toolKey: "memory", approval: "ask" });
    plainBotId = plain.id;
    toolBotId = tool.id;
    // Stop signals (NOTIFY c) reach running segments through the host's listener, as in the worker.
    const { runHost } = await import("@/lib/runs/host");
    runHost().start();
  });

  afterAll(async () => {
    const { db, pool } = await import("@/db");
    const { aiApps, usageEvents, users } = await import("@/db/schema");
    const { runListener } = await import("@/lib/runs/listener");
    await runListener().close();
    await db.delete(usageEvents).where(eq(usageEvents.userId, userId));
    await db.delete(users).where(eq(users.id, userId)); // cascades to bots, conversations, runs, events, routines, inbox
    if (appId) await db.delete(aiApps).where(eq(aiApps.id, appId));
    await pool.end();
    mock?.stop();
  });

  beforeEach(async () => {
    jobs.enqueueRun.mockClear();
    const { runTurn } = await import("@/lib/agent/run");
    vi.mocked(runTurn).mockClear();
  });

  async function principal() {
    const { loadPrincipal } = await import("@/lib/auth/groups");
    return (await loadPrincipal(userId))!;
  }

  /** A chat with the bot and a new turn for `text`, as the chat route starts it (user message + queued run). */
  async function startTurn(text: string, botId = plainBotId) {
    const { db } = await import("@/db");
    const { aiApps, bots, conversations } = await import("@/db/schema");
    const { newId } = await import("@/lib/ids");
    const { startRun } = await import("@/lib/runs/store");
    const [conversation] = await db.insert(conversations).values({ id: newId(), userId, botId, title: "IT" }).returning();
    const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
    const [app] = await db.select().from(aiApps).where(eq(aiApps.id, appId));
    const userMessage = { id: newId(), role: "user" as const, parts: [{ type: "text" as const, text }], metadata: { createdAt: Date.now() } };
    const run = await startRun({ principal: await principal(), conversation, bot, app, userMessage, parentId: null });
    return { conversation, run, userMessage };
  }

  async function runRow(runId: string) {
    const { getRun } = await import("@/lib/runs/state");
    return (await getRun(runId))!;
  }

  async function events(runId: string) {
    const { readEvents } = await import("@/lib/runs/log");
    return readEvents(runId, 0, 10_000);
  }

  async function savedMessage(id: string) {
    const { db } = await import("@/db");
    const { messages } = await import("@/db/schema");
    const [row] = await db.select().from(messages).where(eq(messages.id, id));
    return row;
  }

  /** What the resume endpoint would show: the whole log through replayFilter, reduced like the browser does. */
  async function replayed(runId: string) {
    const { replayFilter } = await import("@/lib/runs/replay");
    const run = await runRow(runId);
    const filter = replayFilter(run.segment);
    const chunks: UIMessageChunk[] = [];
    for (const e of await events(runId)) {
      const out = filter(e);
      if (out === "end") break;
      if (out) chunks.push(out);
    }
    const stream = new ReadableStream<UIMessageChunk>({
      start(c) {
        chunks.forEach((ch) => c.enqueue(ch));
        c.close();
      },
    });
    let last: { parts: unknown[] } | undefined;
    for await (const m of readUIMessageStream({ stream })) last = m;
    return last!;
  }

  function expectContiguousLog(evs: Awaited<ReturnType<typeof events>>, lastSeq: number) {
    expect(evs.map((e) => e.seq)).toEqual(Array.from({ length: lastSeq }, (_, i) => i + 1));
    expect(evs.at(-1)!.kind).toBe("segment-end");
  }

  const textOf = (parts: unknown[]) =>
    (parts as Part[])
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("");

  const approvalIdOf = (parts: unknown[]) => (parts as Part[]).find((p) => p.state === "approval-requested")!.approval!.id;

  it("plain reply: contiguous events ending with segment-end, message saved, usage linked to the run, succeeded", { timeout: 30_000 }, async () => {
    const { db } = await import("@/db");
    const { conversations, usageEvents } = await import("@/db/schema");
    const { executeRun } = await import("@/lib/runs/execute");
    const { conversation, run } = await startTurn("hello durable runs");
    expect(jobs.enqueueRun).toHaveBeenCalledWith(expect.objectContaining({ id: run.id, segment: 0 }));

    await executeRun(run.id);
    const after = await runRow(run.id);
    expect(after).toMatchObject({ status: "succeeded", holder: null, error: null, billingSource: "org" });
    expect(after.finishedAt).toBeTruthy();
    const evs = await events(run.id);
    expectContiguousLog(evs, after.lastSeq);
    expect(evs[0].chunk).toMatchObject({ type: "start", messageId: run.messageId });

    const row = await savedMessage(run.messageId);
    expect(row).toMatchObject({ role: "assistant", parentId: run.parentMessageId, appId, billingSource: "org" });
    expect(textOf(row.parts)).toContain('You said: "hello durable runs"');
    expect((await replayed(run.id)).parts).toEqual(row.parts);
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, conversation.id));
    expect(conv.currentLeafId).toBe(run.messageId);

    const usage = await db.select().from(usageEvents).where(eq(usageEvents.runId, run.id));
    expect(usage.length).toBeGreaterThanOrEqual(1);
    expect(usage.every((u) => u.messageId === run.messageId && u.userId === userId)).toBe(true);
  });

  it("approval: waiting (card saved, segment-end) → continueRun → second segment succeeds; the replay equals the saved message", { timeout: 60_000 }, async () => {
    const { db } = await import("@/db");
    const { memories } = await import("@/db/schema");
    const { executeRun } = await import("@/lib/runs/execute");
    const { continueRun } = await import("@/lib/runs/store");
    const { conversation, run } = await startTurn('[tool:remember {"fact":"likes durable tea"}]', toolBotId);

    await executeRun(run.id);
    const paused = await runRow(run.id);
    expect(paused).toMatchObject({ status: "waiting", segment: 0, holder: null });
    expectContiguousLog(await events(run.id), paused.lastSeq);
    const card = await savedMessage(run.messageId);
    const approvalId = approvalIdOf(card.parts);

    const requeued = await continueRun({ principal: await principal(), conversation, messageId: run.messageId, decisions: new Map([[approvalId, { approved: true }]]) });
    expect(requeued).toMatchObject({ status: "queued", segment: 1, boundarySeq: paused.lastSeq + 1 });
    expect(jobs.enqueueRun).toHaveBeenLastCalledWith(expect.objectContaining({ id: run.id, segment: 1 }));

    await executeRun(run.id);
    const done = await runRow(run.id);
    expect(done).toMatchObject({ status: "succeeded", segment: 1 });
    const evs = await events(run.id);
    expectContiguousLog(evs, done.lastSeq);
    // One segment-end per segment, and the second segment's events follow the boundary.
    expect(evs.filter((e) => e.kind === "segment-end").map((e) => e.segment)).toEqual([0, 1]);
    expect(evs.filter((e) => e.seq > requeued.boundarySeq).every((e) => e.segment === 1)).toBe(true);

    const row = await savedMessage(run.messageId);
    const tool = (row.parts as Part[]).find((p) => p.toolCallId)!;
    expect(tool.state).toBe("output-available");
    expect(textOf(row.parts)).toContain("The `remember` tool returned");
    expect((await replayed(run.id)).parts).toEqual(row.parts);
    const saved = await db.select().from(memories).where(eq(memories.userId, userId));
    expect(saved.some((m) => m.content === "likes durable tea")).toBe(true);
  });

  it("deny: the continuation runs no tool and succeeds with the tool denied", { timeout: 60_000 }, async () => {
    const { db } = await import("@/db");
    const { memories } = await import("@/db/schema");
    const { executeRun } = await import("@/lib/runs/execute");
    const { continueRun } = await import("@/lib/runs/store");
    const { conversation, run } = await startTurn('[tool:remember {"fact":"never stored"}]', toolBotId);
    await executeRun(run.id);
    const approvalId = approvalIdOf((await savedMessage(run.messageId)).parts);
    await continueRun({ principal: await principal(), conversation, messageId: run.messageId, decisions: new Map([[approvalId, { approved: false, reason: "no" }]]) });
    await executeRun(run.id);
    expect((await runRow(run.id)).status).toBe("succeeded");
    const tool = ((await savedMessage(run.messageId)).parts as Part[]).find((p) => p.toolCallId)!;
    expect(tool.state).toBe("output-denied");
    const saved = await db.select().from(memories).where(eq(memories.userId, userId));
    expect(saved.some((m) => m.content === "never stored")).toBe(false);
  });

  it("stop mid-reply ([slow]): requestCancelTx + NOTIFY → cancelled with the partial reply saved", { timeout: 60_000 }, async () => {
    const { db } = await import("@/db");
    const { executeRun } = await import("@/lib/runs/execute");
    const { requestCancelTx } = await import("@/lib/runs/state");
    const { run } = await startTurn("[slow] please tell me a fairly long story about durable runs and workers and queues");
    const executing = executeRun(run.id);
    // Wait for the first streamed text in the log.
    await vi.waitFor(
      async () => {
        const evs = await events(run.id);
        expect(evs.some((e) => e.chunk?.type === "text-delta")).toBe(true);
      },
      { timeout: 15_000, interval: 100 },
    );
    const t0 = Date.now();
    expect(await db.transaction((tx) => requestCancelTx(tx, run.id))).toBe("running");
    await executing;
    expect(Date.now() - t0).toBeLessThan(5_000);

    const after = await runRow(run.id);
    expect(after).toMatchObject({ status: "cancelled", error: null });
    const evs = await events(run.id);
    expectContiguousLog(evs, after.lastSeq);
    // The provider's "request failed" caused by the abort isn't shown as an error.
    expect(evs.some((e) => e.chunk?.type === "error")).toBe(false);
    const row = await savedMessage(run.messageId);
    const partial = textOf(row.parts);
    expect(partial.length).toBeGreaterThan(0);
    expect(partial).not.toContain("workers and queues");
    expect((row.parts as Part[]).every((p) => p.state !== "streaming")).toBe(true);
  });

  it("sweeper: a stale running run is interrupted, its message rebuilt from the log and saved", { timeout: 30_000 }, async () => {
    const { db } = await import("@/db");
    const { agentRuns, conversations } = await import("@/db/schema");
    const { appendEvents } = await import("@/lib/runs/log");
    const { claimRun } = await import("@/lib/runs/state");
    const { sweepRuns, WORKER_LOST } = await import("@/lib/runs/sweeper");
    const { conversation, run } = await startTurn("this worker will die");
    // A worker claimed it, streamed a little, then died (its heartbeat stops).
    expect(await claimRun(run.id, "dead-worker:1:0000")).toBeTruthy();
    const chunks: UIMessageChunk[] = [
      { type: "start", messageId: run.messageId },
      { type: "start-step" },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "Partial answ" },
      { type: "data-title", data: { title: "x" }, transient: true } as UIMessageChunk,
    ];
    await appendEvents(
      run.id,
      0,
      chunks.map((chunk) => ({ kind: "chunk" as const, chunk, transient: chunk.type === "data-title" })),
      { holder: "dead-worker:1:0000" },
    );
    await db
      .update(agentRuns)
      .set({ heartbeatAt: sql`now() - interval '10 minutes'` })
      .where(eq(agentRuns.id, run.id));

    const res = await sweepRuns();
    expect(res.interrupted).toBeGreaterThanOrEqual(1);
    const after = await runRow(run.id);
    expect(after).toMatchObject({ status: "interrupted", error: WORKER_LOST, holder: null });
    const evs = await events(run.id);
    expectContiguousLog(evs, after.lastSeq);
    expect(evs.slice(-4).map((e) => e.chunk?.type ?? e.kind)).toEqual(["text-end", "data-run-error", "error", "segment-end"]);

    const row = await savedMessage(run.messageId);
    // The reply keeps a note saying why it ended (shown after a reload, unlike the stream's error chunk).
    expect(row.parts).toEqual([
      { type: "step-start" },
      { type: "text", text: "Partial answ", state: "done" },
      { type: "data-run-error", data: { message: WORKER_LOST } },
    ]);
    expect((await replayed(run.id)).parts).toEqual(row.parts);
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, conversation.id));
    expect(conv.currentLeafId).toBe(run.messageId);

    // The old executor's writes are fenced off now.
    const { withRunFence } = await import("@/lib/runs/state");
    expect(await withRunFence(run.id, "dead-worker:1:0000", async () => "written")).toBeNull();
  });

  it("sweeper: re-enqueues lost queued runs, cancels queued runs with a pending stop, deletes old events", { timeout: 30_000 }, async () => {
    const { db } = await import("@/db");
    const { agentRuns } = await import("@/db/schema");
    const { executeRun } = await import("@/lib/runs/execute");
    const { requestCancelTx } = await import("@/lib/runs/state");
    const { sweepRuns } = await import("@/lib/runs/sweeper");
    const ago = (col: typeof agentRuns.updatedAt | typeof agentRuns.finishedAt, minutes: number) =>
      sql`now() - ${minutes}::int * interval '1 minute'`.mapWith(col);

    const lost = await startTurn("nobody picked this up");
    const stopped = await startTurn("stopped before any worker claimed it");
    await db.transaction((tx) => requestCancelTx(tx, stopped.run.id));
    const old = await startTurn("finished long ago");
    await executeRun(old.run.id);
    expect((await events(old.run.id)).length).toBeGreaterThan(0);
    await db
      .update(agentRuns)
      .set({ updatedAt: ago(agentRuns.updatedAt, 10) })
      .where(inArray(agentRuns.id, [lost.run.id, stopped.run.id]));
    await db
      .update(agentRuns)
      .set({ finishedAt: ago(agentRuns.finishedAt, 3 * 24 * 60) })
      .where(eq(agentRuns.id, old.run.id));
    jobs.enqueueRun.mockClear();

    const res = await sweepRuns();
    expect(jobs.enqueueRun).toHaveBeenCalledWith({ id: lost.run.id, segment: 0, background: false });
    expect(jobs.enqueueRun).not.toHaveBeenCalledWith(stopped.run.id, expect.anything());
    expect(res.requeued).toBeGreaterThanOrEqual(1);
    expect(res.cancelled).toBeGreaterThanOrEqual(1);
    const lostAfter = await runRow(lost.run.id);
    expect(lostAfter.status).toBe("queued");
    expect(Date.now() - lostAfter.updatedAt.getTime()).toBeLessThan(60_000); // touched: the next sweep waits again
    const stoppedAfter = await runRow(stopped.run.id);
    expect(stoppedAfter.status).toBe("cancelled");
    expectContiguousLog(await events(stopped.run.id), stoppedAfter.lastSeq);
    expect(res.purged).toBeGreaterThan(0);
    expect(await events(old.run.id)).toEqual([]);
    expect((await runRow(old.run.id)).status).toBe("succeeded");
  });

  it("claim race: two executors for one run → one turn", { timeout: 30_000 }, async () => {
    const { runTurn } = await import("@/lib/agent/run");
    const { executeRun } = await import("@/lib/runs/execute");
    const { run } = await startTurn("only once please");
    await Promise.all([executeRun(run.id), executeRun(run.id)]);
    expect(vi.mocked(runTurn)).toHaveBeenCalledTimes(1);
    expect((await runRow(run.id)).status).toBe("succeeded");
    expect((await events(run.id)).filter((e) => e.kind === "segment-end")).toHaveLength(1);
  });

  it("routine: executeRoutineRun creates a background run; it pauses into the Inbox, continues and succeeds (hooks once each)", { timeout: 60_000 }, async () => {
    const { db } = await import("@/db");
    const { agentRuns, conversations, inboxItems, routineRuns, routines } = await import("@/db/schema");
    const { executeRoutineRun } = await import("@/lib/agent/routine-runner");
    const { executeRun } = await import("@/lib/runs/execute");
    const { continueRun } = await import("@/lib/runs/store");
    const [routine] = await db
      .insert(routines)
      .values({ ownerId: userId, botId: toolBotId, name: "IT routine", prompt: '[tool:remember {"fact":"routine fact"}]', triggerType: "webhook" })
      .returning();
    const [rr] = await db.insert(routineRuns).values({ routineId: routine.id, trigger: "manual" }).returning();

    await executeRoutineRun(rr.id);
    await executeRoutineRun(rr.id); // a duplicate job claims nothing
    const [started] = await db.select().from(routineRuns).where(eq(routineRuns.id, rr.id));
    expect(started.status).toBe("running");
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.routineRunId, rr.id));
    expect(run).toMatchObject({ status: "queued", background: true, userId, conversationId: started.conversationId, botId: toolBotId, appId });
    expect(jobs.enqueueRun).toHaveBeenCalledTimes(1);
    expect(jobs.enqueueRun).toHaveBeenCalledWith(expect.objectContaining({ id: run.id, segment: 0, background: true }));
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, run.conversationId));
    expect(conv).toMatchObject({ source: "routine", currentLeafId: run.parentMessageId });
    const [r2] = await db.select().from(routines).where(eq(routines.id, routine.id));
    expect(r2.lastRunAt).toBeTruthy();

    await executeRun(run.id);
    expect((await runRow(run.id)).status).toBe("waiting");
    const [waiting] = await db.select().from(routineRuns).where(eq(routineRuns.id, rr.id));
    expect(waiting.status).toBe("awaiting_approval");

    const approvalId = approvalIdOf((await savedMessage(run.messageId)).parts);
    await continueRun({ principal: await principal(), conversation: conv, messageId: run.messageId, decisions: new Map([[approvalId, { approved: true }]]) });
    await executeRun(run.id);
    expect((await runRow(run.id)).status).toBe("succeeded");
    const [finished] = await db.select().from(routineRuns).where(eq(routineRuns.id, rr.id));
    expect(finished).toMatchObject({ status: "succeeded", error: null });
    expect(finished.finishedAt).toBeTruthy();

    const items = await db.select().from(inboxItems).where(and(eq(inboxItems.routineRunId, rr.id), inArray(inboxItems.kind, ["approval", "routine_result", "routine_error"])));
    expect(items.map((i) => i.kind).sort()).toEqual(["approval", "routine_result"]);
    expect(items.find((i) => i.kind === "routine_result")!.body).toContain("The `remember` tool returned");
  });

  it("routine whose bot the owner can't use fails with an Inbox error and no run", { timeout: 30_000 }, async () => {
    const { db } = await import("@/db");
    const { agentRuns, aiApps, bots, inboxItems, routineRuns, routines } = await import("@/db/schema");
    const { executeRoutineRun } = await import("@/lib/agent/routine-runner");
    const { newId } = await import("@/lib/ids");
    const disabledAppId = newId();
    await db.insert(aiApps).values({ id: disabledAppId, name: `IT disabled ${userId}`, provider: "openai", baseUrl: `${mock.url}/v1`, model: "mock-gpt", enabled: false });
    try {
      const [bot] = await db.insert(bots).values({ ownerId: userId, name: "IT dead bot", appId: disabledAppId }).returning();
      const [routine] = await db.insert(routines).values({ ownerId: userId, botId: bot.id, name: "IT broken routine", prompt: "hi", triggerType: "webhook" }).returning();
      const [rr] = await db.insert(routineRuns).values({ routineId: routine.id, trigger: "manual" }).returning();
      await executeRoutineRun(rr.id);
      const [after] = await db.select().from(routineRuns).where(eq(routineRuns.id, rr.id));
      expect(after).toMatchObject({ status: "failed", error: "IT dead bot has no enabled model endpoint" });
      expect(await db.select().from(agentRuns).where(eq(agentRuns.routineRunId, rr.id))).toHaveLength(0);
      const items = await db.select().from(inboxItems).where(eq(inboxItems.routineRunId, rr.id));
      expect(items.map((i) => i.kind)).toEqual(["routine_error"]);
      expect(jobs.enqueueRun).not.toHaveBeenCalled();
    } finally {
      await db.delete(bots).where(eq(bots.appId, disabledAppId));
      await db.delete(aiApps).where(eq(aiApps.id, disabledAppId));
    }
  });
  it("a NUL in a tool's output (e.g. a fetched binary file) reaches the log and the saved reply instead of breaking them", { timeout: 30_000 }, async () => {
    const { db } = await import("@/db");
    const { agentRuns } = await import("@/db/schema");
    const { appendEvents } = await import("@/lib/runs/log");
    const { upsertMessage } = await import("@/lib/chat/store");
    const t = await startTurn("hi");
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, t.run.id));
    const bad = { type: "tool-output-available", toolCallId: "c1", output: { content: "%PDF-1.4\u0000\u0000binary" } } as never;
    const res = await appendEvents(run.id, 0, [{ kind: "chunk", chunk: bad }]);
    expect(res?.lastSeq).toBeGreaterThan(0);
    const [ev] = (await events(run.id)).slice(-1);
    expect((ev.chunk as unknown as { output: { content: string } }).output.content).toBe("%PDF-1.4\ufffd\ufffdbinary");
    const msg = { id: run.messageId, role: "assistant", parts: [{ type: "text", text: "a\u0000b", state: "done" }], metadata: {} } as never;
    await upsertMessage(run.conversationId, msg, run.parentMessageId);
    expect((await savedMessage(run.messageId)).parts).toEqual([{ type: "text", text: "a\ufffdb", state: "done" }]);
  });

  it("sweeper: a routine run whose hook was lost follows its finished agent run; one whose conversation was deleted fails", { timeout: 30_000 }, async () => {
    const { db } = await import("@/db");
    const { agentRuns, conversations, inboxItems, routineRuns, routines } = await import("@/db/schema");
    const { sweepRuns } = await import("@/lib/runs/sweeper");
    const old = sql`now() - interval '10 minutes'`;
    const [routine] = await db.insert(routines).values({ ownerId: userId, botId: plainBotId, name: "IT reconcile", prompt: "x", triggerType: "webhook" }).returning();
    // (a) Its agent run succeeded, but the worker died before the routine's bookkeeping.
    const t = await startTurn("done already");
    const [rrA] = await db.insert(routineRuns).values({ routineId: routine.id, trigger: "manual", status: "running", conversationId: t.conversation.id, createdAt: old as never }).returning();
    await db.update(agentRuns).set({ routineRunId: rrA.id, status: "succeeded", finishedAt: sql`now()` }).where(eq(agentRuns.id, t.run.id));
    // (b) Its conversation was deleted (the agent run went with it).
    const [convB] = await db.insert(conversations).values({ userId, botId: plainBotId, source: "routine" }).returning();
    const [rrB] = await db.insert(routineRuns).values({ routineId: routine.id, trigger: "manual", status: "running", conversationId: convB.id, createdAt: old as never }).returning();
    await db.delete(conversations).where(eq(conversations.id, convB.id));

    const res = await sweepRuns();
    expect(res.routines).toBeGreaterThanOrEqual(2);
    const [a] = await db.select().from(routineRuns).where(eq(routineRuns.id, rrA.id));
    expect(a.status).toBe("succeeded");
    const [b] = await db.select().from(routineRuns).where(eq(routineRuns.id, rrB.id));
    expect(b).toMatchObject({ status: "failed", error: "Its conversation was deleted." });
    const items = await db.select().from(inboxItems).where(inArray(inboxItems.routineRunId, [rrA.id, rrB.id]));
    expect(items.map((i) => i.kind).sort()).toEqual(["routine_error", "routine_result"]);
  });
});

