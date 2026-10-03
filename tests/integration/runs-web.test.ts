import { and, eq, inArray, sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiApp, Conversation, User } from "@/db/schema";
import type { Principal } from "@/lib/auth/groups";
import type { PortalUIMessage } from "@/lib/chat/store";

// No worker in this suite: the queue is a mock, and the executor's transitions are driven through state.ts directly.
vi.mock("@/lib/jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jobs")>()),
  enqueueRun: vi.fn(async () => "job-id"),
}));
vi.mock("@/lib/runs/hooks", () => ({ afterRunTransition: vi.fn(async () => {}) }));

const run = process.env.DATABASE_URL ? describe : describe.skip;

run("durable runs: web side (integration)", () => {
  const tag = `${process.pid}-${Date.now()}`;
  const userIds: string[] = [];
  // agent_runs.app_id is a snapshot without a foreign key: the store only reads the id.
  const app = { id: `it-app-${tag}` } as AiApp;
  let listen: Client;
  const signals: { r: string; k: string }[] = [];

  // One after the other: concurrent first imports of a module mocked with an async factory can build it twice.
  const load = async () => {
    const jobs = await import("@/lib/jobs");
    const hooks = await import("@/lib/runs/hooks");
    const { db } = await import("@/db");
    const schema = await import("@/db/schema");
    const store = await import("@/lib/runs/store");
    const state = await import("@/lib/runs/state");
    const log = await import("@/lib/runs/log");
    const { newId } = await import("@/lib/ids");
    const chat = await import("@/lib/chat/store");
    return { db, schema, store, state, log, newId, chat, jobs, hooks };
  };
  let loaded: ReturnType<typeof load> | undefined;
  const mods = () => (loaded ??= load());

  async function newUser(): Promise<Principal> {
    const { db, schema, newId } = await mods();
    const id = `it-runs-${newId()}`;
    userIds.push(id);
    const [user] = await db.insert(schema.users).values({ id, upn: `${id}@it.local`, name: "Runs Test", authSource: "ldap" }).returning();
    return { user: user as User, groupIds: [], isAdmin: false, canCreateBots: false };
  }

  async function newConv(p: Principal, extra: Partial<Conversation> = {}): Promise<Conversation> {
    const { db, schema, newId } = await mods();
    const [c] = await db
      .insert(schema.conversations)
      .values({ id: newId(), userId: p.user.id, ...extra })
      .returning();
    return c;
  }

  const userMsg = async (text = "hello"): Promise<PortalUIMessage> => {
    const { newId } = await mods();
    return { id: newId(), role: "user", parts: [{ type: "text", text }], metadata: { createdAt: Date.now() } };
  };

  async function start(p: Principal, conv: Conversation, parentId: string | null = null) {
    const { store } = await mods();
    return store.startRun({ principal: p, conversation: conv, bot: null, app, userMessage: await userMsg(), parentId });
  }

  const approvalPart = (approvalId: string) => ({
    type: "tool-fetch_url",
    toolCallId: `call-${approvalId}`,
    state: "approval-requested",
    input: { url: "https://example.com" },
    approval: { id: approvalId },
  });

  /** What the executor leaves behind at an approval: events, the saved message, and a waiting run. */
  async function waitingRun(p: Principal, conv: Conversation, approvals = ["a1"]) {
    const { state, log, chat, newId } = await mods();
    const started = await start(p, conv);
    const holder = `it-worker-${newId()}`;
    expect(await state.claimRun(started.id, holder)).toBeTruthy();
    await log.appendEvents(
      started.id,
      0,
      [
        { kind: "chunk", chunk: { type: "start", messageId: started.messageId } },
        { kind: "chunk", chunk: { type: "start-step" } },
        ...approvals.flatMap((a) => [
          { kind: "chunk" as const, chunk: { type: "tool-input-available" as const, toolCallId: `call-${a}`, toolName: "fetch_url", input: { url: "https://example.com" } } },
          { kind: "chunk" as const, chunk: { type: "tool-approval-request" as const, approvalId: a, toolCallId: `call-${a}` } },
        ]),
        { kind: "chunk", chunk: { type: "finish-step" } },
        { kind: "chunk", chunk: { type: "finish" } },
      ],
      { holder },
    );
    const message = { id: started.messageId, role: "assistant", parts: [{ type: "step-start" }, ...approvals.map(approvalPart)], metadata: {} } as PortalUIMessage;
    await chat.insertMessage(conv.id, message, started.parentMessageId);
    const paused = await state.pauseRun(started, holder, null);
    expect(paused?.status).toBe("waiting");
    return { run: paused!, holder };
  }

  const approve = (id = "a1", approved = true, reason?: string) => new Map([[id, { approved, reason }]]);

  async function partsOf(messageId: string) {
    const { db, schema } = await mods();
    const [row] = await db.select().from(schema.messages).where(eq(schema.messages.id, messageId));
    return row.parts as { type: string; state?: string; errorText?: string; approval?: { approved?: boolean; reason?: string } }[];
  }

  async function eventsOf(runId: string) {
    const { log } = await mods();
    return log.readEvents(runId, 0, 1000);
  }

  const statusOf = (r: PromiseSettledResult<unknown>) => (r.status === "rejected" ? (r.reason as { status?: number }).status : 200);

  const until = async (cond: () => boolean, ms = 5000) => {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  beforeAll(async () => {
    process.env.RUNS_PER_USER = "3";
    listen = new Client({ connectionString: process.env.DATABASE_URL });
    await listen.connect();
    listen.on("notification", (n) => {
      try {
        signals.push(JSON.parse(n.payload ?? ""));
      } catch {}
    });
    await listen.query("listen portal_runs");
  });

  beforeEach(async () => {
    const { jobs, hooks } = await mods();
    vi.mocked(jobs.enqueueRun).mockClear();
    vi.mocked(jobs.enqueueRun).mockImplementation(async () => "job-id");
    vi.mocked(hooks.afterRunTransition).mockClear();
  });

  afterAll(async () => {
    const { db, pool, schema } = { ...(await mods()), pool: (await import("@/db")).pool };
    for (const id of userIds) await db.delete(schema.users).where(eq(schema.users.id, id)); // cascades to chats and runs
    await listen?.end();
    await pool.end();
  });

  describe("startRun", () => {
    it("saves the user message, moves the leaf and queues one run per conversation", async () => {
      const { db, schema, jobs } = await mods();
      const p = await newUser();
      const conv = await newConv(p);
      const msgs = await Promise.all(Array.from({ length: 5 }, () => userMsg()));
      const results = await Promise.allSettled(
        msgs.map((m) => mods().then(({ store }) => store.startRun({ principal: p, conversation: conv, bot: null, app, userMessage: m, parentId: null }))),
      );
      expect(results.map(statusOf).sort()).toEqual([200, 409, 409, 409, 409]);
      const won = (results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<import("@/db/schema").AgentRun>).value;
      expect(won).toMatchObject({ status: "queued", segment: 0, background: false, legacy: false, appId: app.id, botId: null, userId: p.user.id });
      expect(won.messageId).not.toBe(won.parentMessageId);
      // The losers' user messages were rolled back with their runs.
      const rows = await db.select().from(schema.messages).where(eq(schema.messages.conversationId, conv.id));
      expect(rows.map((r) => r.id)).toEqual([won.parentMessageId]);
      const [c] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conv.id));
      expect(c.currentLeafId).toBe(won.parentMessageId);
      expect(vi.mocked(jobs.enqueueRun).mock.calls.map(([r]) => [r.id, r.segment])).toEqual([[won.id, 0]]);
    });

    it("caps interactive runs per user; background runs don't count", async () => {
      const { db, state, newId } = await mods();
      const p = await newUser();
      const bg = await newConv(p, { source: "routine" });
      await db.transaction((tx) =>
        state.insertRunTx(tx, { userId: p.user.id, conversationId: bg.id, messageId: newId(), parentMessageId: null, background: true }),
      );
      const convs = await Promise.all(Array.from({ length: 5 }, () => newConv(p)));
      const results = await Promise.allSettled(convs.map((c) => start(p, c)));
      expect(results.map(statusOf).sort()).toEqual([200, 200, 200, 429, 429]);
      expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason.message).toMatch(/several replies in progress/);
    });

    it("waits for a run that is being stopped, but not for one that isn't", async () => {
      const { db, state, store, newId } = await mods();
      const p = await newUser();
      const conv = await newConv(p);
      const first = await start(p, conv);
      const holder = `it-worker-${newId()}`;
      await state.claimRun(first.id, holder);
      await expect(start(p, conv)).rejects.toMatchObject({ status: 409 });

      await store.stopRuns(p, conv.id);
      const second = start(p, conv);
      await new Promise((r) => setTimeout(r, 300));
      // The worker saves the partial and finishes the stopped run while the new turn waits.
      await db.transaction((tx) => state.finalizeRunTx(tx, first.id, { status: ["running"], holder }, { status: "cancelled" }));
      await expect(second).resolves.toMatchObject({ status: "queued" });
    });

    it("gives up waiting after stopWaitMs", async () => {
      const { state, store, newId } = await mods();
      process.env.RUN_STOP_WAIT_MS = "300";
      try {
        const p = await newUser();
        const conv = await newConv(p);
        const first = await start(p, conv);
        await state.claimRun(first.id, `it-worker-${newId()}`);
        await store.stopRuns(p, conv.id);
        const t0 = Date.now();
        await expect(start(p, conv)).rejects.toMatchObject({ status: 409 });
        expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
      } finally {
        delete process.env.RUN_STOP_WAIT_MS;
      }
    });

    it("regenerate (no user message) moves the leaf back to the question", async () => {
      const { db, schema, store, chat, newId } = await mods();
      const p = await newUser();
      const conv = await newConv(p);
      const q = await userMsg();
      await chat.insertMessage(conv.id, q, null);
      const old = { id: newId(), role: "assistant", parts: [{ type: "text", text: "old" }], metadata: {} } as PortalUIMessage;
      await chat.insertMessage(conv.id, old, q.id);
      await chat.setCurrentLeaf(conv.id, old.id);
      const r = await store.startRun({ principal: p, conversation: conv, bot: null, app, parentId: q.id });
      expect(r.parentMessageId).toBe(q.id);
      const [c] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conv.id));
      expect(c.currentLeafId).toBe(q.id);
    });

    it("a queue that can't be reached fails the run (503) with an error event", async () => {
      const { db, schema, jobs } = await mods();
      vi.mocked(jobs.enqueueRun).mockRejectedValueOnce(new Error("connection refused"));
      const p = await newUser();
      const conv = await newConv(p);
      await expect(start(p, conv)).rejects.toMatchObject({ status: 503, message: expect.stringMatching(/queue is unavailable/) });
      const [r] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.conversationId, conv.id));
      expect(r).toMatchObject({ status: "failed", error: expect.stringMatching(/queue is unavailable/) });
      const events = await eventsOf(r.id);
      expect(events.map((e) => e.kind)).toEqual(["chunk", "segment-end"]);
      expect(events[0].chunk).toMatchObject({ type: "error", errorText: expect.stringMatching(/queue is unavailable/) });
    });
  });

  describe("continueRun", () => {
    it("12 concurrent answers: one requeues the run, with the decision appended as an event", async () => {
      const { store, state, jobs } = await mods();
      const p = await newUser();
      const conv = await newConv(p);
      const { run: waiting } = await waitingRun(p, conv);
      vi.mocked(jobs.enqueueRun).mockClear();
      const results = await Promise.allSettled(
        Array.from({ length: 12 }, () => store.continueRun({ principal: p, conversation: conv, messageId: waiting.messageId, decisions: approve("a1", true, "x".repeat(600)) })),
      );
      expect(results.map(statusOf).filter((s) => s === 200)).toHaveLength(1);
      expect(results.map(statusOf).filter((s) => s !== 200)).toEqual(Array(11).fill(409));

      const after = await state.getRun(waiting.id);
      expect(after).toMatchObject({ status: "queued", segment: 1, lastSeq: waiting.lastSeq + 1, boundarySeq: waiting.lastSeq + 1 });
      const events = await eventsOf(waiting.id);
      const responses = events.filter((e) => e.chunk?.type === "tool-approval-response");
      expect(responses).toHaveLength(1);
      // The reason as stored (sliced to 500), in the segment that asked.
      expect(responses[0]).toMatchObject({ seq: waiting.lastSeq + 1, segment: 0, chunk: { approvalId: "a1", approved: true, reason: "x".repeat(500) } });
      const parts = await partsOf(waiting.messageId);
      expect(parts[1]).toMatchObject({ state: "approval-responded", approval: { id: "a1", approved: true, reason: "x".repeat(500) } });
      expect(vi.mocked(jobs.enqueueRun).mock.calls.map(([r]) => [r.id, r.segment])).toEqual([[waiting.id, 1]]);
      expect(signals.some((s) => s.r === waiting.id && s.k === "q")).toBe(true);
    });

    it("only answers approvals that are pending; nothing pending → 400", async () => {
      const { store } = await mods();
      const p = await newUser();
      const conv = await newConv(p);
      const { run: waiting } = await waitingRun(p, conv);
      await expect(store.continueRun({ principal: p, conversation: conv, messageId: waiting.messageId, decisions: approve("nope") })).rejects.toMatchObject({
        status: 400,
        message: "No pending approvals to respond to",
      });
      expect((await partsOf(waiting.messageId))[1].state).toBe("approval-requested");
    });

    it("a running reply → 409 and the decisions aren't applied", async () => {
      const { store, state, chat, newId } = await mods();
      const p = await newUser();
      const conv = await newConv(p);
      const r = await start(p, conv);
      await state.claimRun(r.id, `it-worker-${newId()}`);
      await chat.insertMessage(conv.id, { id: r.messageId, role: "assistant", parts: [approvalPart("a1")], metadata: {} } as PortalUIMessage, r.parentMessageId);
      await expect(store.continueRun({ principal: p, conversation: conv, messageId: r.messageId, decisions: approve() })).rejects.toMatchObject({
        status: 409,
        message: "This reply is still running.",
      });
      expect((await partsOf(r.messageId))[0].state).toBe("approval-requested");
    });

    it("a finished reply → 409", async () => {
      const { db, store, state } = await mods();
      const p = await newUser();
      const conv = await newConv(p);
      const { run: waiting } = await waitingRun(p, conv);
      await db.transaction((tx) => state.finalizeRunTx(tx, waiting.id, { status: ["waiting"] }, { status: "cancelled" }));
      await expect(store.continueRun({ principal: p, conversation: conv, messageId: waiting.messageId, decisions: approve() })).rejects.toMatchObject({
        status: 409,
        message: expect.stringMatching(/finished/),
      });
      expect((await partsOf(waiting.messageId))[1].state).toBe("approval-requested");
    });

    it("another reply running in the chat → 409, and everything is rolled back", async () => {
      const { store, state } = await mods();
      const p = await newUser();
      const conv = await newConv(p);
      const { run: waiting } = await waitingRun(p, conv);
      // The user moved on while the card was pending; that reply is still queued.
      await start(p, conv, waiting.messageId);
      await expect(store.continueRun({ principal: p, conversation: conv, messageId: waiting.messageId, decisions: approve() })).rejects.toMatchObject({
        status: 409,
      });
      expect(await state.getRun(waiting.id)).toMatchObject({ status: "waiting", segment: 0, lastSeq: waiting.lastSeq });
      expect((await eventsOf(waiting.id)).length).toBe(waiting.lastSeq);
      expect((await partsOf(waiting.messageId))[1].state).toBe("approval-requested");
    });

    it("someone else's message or a message of another chat → 400", async () => {
      const { store } = await mods();
      const p = await newUser();
      const conv = await newConv(p);
      const { run: waiting } = await waitingRun(p, conv);
      const other = await newConv(p);
      await expect(store.continueRun({ principal: p, conversation: other, messageId: waiting.messageId, decisions: approve() })).rejects.toMatchObject({
        status: 400,
      });
      const q = await newUser();
      await expect(store.continueRun({ principal: q, conversation: conv, messageId: waiting.messageId, decisions: approve() })).rejects.toMatchObject({
        status: 400,
      });
      expect((await partsOf(waiting.messageId))[1].state).toBe("approval-requested");
    });

    it("a later assistant message without a run (e.g. a copy of a shared chat) can't be continued", async () => {
      const { store, chat, newId } = await mods();
      const p = await newUser();
      const conv = await newConv(p);
      // Some run exists (durable runs are deployed), so any newer message without one isn't from before them.
      await store.startRun({ principal: p, conversation: conv, bot: null, app, userMessage: await userMsg(), parentId: null });
      const q = await userMsg();
      await chat.insertMessage(conv.id, q, null);
      const m = { id: newId(), role: "assistant", parts: [{ type: "step-start" }, approvalPart("a1")] } as PortalUIMessage;
      await chat.insertMessage(conv.id, m, q.id);
      await expect(store.continueRun({ principal: p, conversation: conv, messageId: m.id, decisions: approve("a1", true) })).rejects.toMatchObject({
        status: 400,
      });
    });

    it("a message pending since before durable runs gets a legacy run, linked to its paused routine", async () => {
      const { db, schema, store, chat, jobs, newId } = await mods();
      const p = await newUser();
      const [bot] = await db.insert(schema.bots).values({ ownerId: p.user.id, name: "Legacy bot" }).returning();
      const conv = await newConv(p, { botId: bot.id, source: "routine" });
      const [routine] = await db
        .insert(schema.routines)
        .values({ ownerId: p.user.id, botId: bot.id, name: "Legacy routine", prompt: "x", triggerType: "cron", cron: "0 8 * * *" })
        .returning();
      const [routineRun] = await db
        .insert(schema.routineRuns)
        .values({ routineId: routine.id, status: "awaiting_approval", trigger: "schedule", conversationId: conv.id })
        .returning();
      const q = await userMsg();
      await chat.insertMessage(conv.id, q, null);
      const m = { id: newId(), role: "assistant", parts: [{ type: "step-start" }, approvalPart("a1")], metadata: { appId: "legacy-app" } } as PortalUIMessage;
      // Saved before the first run existed (durable runs weren't deployed yet).
      await chat.insertMessage(conv.id, m, q.id, { createdAt: new Date("2020-01-01T00:00:00Z") });

      const r = await store.continueRun({ principal: p, conversation: conv, messageId: m.id, decisions: approve("a1", false, "no") });
      expect(r).toMatchObject({
        legacy: true,
        status: "queued",
        segment: 1,
        messageId: m.id,
        parentMessageId: q.id,
        botId: bot.id,
        appId: "legacy-app",
        routineRunId: routineRun.id,
        lastSeq: 1,
        boundarySeq: 1,
      });
      const events = await eventsOf(r.id);
      expect(events).toHaveLength(1);
      expect(events[0].chunk).toEqual({ type: "tool-approval-response", approvalId: "a1", approved: false, reason: "no" });
      const [rr] = await db.select().from(schema.routineRuns).where(eq(schema.routineRuns.id, routineRun.id));
      expect(rr.status).toBe("running");
      expect(vi.mocked(jobs.enqueueRun).mock.calls.map(([r]) => [r.id, r.segment])).toEqual([[r.id, 1]]);
      // Legacy runs are never replayed (nothing before the continuation is in the log).
      expect(await store.resumableRun(conv.id)).toBeNull();
    });
  });

  describe("stopRuns / abortQueuedRun", () => {
    it("queued → cancelled at once (closing events, segment-end, hooks); a later claim fails", async () => {
      const { store, state, hooks } = await mods();
      const p = await newUser();
      const conv = await newConv(p);
      const r = await start(p, conv);
      expect(await store.stopRuns(p, conv.id)).toEqual({ cancelled: 1, signalled: 0 });
      expect(await state.getRun(r.id)).toMatchObject({ status: "cancelled", finishedAt: expect.any(Date) });
      expect((await eventsOf(r.id)).map((e) => e.kind)).toEqual(["segment-end"]);
      expect(await state.claimRun(r.id, "it-late-worker")).toBeNull();
      expect(vi.mocked(hooks.afterRunTransition)).toHaveBeenCalledWith(expect.objectContaining({ id: r.id }), "cancelled", null, null);
      // Idempotent.
      expect(await store.stopRuns(p, conv.id)).toEqual({ cancelled: 0, signalled: 0 });
      expect(vi.mocked(hooks.afterRunTransition)).toHaveBeenCalledTimes(1);
    });

    it("running → cancel requested + a `c` signal; asking again keeps the first request", async () => {
      const { store, state, newId } = await mods();
      const p = await newUser();
      const conv = await newConv(p);
      const r = await start(p, conv);
      await state.claimRun(r.id, `it-worker-${newId()}`);
      expect(await store.stopRuns(p, conv.id)).toEqual({ cancelled: 0, signalled: 1 });
      const first = await state.getRun(r.id);
      expect(first).toMatchObject({ status: "running", cancelRequestedAt: expect.any(Date) });
      await until(() => signals.some((s) => s.r === r.id && s.k === "c"));
      expect(await store.stopRuns(p, conv.id)).toEqual({ cancelled: 0, signalled: 1 });
      expect((await state.getRun(r.id))!.cancelRequestedAt).toEqual(first!.cancelRequestedAt);
    });

    it("waiting and finished runs are untouched; other users can't stop", async () => {
      const { db, store, state, newId } = await mods();
      const p = await newUser();
      const conv = await newConv(p);
      const { run: waiting } = await waitingRun(p, conv);
      expect(await store.stopRuns(p, conv.id)).toEqual({ cancelled: 0, signalled: 0 });
      expect(await state.getRun(waiting.id)).toMatchObject({ status: "waiting", cancelRequestedAt: null });

      const conv2 = await newConv(p);
      const r = await start(p, conv2);
      const holder = `it-worker-${newId()}`;
      await state.claimRun(r.id, holder);
      const q = await newUser();
      expect(await store.stopRuns(q, conv2.id)).toEqual({ cancelled: 0, signalled: 0 });
      await db.transaction((tx) => state.finalizeRunTx(tx, r.id, { status: ["running"], holder }, { status: "succeeded" }));
      expect(await store.stopRuns(p, conv2.id)).toEqual({ cancelled: 0, signalled: 0 });
      expect(await state.getRun(r.id)).toMatchObject({ status: "succeeded", cancelRequestedAt: null });
    });

    it("a queued continuation that is stopped closes its answered approvals in the database", async () => {
      const { store, state, hooks } = await mods();
      const p = await newUser();
      const conv = await newConv(p);
      const { run: waiting } = await waitingRun(p, conv, ["a1", "a2"]);
      await store.continueRun({
        principal: p,
        conversation: conv,
        messageId: waiting.messageId,
        decisions: new Map([
          ["a1", { approved: true }],
          ["a2", { approved: false, reason: "nope" }],
        ]),
      });
      const done = await store.abortQueuedRun(waiting.id, { status: "cancelled" });
      expect(done).toMatchObject({ status: "cancelled", segment: 1 });
      expect(await store.abortQueuedRun(waiting.id, { status: "cancelled" })).toBeNull();

      const parts = await partsOf(waiting.messageId);
      expect(parts[1]).toMatchObject({ state: "output-error", errorText: "Stopped before it ran." });
      expect(parts[2]).toMatchObject({ state: "output-denied", approval: { approved: false, reason: "nope" } });
      const tail = (await eventsOf(waiting.id)).filter((e) => e.segment === 1);
      expect(tail.map((e) => e.chunk?.type ?? e.kind)).toEqual(["tool-output-error", "tool-output-denied", "segment-end"]);
      expect(await state.getRun(waiting.id)).toMatchObject({ lastSeq: tail.at(-1)!.seq });
      expect(vi.mocked(hooks.afterRunTransition)).toHaveBeenCalledWith(
        expect.objectContaining({ id: waiting.id, status: "cancelled" }),
        "cancelled",
        expect.objectContaining({ id: waiting.messageId }),
        null,
      );
    });

    it("failing a queued run (queue timeout) appends the error before the segment-end", async () => {
      const { store } = await mods();
      const p = await newUser();
      const conv = await newConv(p);
      const r = await start(p, conv);
      const done = await store.abortQueuedRun(r.id, { status: "failed", error: "The worker didn't pick it up." });
      expect(done).toMatchObject({ status: "failed", error: "The worker didn't pick it up." });
      const events = await eventsOf(r.id);
      expect(events.map((e) => e.chunk?.type ?? e.kind)).toEqual(["error", "segment-end"]);
    });
  });

  describe("resumableRun", () => {
    it("the active run over a recent one; a recent finished or paused run; nothing when it's old", async () => {
      const { db, schema, store, state, newId } = await mods();
      const p = await newUser();
      const conv = await newConv(p);
      expect(await store.resumableRun(conv.id)).toBeNull();

      const first = await start(p, conv);
      const holder = `it-worker-${newId()}`;
      await state.claimRun(first.id, holder);
      // Active: tailed even before its first event.
      expect((await store.resumableRun(conv.id))?.id).toBe(first.id);
      await (await import("@/lib/runs/log")).appendEvents(first.id, 0, [{ kind: "chunk", chunk: { type: "start", messageId: first.messageId } }], { holder });
      expect((await store.resumableRun(conv.id))?.id).toBe(first.id);
      await db.transaction((tx) => state.finalizeRunTx(tx, first.id, { status: ["running"], holder }, { status: "succeeded" }));
      expect((await store.resumableRun(conv.id))?.id).toBe(first.id);

      const second = await start(p, conv, first.parentMessageId);
      const holder2 = `it-worker-${newId()}`;
      await state.claimRun(second.id, holder2);
      await (await import("@/lib/runs/log")).appendEvents(second.id, 0, [{ kind: "chunk", chunk: { type: "start", messageId: second.messageId } }], { holder: holder2 });
      expect((await store.resumableRun(conv.id))?.id).toBe(second.id);
      await db.transaction((tx) => state.finalizeRunTx(tx, second.id, { status: ["running"], holder: holder2 }, { status: "failed", error: "x" }));
      expect((await store.resumableRun(conv.id))?.id).toBe(second.id);

      await db
        .update(schema.agentRuns)
        .set({ finishedAt: sql`now() - interval '10 minutes'`, updatedAt: sql`now() - interval '10 minutes'` })
        .where(and(eq(schema.agentRuns.conversationId, conv.id)));
      expect(await store.resumableRun(conv.id)).toBeNull();

      const conv2 = await newConv(p);
      const { run: waiting } = await waitingRun(p, conv2);
      expect((await store.resumableRun(conv2.id))?.id).toBe(waiting.id);
    });
  });
  describe("Stop and the queue timeout, before a worker has the run", () => {
    it("the queue timeout fails a run only when it waited long enough by the database's clock and no worker is busy", async () => {
      const { db, schema, store, state, newId } = await mods();
      const p = await newUser();
      const queued = await start(p, await newConv(p));
      await db.update(schema.agentRuns).set({ updatedAt: sql`now() - interval '2 minutes'` }).where(eq(schema.agentRuns.id, queued.id));
      // A busy worker: another run is running with a fresh heartbeat.
      const busy = await start(p, await newConv(p));
      expect(await state.claimRun(busy.id, `it-worker-${newId()}`)).toBeTruthy();
      expect(await store.abortQueuedRun(queued.id, { status: "failed", error: "nobody" }, { ifUnclaimedForMs: 60_000 })).toBeNull();
      // That worker went quiet (and so did the runs other tests here left running): now no worker counts as busy.
      await db
        .update(schema.agentRuns)
        .set({ heartbeatAt: sql`now() - interval '10 minutes'` })
        .where(and(eq(schema.agentRuns.status, "running"), sql`${schema.agentRuns.userId} like 'it-runs-%'`));
      const failed = await store.abortQueuedRun(queued.id, { status: "failed", error: "nobody" }, { ifUnclaimedForMs: 60_000 });
      expect(failed?.status).toBe("failed");
      // Not long enough by the database's clock: left alone.
      const fresh = await start(p, await newConv(p));
      expect(await store.abortQueuedRun(fresh.id, { status: "failed", error: "nobody" }, { ifUnclaimedForMs: 60_000 })).toBeNull();
      await db.update(schema.agentRuns).set({ status: "failed" }).where(inArray(schema.agentRuns.id, [busy.id, fresh.id]));
    });

    it("a Stop sent before the reply's run exists stops it once it does", async () => {
      const { store } = await mods();
      const p = await newUser();
      const conv = await newConv(p);
      const message = await userMsg();
      const stopping = store.stopRunFor(p, conv.id, message.id);
      await new Promise((r) => setTimeout(r, 300));
      const run = await store.startRun({ principal: p, conversation: conv, bot: null, app, userMessage: message, parentId: null });
      expect(await stopping).toEqual({ cancelled: 1, signalled: 0 });
      const { state } = await mods();
      expect((await state.getRun(run.id))?.status).toBe("cancelled");
    });
  });
});
