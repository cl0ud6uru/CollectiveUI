import type { UIMessageChunk } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TurnOptions, TurnResult } from "@/lib/agent/run";
import type { PersistTurnInput } from "@/lib/agent/persist";
import type { PortalUIMessage } from "@/lib/chat/store";
import type { AgentRun, ResumeState } from "@/lib/runs/types";

const h = vi.hoisted(() => ({
  runTurn: vi.fn(),
  claimRun: vi.fn(),
  getRun: vi.fn(),
  enqueueRun: vi.fn(async () => "job-1"),
  finalizeRunTx: vi.fn(),
  pauseRun: vi.fn(),
  setRunBilling: vi.fn(async () => {}),
  withRunFence: vi.fn(),
  notifyRun: vi.fn(async () => {}),
  afterRunTransition: vi.fn(async () => {}),
  abortQueuedRun: vi.fn(async () => null),
  finishFromLogTx: vi.fn(),
  afterFinishedFromLog: vi.fn(async () => {}),
  loadPrincipal: vi.fn(),
  resolveTurnTarget: vi.fn(),
  loadMessageRows: vi.fn(),
  updateMessageParts: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
  saveAssistantMessage: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
  afterAssistantSaved: vi.fn(async () => {}),
  dropParkedForAgentRun: vi.fn(() => false),
  stopHermesRun: vi.fn(async () => {}),
  host: {
    instanceId: "worker-1:42:abcd",
    shuttingDown: false,
    acs: new Map<string, AbortController>(),
    untracked: [] as string[],
  },
  writers: [] as {
    opts: { runId: string; segment: number; holder: string; onLeaseLost: () => void; onCancel?: () => void };
    chunks: UIMessageChunk[];
    closed: boolean;
    leaseLost: boolean;
  }[],
  /** Rows the fake db returns per table (select … from table). */
  rows: new Map<unknown, unknown[]>(),
  tx: {} as Record<string, unknown>,
}));

vi.mock("@/db", async () => {
  const select = () => ({
    from: (table: unknown) => ({
      where: () => {
        const rows = h.rows.get(table) ?? [];
        return Object.assign(Promise.resolve(rows), { for: async () => rows });
      },
    }),
  });
  h.tx = { select };
  return { db: { select, transaction: async (fn: (tx: unknown) => unknown) => fn(h.tx) } };
});
vi.mock("@/lib/agent/run", () => ({ runTurn: h.runTurn }));
vi.mock("@/lib/runs/state", () => ({
  claimRun: h.claimRun,
  getRun: h.getRun,
  finalizeRunTx: h.finalizeRunTx,
  pauseRun: h.pauseRun,
  setRunBilling: h.setRunBilling,
  withRunFence: h.withRunFence,
}));
vi.mock("@/lib/runs/log", () => ({ notifyRun: h.notifyRun }));
vi.mock("@/lib/runs/hooks", () => ({ afterRunTransition: h.afterRunTransition }));
vi.mock("@/lib/runs/store", () => ({ abortQueuedRun: h.abortQueuedRun }));
vi.mock("@/lib/jobs", () => ({ enqueueRun: h.enqueueRun }));
vi.mock("@/lib/runs/sweeper", () => ({ finishFromLogTx: h.finishFromLogTx, afterFinishedFromLog: h.afterFinishedFromLog }));
vi.mock("@/lib/runs/host", () => ({
  runHost: () => ({
    get instanceId() {
      return h.host.instanceId;
    },
    get shuttingDown() {
      return h.host.shuttingDown;
    },
    track: (id: string, ac: AbortController) => {
      h.host.acs.set(id, ac);
      return () => h.host.untracked.push(id);
    },
  }),
}));
vi.mock("@/lib/runs/events", async () => {
  const { trackOpenStreams } = await import("@/lib/runs/replay");
  class FakeWriter {
    chunks: UIMessageChunk[] = [];
    closed = false;
    leaseLost = false;
    private open = trackOpenStreams();
    constructor(readonly opts: (typeof h.writers)[number]["opts"]) {
      h.writers.push(this);
    }
    async push(c: UIMessageChunk) {
      this.chunks.push(c);
      this.open.see(c);
    }
    async close() {
      this.closed = true;
    }
    openStreamIds() {
      return this.open.ids();
    }
  }
  return { RunEventWriter: FakeWriter };
});
vi.mock("@/lib/auth/groups", () => ({ loadPrincipal: h.loadPrincipal }));
vi.mock("@/lib/agent/target", () => ({ resolveTurnTarget: h.resolveTurnTarget }));
vi.mock("@/lib/chat/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chat/store")>()),
  loadMessageRows: h.loadMessageRows,
  updateMessageParts: h.updateMessageParts,
}));
vi.mock("@/lib/agent/persist", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent/persist")>()),
  saveAssistantMessage: h.saveAssistantMessage,
  afterAssistantSaved: h.afterAssistantSaved,
}));
vi.mock("@/lib/llm/providers/hermes/runs", () => ({ dropParkedForAgentRun: h.dropParkedForAgentRun }));
vi.mock("@/lib/llm/resolve", () => ({ stopHermesRun: h.stopHermesRun }));
vi.mock("@/lib/llm", () => ({
  userFacingMessage: (err: unknown) => (err as { userFacing?: string } | null)?.userFacing,
}));

import { agentRuns, aiApps, conversations, messages } from "@/db/schema";
import { HttpError } from "@/lib/authz";
import { executeRun } from "@/lib/runs/execute";
import { RunAbort } from "@/lib/runs/types";

const HOLDER = "worker-1:42:abcd";
const principal = { user: { id: "u1", name: "Alice" } };
const conv = { id: "c1", userId: "u1", appId: "app1", botId: null, isGroup: false, title: "Chat" };
const app = { id: "app1", provider: "openai-compatible", model: "m" };

const runRow = (over: Partial<AgentRun> = {}): AgentRun =>
  ({
    id: "run1",
    userId: "u1",
    conversationId: "c1",
    messageId: "m-asst",
    parentMessageId: "m-user",
    appId: "app1",
    botId: null,
    routineRunId: null,
    background: false,
    legacy: false,
    status: "running",
    segment: 0,
    boundarySeq: 0,
    lastSeq: 0,
    holder: HOLDER,
    resumeState: null,
    cancelRequestedAt: null,
    ...over,
  }) as AgentRun;

const userRow = { id: "m-user", conversationId: "c1", parentId: null, role: "user", parts: [{ type: "text", text: "hi" }], metadata: {}, createdAt: new Date(1) };

const text = (id: string, s: string, end = true): UIMessageChunk[] => [
  { type: "text-start", id },
  { type: "text-delta", id, delta: s },
  ...(end ? [{ type: "text-end" as const, id }] : []),
];
const reply = (s: string, state: "done" | "streaming" = "done"): PortalUIMessage => ({ id: "m-asst", role: "assistant", parts: [{ type: "text", text: s, state }] });

type Script = {
  chunks: UIMessageChunk[];
  message: PortalUIMessage;
  error?: string;
  /** Streams the chunks, then waits for the run's abort before ending (with an abort chunk). */
  untilAbort?: boolean;
  /** Waits for the abort and then never ends by itself (a tool ignoring the signal): only a cancel ends it. */
  hang?: boolean;
  /** What the stream sends once aborted (default: an abort chunk). */
  afterAbort?: UIMessageChunk[];
  resumeState?: ResumeState;
};

/** runTurn as the executor sees it: a stream, `persist` called when it ends (or is cancelled), then `done`. */
function fakeTurn(opts: TurnOptions, s: Script): TurnResult {
  let resolveDone!: (v: Awaited<TurnResult["done"]>) => void;
  const done = new Promise<Awaited<TurnResult["done"]>>((r) => (resolveDone = r));
  let ended = false;
  const end = async () => {
    if (ended) return;
    ended = true;
    if (s.resumeState) opts.run?.saveResumeState(s.resumeState);
    const input: PersistTurnInput = {
      conversationId: opts.conversation.id,
      userId: opts.principal.user.id,
      botId: opts.bot?.id ?? null,
      responseMessage: s.message,
      isContinuation: opts.continuation,
      parentId: opts.history.at(-1)?.id ?? null,
      extra: { model: "m", inputTokens: null, outputTokens: null },
      background: !!opts.background,
    };
    try {
      await opts.persist!(input, { error: s.error });
    } catch (err) {
      console.error("[agent] failed to persist response", err);
    }
    resolveDone({ responseMessage: s.message, pendingApproval: false, error: s.error });
  };
  const stream = new ReadableStream<UIMessageChunk>({
    start(c) {
      void (async () => {
        for (const chunk of s.chunks) c.enqueue(chunk);
        if (s.untilAbort || s.hang) {
          const signal = opts.abortSignal!;
          if (!signal.aborted) await new Promise((r) => signal.addEventListener("abort", r, { once: true }));
          if (s.hang) return;
          for (const chunk of s.afterAbort ?? [{ type: "abort" } as UIMessageChunk]) c.enqueue(chunk);
        }
        await end();
        c.close();
      })();
    },
    async cancel() {
      await end();
    },
  });
  return { stream, done, billing: { source: "org" } };
}

const useTurn = (s: Script) => h.runTurn.mockImplementation(async (opts: TurnOptions) => fakeTurn(opts, s));
const lastWriter = () => h.writers.at(-1)!;
const finalizeCall = () => h.finalizeRunTx.mock.calls.at(-1) as [unknown, string, { status: string[]; holder?: string }, { status: string; error?: string | null; closing: UIMessageChunk[] }];

/** The note a reply that ended early keeps (closeOpenParts' endNote). */
const note = (message: string) => ({ type: "data-run-error", data: { message } });

describe("executeRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.host.shuttingDown = false;
    h.host.acs.clear();
    h.host.untracked = [];
    h.writers = [];
    h.rows = new Map<unknown, unknown[]>([[conversations, [conv]]]);
    h.claimRun.mockImplementation(async () => runRow());
    h.loadPrincipal.mockResolvedValue(principal);
    h.resolveTurnTarget.mockResolvedValue({ bot: null, app });
    h.loadMessageRows.mockResolvedValue([userRow]);
    h.withRunFence.mockImplementation(async (_id: string, _holder: string, fn: (tx: unknown) => unknown) => ({ value: await fn(h.tx) }));
    h.finalizeRunTx.mockImplementation(async (_tx: unknown, id: string, _from: unknown, to: { status: string }) => runRow({ id, status: to.status as never }));
    h.pauseRun.mockImplementation(async (run: AgentRun) => ({ ...run, status: "waiting" }));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does nothing when the claim fails; a run stopped while queued is cancelled", async () => {
    h.claimRun.mockResolvedValue(null);
    h.getRun.mockResolvedValueOnce(runRow({ status: "running", holder: "other" }));
    await executeRun("run1");
    expect(h.runTurn).not.toHaveBeenCalled();
    expect(h.abortQueuedRun).not.toHaveBeenCalled();

    h.getRun.mockResolvedValueOnce(runRow({ status: "queued", holder: null, cancelRequestedAt: new Date() }));
    await executeRun("run1");
    expect(h.runTurn).not.toHaveBeenCalled();
    expect(h.abortQueuedRun).toHaveBeenCalledWith("run1", { status: "cancelled" });
  });

  it("doesn't claim while the worker shuts down: the run is enqueued again and the job fails (it didn't run)", async () => {
    h.host.shuttingDown = true;
    h.getRun.mockResolvedValueOnce(runRow({ status: "queued", holder: null }));
    await expect(executeRun("run1")).rejects.toThrow(/shutting down/);
    expect(h.claimRun).not.toHaveBeenCalled();
    expect(h.enqueueRun).toHaveBeenCalledWith(expect.objectContaining({ id: "run1", status: "queued" }), { delaySeconds: 5 });
  });

  it("runs a plain reply: re-authorizes, streams into the log, saves under the lease, finishes and runs the hooks once", async () => {
    const chunks: UIMessageChunk[] = [{ type: "start", messageId: "m-asst" }, { type: "start-step" }, ...text("t1", "Hello"), { type: "finish-step" }, { type: "finish" }];
    useTurn({ chunks, message: reply("Hello") });
    await executeRun("run1");

    expect(h.claimRun).toHaveBeenCalledWith("run1", HOLDER);
    expect(h.loadPrincipal).toHaveBeenCalledWith("u1");
    const opts = h.runTurn.mock.calls[0][0] as TurnOptions;
    expect(opts).toMatchObject({ continuation: false, background: false, interactive: true, responseMessageId: "m-asst", app, bot: null });
    expect(opts.history.map((m) => m.id)).toEqual(["m-user"]);
    expect(opts.run?.id).toBe("run1");
    expect(opts.run?.resumeState).toBeNull();
    expect(opts.abortSignal).toBe(h.host.acs.get("run1")!.signal);

    expect(lastWriter().opts).toMatchObject({ runId: "run1", segment: 0, holder: HOLDER });
    expect(lastWriter().chunks).toEqual(chunks);
    expect(lastWriter().closed).toBe(true);
    expect(h.setRunBilling).toHaveBeenCalledWith("run1", HOLDER, "org");

    expect(h.withRunFence).toHaveBeenCalledWith("run1", HOLDER, expect.any(Function));
    expect(h.saveAssistantMessage).toHaveBeenCalledWith(expect.objectContaining({ responseMessage: reply("Hello") }), h.tx, { leafOnlyFrom: ["m-user", "m-asst"] });
    expect(h.afterAssistantSaved).toHaveBeenCalledTimes(1);

    const [, id, from, to] = finalizeCall();
    expect(id).toBe("run1");
    expect(from).toEqual({ status: ["running"], holder: HOLDER });
    expect(to).toEqual({ status: "succeeded", error: null, closing: [] });
    expect(h.pauseRun).not.toHaveBeenCalled();
    expect(h.afterRunTransition).toHaveBeenCalledTimes(1);
    expect(h.afterRunTransition).toHaveBeenCalledWith(expect.objectContaining({ id: "run1", status: "succeeded" }), "succeeded", reply("Hello"), null);
    expect(h.host.untracked).toEqual(["run1"]);
  });

  it("a model error fails the run with the stream's own error text (no extra error chunk)", async () => {
    const err = "The model endpoint returned an error: overloaded";
    useTurn({ chunks: [{ type: "start" }, { type: "error", errorText: err }, { type: "finish" }], message: reply(""), error: err });
    await executeRun("run1");
    expect(finalizeCall()[3]).toEqual({ status: "failed", error: err, closing: [note(err)] });
    // Saved with the reply, so a reload still says why it ended.
    expect((h.saveAssistantMessage.mock.calls[0][0] as PersistTurnInput).responseMessage.parts.at(-1)).toEqual(note(err));
    expect(h.afterRunTransition).toHaveBeenCalledWith(expect.anything(), "failed", expect.anything(), err);
  });

  it("lease lost at the save: writes nothing more and runs no hooks", async () => {
    useTurn({ chunks: [{ type: "start" }, ...text("t1", "Hi"), { type: "finish" }], message: reply("Hi") });
    h.withRunFence.mockResolvedValue(null);
    await executeRun("run1");
    expect(h.saveAssistantMessage).not.toHaveBeenCalled();
    expect(h.afterAssistantSaved).not.toHaveBeenCalled();
    expect(h.finalizeRunTx).not.toHaveBeenCalled();
    expect(h.pauseRun).not.toHaveBeenCalled();
    expect(h.finishFromLogTx).not.toHaveBeenCalled();
    expect(h.afterRunTransition).not.toHaveBeenCalled();
  });

  it("lease lost while streaming (a failed fence): the turn is aborted and nothing is saved", async () => {
    h.runTurn.mockImplementation(async (opts: TurnOptions) => {
      const turn = fakeTurn(opts, { chunks: [{ type: "start" }, ...text("t1", "Hi", false)], message: reply("Hi", "streaming"), untilAbort: true });
      queueMicrotask(() => lastWriter().opts.onLeaseLost());
      return turn;
    });
    await executeRun("run1");
    expect(h.host.acs.get("run1")!.signal.reason).toEqual(new RunAbort("lease-lost"));
    expect(h.withRunFence).not.toHaveBeenCalled();
    expect(h.finalizeRunTx).not.toHaveBeenCalled();
    expect(h.afterRunTransition).not.toHaveBeenCalled();
  });

  it.each([
    ["cancel", "cancelled", null],
    ["shutdown", "interrupted", "The worker restarted while this reply was running. Try again."],
  ] as const)("abort %s → %s, the partial saved with its open text ended", async (kind, status, error) => {
    h.runTurn.mockImplementation(async (opts: TurnOptions) => {
      const turn = fakeTurn(opts, { chunks: [{ type: "start" }, ...text("t1", "Part", false)], message: reply("Part", "streaming"), untilAbort: true });
      setTimeout(() => h.host.acs.get("run1")!.abort(new RunAbort(kind)), 5);
      return turn;
    });
    await executeRun("run1");
    const saved = h.saveAssistantMessage.mock.calls[0][0] as PersistTurnInput;
    // A Stop needs no explanation; an interrupted reply keeps a note saying why it ended.
    expect(saved.responseMessage.parts).toEqual([{ type: "text", text: "Part", state: "done" }, ...(error ? [note(error)] : [])]);
    const to = finalizeCall()[3];
    expect(to.status).toBe(status);
    expect(to.error).toBe(error);
    expect(to.closing).toEqual([{ type: "text-end", id: "t1" }, ...(error ? [note(error), { type: "error", errorText: error }] : [])]);
    expect(h.afterRunTransition).toHaveBeenCalledTimes(1);
    expect(h.afterRunTransition).toHaveBeenCalledWith(expect.anything(), status, expect.anything(), error);
  });

  it("stream errors after an abort (the provider's cut request) aren't logged", async () => {
    const cut = "The model endpoint returned an error: Failed to process successful response";
    h.runTurn.mockImplementation(async (opts: TurnOptions) => {
      const turn = fakeTurn(opts, {
        chunks: [{ type: "start" }, ...text("t1", "Pa", false)],
        message: reply("Pa", "streaming"),
        untilAbort: true,
        // What the openai provider's stream does when its fetch is aborted mid-response.
        afterAbort: [{ type: "error", errorText: cut }, { type: "finish" }],
        error: cut,
      });
      setTimeout(() => h.host.acs.get("run1")!.abort(new RunAbort("cancel")), 5);
      return turn;
    });
    await executeRun("run1");
    expect(lastWriter().chunks.map((c) => c.type)).toEqual(["start", "text-start", "text-delta", "finish"]);
    expect(finalizeCall()[3]).toEqual({ status: "cancelled", error: null, closing: [{ type: "text-end", id: "t1" }] });
  });

  it("a cancel request seen by a fence aborts as cancel", async () => {
    h.runTurn.mockImplementation(async (opts: TurnOptions) => {
      const turn = fakeTurn(opts, { chunks: [{ type: "start" }], message: reply(""), untilAbort: true });
      setTimeout(() => lastWriter().opts.onCancel!(), 5);
      return turn;
    });
    await executeRun("run1");
    expect(finalizeCall()[3].status).toBe("cancelled");
  });

  it("the segment timeout fails the run and says why", async () => {
    vi.stubEnv("RUN_TIMEOUT_MS", "30");
    useTurn({ chunks: [{ type: "start" }], message: reply("", "done"), untilAbort: true });
    await executeRun("run1");
    const to = finalizeCall()[3];
    expect(to.status).toBe("failed");
    expect(to.error).toBe("The reply took longer than 1 min and was stopped.");
    const why = "The reply took longer than 1 min and was stopped.";
    expect(to.closing).toEqual([note(why), { type: "error", errorText: why }]);
  });

  it("routines' first segments use the routine timeout and run as background", async () => {
    vi.stubEnv("ROUTINE_TIMEOUT_MS", "30");
    h.claimRun.mockResolvedValue(runRow({ background: true, routineRunId: "rr1" }));
    useTurn({ chunks: [{ type: "start" }], message: reply(""), untilAbort: true });
    await executeRun("run1");
    expect((h.runTurn.mock.calls[0][0] as TurnOptions).background).toBe(true);
    expect(finalizeCall()[3].status).toBe("failed");
  });

  it("the pg-boss job's signal aborts as shutdown; its listener is removed when the handler returns", async () => {
    const job = new AbortController();
    const add = vi.spyOn(job.signal, "addEventListener");
    const remove = vi.spyOn(job.signal, "removeEventListener");
    h.runTurn.mockImplementation(async (opts: TurnOptions) => {
      const turn = fakeTurn(opts, { chunks: [{ type: "start" }], message: reply(""), untilAbort: true });
      setTimeout(() => job.abort(), 5);
      return turn;
    });
    await executeRun("run1", { signal: job.signal });
    expect(finalizeCall()[3].status).toBe("interrupted");
    const handler = add.mock.calls.find((c) => c[0] === "abort")![1];
    expect(remove).toHaveBeenCalledWith("abort", handler);

    // A job that returns normally: pg-boss aborts its signal afterwards, which must not reach a later run.
    const job2 = new AbortController();
    useTurn({ chunks: [{ type: "start" }, { type: "finish" }], message: reply("ok") });
    await executeRun("run1", { signal: job2.signal });
    const ac = h.host.acs.get("run1")!;
    job2.abort();
    expect(ac.signal.aborted).toBe(false);
  });

  it("cuts a stream that doesn't end after an abort (cancel deadline); the partial is still saved", async () => {
    vi.stubEnv("RUN_CANCEL_DEADLINE_MS", "20");
    h.runTurn.mockImplementation(async (opts: TurnOptions) => {
      const turn = fakeTurn(opts, { chunks: [{ type: "start" }, ...text("t1", "Hang", false)], message: reply("Hang", "streaming"), hang: true });
      setTimeout(() => h.host.acs.get("run1")!.abort(new RunAbort("cancel")), 5);
      return turn;
    });
    await executeRun("run1");
    expect(h.saveAssistantMessage).toHaveBeenCalledTimes(1);
    expect(finalizeCall()[3]).toMatchObject({ status: "cancelled", closing: [{ type: "text-end", id: "t1" }] });
  });

  it("pauses at a pending approval with the provider's resume state", async () => {
    const msg: PortalUIMessage = {
      id: "m-asst",
      role: "assistant",
      parts: [{ type: "dynamic-tool", toolName: "terminal", toolCallId: "t1", state: "approval-requested", input: {}, approval: { id: "ap1" } } as never],
    };
    const resumeState: ResumeState = { hermes: { runId: "hr1", lastEventId: "7", state: { runId: "hr1" } as never } };
    useTurn({ chunks: [{ type: "start" }, { type: "tool-approval-request", approvalId: "ap1", toolCallId: "t1" }, { type: "finish" }], message: msg, resumeState });
    await executeRun("run1");
    expect(h.pauseRun).toHaveBeenCalledWith(expect.objectContaining({ id: "run1" }), HOLDER, resumeState, []);
    expect(h.finalizeRunTx).not.toHaveBeenCalled();
    expect(h.afterRunTransition).toHaveBeenCalledWith(expect.objectContaining({ status: "waiting" }), "waiting", msg, null);
  });

  it("a pause without provider state stores none", async () => {
    const msg: PortalUIMessage = {
      id: "m-asst",
      role: "assistant",
      parts: [{ type: "tool-remember", toolCallId: "t1", state: "approval-requested", input: {}, approval: { id: "ap1" } } as never],
    };
    useTurn({ chunks: [{ type: "start" }, { type: "finish" }], message: msg });
    await executeRun("run1");
    expect(h.pauseRun).toHaveBeenCalledWith(expect.anything(), HOLDER, null, []);
  });

  it("continues a later segment from the stored message and hands the saved resume state to the provider", async () => {
    const stored = {
      id: "m-asst",
      conversationId: "c1",
      parentId: "m-user",
      role: "assistant",
      parts: [{ type: "tool-remember", toolCallId: "t1", state: "approval-responded", input: {}, approval: { id: "ap1", approved: true } }],
      metadata: {},
      createdAt: new Date(2),
    };
    const resumeState = { hermes: { runId: "hr1", state: {} } };
    h.claimRun.mockResolvedValue(runRow({ segment: 1, boundarySeq: 9, lastSeq: 9, resumeState }));
    h.loadMessageRows.mockResolvedValue([userRow, stored]);
    useTurn({ chunks: [{ type: "start", messageId: "m-asst" }, { type: "finish" }], message: reply("done") });
    await executeRun("run1");
    const opts = h.runTurn.mock.calls[0][0] as TurnOptions;
    expect(opts.continuation).toBe(true);
    expect(opts.history.map((m) => m.id)).toEqual(["m-user", "m-asst"]);
    expect(opts.background).toBe(false);
    expect(opts.run?.resumeState).toEqual(resumeState);
    expect(lastWriter().opts.segment).toBe(1);
  });

  it("re-authorizes every segment: a disabled account fails a continuation closed (answered approvals never re-run)", async () => {
    const stored = {
      id: "m-asst",
      conversationId: "c1",
      parentId: "m-user",
      role: "assistant",
      parts: [
        { type: "tool-remember", toolCallId: "t1", state: "approval-responded", input: { fact: "x" }, approval: { id: "ap1", approved: true } },
        { type: "tool-remember", toolCallId: "t2", state: "approval-responded", input: { fact: "y" }, approval: { id: "ap2", approved: false } },
      ],
      metadata: {},
      createdAt: new Date(2),
    };
    h.rows.set(messages, [stored]);
    // Segment 0 ran for an active account...
    useTurn({ chunks: [{ type: "start" }, { type: "finish" }], message: reply("ok") });
    await executeRun("run1");
    expect(h.loadPrincipal).toHaveBeenCalledTimes(1);
    // ...which was disabled before the approval was answered.
    h.claimRun.mockResolvedValue(runRow({ segment: 1 }));
    h.loadPrincipal.mockResolvedValue(null);
    vi.clearAllMocks();
    h.claimRun.mockResolvedValue(runRow({ segment: 1 }));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await executeRun("run1");
    errSpy.mockRestore();

    expect(h.loadPrincipal).toHaveBeenCalledWith("u1");
    expect(h.runTurn).not.toHaveBeenCalled();
    const text = "This account is disabled.";
    const saved = h.updateMessageParts.mock.calls[0] as unknown as [string, PortalUIMessage, unknown, unknown];
    expect(saved[0]).toBe("c1");
    expect(saved[1].parts).toEqual([
      expect.objectContaining({ toolCallId: "t1", state: "output-error", errorText: `Couldn't continue: ${text}` }),
      expect.objectContaining({ toolCallId: "t2", state: "output-denied" }),
      note(text),
    ]);
    const [, , from, to] = finalizeCall();
    expect(from).toEqual({ status: ["running"], holder: HOLDER });
    expect(to).toEqual({
      status: "failed",
      error: text,
      closing: [
        { type: "tool-output-error", toolCallId: "t1", errorText: `Couldn't continue: ${text}` },
        { type: "tool-output-denied", toolCallId: "t2" },
        note(text),
        { type: "error", errorText: text },
      ],
    });
    expect(h.afterRunTransition).toHaveBeenCalledTimes(1);
    expect(h.afterRunTransition).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }), "failed", saved[1], text);
  });

  it("a changed bot fails the segment; a setup error from runTurn uses its user-facing text", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    h.resolveTurnTarget.mockResolvedValueOnce({ bot: { id: "b2" }, app });
    await executeRun("run1");
    expect(finalizeCall()[3]).toMatchObject({ status: "failed", error: "This chat's bot changed." });

    h.runTurn.mockRejectedValueOnce(Object.assign(new Error("secret upstream detail"), { userFacing: "Connect your ChatGPT account first." }));
    await executeRun("run1");
    expect(finalizeCall()[3]).toEqual({
      status: "failed",
      error: "Connect your ChatGPT account first.",
      closing: [{ type: "error", errorText: "Connect your ChatGPT account first." }],
    });

    h.runTurn.mockRejectedValueOnce(new Error("ECONNREFUSED 10.0.0.1"));
    await executeRun("run1");
    expect(finalizeCall()[3]).toMatchObject({ status: "failed", error: "Couldn't start this reply." });

    h.resolveTurnTarget.mockRejectedValueOnce(new HttpError(400, "This bot's model endpoint is disabled"));
    await executeRun("run1");
    expect(finalizeCall()[3]).toMatchObject({ error: "This bot's model endpoint is disabled" });
    expect(h.afterRunTransition).toHaveBeenCalledTimes(4);
    errSpy.mockRestore();
  });

  it("a turn that ended without saving is finished from the event log", async () => {
    h.saveAssistantMessage.mockRejectedValueOnce(new Error("db down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    h.finishFromLogTx.mockResolvedValue({ run: runRow({ status: "failed" }), message: null });
    useTurn({ chunks: [{ type: "start" }, { type: "finish" }], message: reply("x") });
    await executeRun("run1");
    errSpy.mockRestore();
    expect(h.finishFromLogTx).toHaveBeenCalledWith(h.tx, expect.objectContaining({ id: "run1" }), { status: ["running"], holder: HOLDER }, { status: "failed", error: expect.any(String) });
    expect(h.afterFinishedFromLog).toHaveBeenCalledTimes(1);
    expect(h.finalizeRunTx).not.toHaveBeenCalled();
  });

  it("a new Hermes turn supersedes the conversation's waiting Hermes runs", async () => {
    const hermesApp = { id: "app1", provider: "hermes", model: "hermes" };
    h.resolveTurnTarget.mockResolvedValue({ bot: null, app: hermesApp });
    const waitingRun = runRow({ id: "run-old", messageId: "m-old", status: "waiting", holder: null, resumeState: { hermes: { runId: "hr-old", state: {} } } });
    const oldMsg = {
      id: "m-old",
      conversationId: "c1",
      parentId: null,
      role: "assistant",
      parts: [{ type: "dynamic-tool", toolName: "terminal", toolCallId: "t1", state: "approval-requested", input: {}, approval: { id: "ap-old" } }],
      metadata: {},
      createdAt: new Date(0),
    };
    h.rows.set(agentRuns, [waitingRun]);
    h.rows.set(aiApps, [hermesApp]);
    h.rows.set(messages, [oldMsg]);
    h.finalizeRunTx.mockImplementation(async (_tx: unknown, id: string, _from: unknown, to: { status: string }) => runRow({ ...waitingRun, id, status: to.status as never }));
    useTurn({ chunks: [{ type: "start" }, { type: "finish" }], message: reply("new") });
    await executeRun("run1");

    const cancel = h.finalizeRunTx.mock.calls.find((c) => c[1] === "run-old")!;
    expect(cancel[2]).toEqual({ status: ["waiting"] });
    expect(cancel[3]).toEqual({
      status: "cancelled",
      closing: [
        { type: "tool-approval-response", approvalId: "ap-old", approved: false, reason: "Not answered before the next message." },
        { type: "tool-output-denied", toolCallId: "t1" },
      ],
    });
    const closed = h.updateMessageParts.mock.calls[0] as unknown as [string, PortalUIMessage];
    expect(closed[1].parts[0]).toMatchObject({ state: "output-denied", approval: { approved: false } });
    expect(h.notifyRun).toHaveBeenCalledWith(h.tx, { r: "run-old", k: "c" });
    expect(h.dropParkedForAgentRun).toHaveBeenCalledWith("run-old");
    expect(h.stopHermesRun).toHaveBeenCalledWith(hermesApp, "hr-old");
    expect(h.afterRunTransition).toHaveBeenCalledWith(expect.objectContaining({ id: "run-old" }), "cancelled", closed[1], null);
    // The new turn itself still runs and finishes.
    expect(h.runTurn).toHaveBeenCalledTimes(1);
    expect(finalizeCall()[1]).toBe("run1");
  });

  it("doesn't supersede for other providers, or on continuations", async () => {
    h.rows.set(agentRuns, [runRow({ id: "run-old", status: "waiting" })]);
    useTurn({ chunks: [{ type: "start" }, { type: "finish" }], message: reply("ok") });
    await executeRun("run1");
    expect(h.finalizeRunTx.mock.calls.map((c) => c[1])).toEqual(["run1"]);
  });
});
