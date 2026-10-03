import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  afterRoutineTurn: vi.fn<(opts: Record<string, unknown>) => Promise<void>>(async () => {}),
  rows: new Map<unknown, unknown[]>(),
  selects: 0,
}));

vi.mock("@/db", () => ({
  db: {
    select: () => {
      h.selects++;
      return { from: (table: unknown) => ({ where: async () => h.rows.get(table) ?? [] }) };
    },
  },
}));
vi.mock("@/lib/agent/routine-runner", () => ({ afterRoutineTurn: h.afterRoutineTurn }));

import { bots, routineRuns, routines } from "@/db/schema";
import type { PortalUIMessage } from "@/lib/chat/store";
import { afterRunTransition, approvalBodyFor, routineErrorFor } from "@/lib/runs/hooks";
import type { AgentRun } from "@/lib/runs/types";

const run = (over: Partial<AgentRun> = {}) =>
  ({
    id: "ar1",
    userId: "u1",
    conversationId: "c1",
    messageId: "m1",
    botId: "b1",
    routineRunId: "rr1",
    status: "succeeded",
    ...over,
  }) as AgentRun;

const reply = (text: string): PortalUIMessage => ({ id: "m1", role: "assistant", parts: [{ type: "text", text }] });
const approval = (input: Record<string, unknown>): PortalUIMessage => ({
  id: "m1",
  role: "assistant",
  parts: [{ type: "dynamic-tool", toolName: "terminal", toolCallId: "t1", state: "approval-requested", input, approval: { id: "ap1" } } as never],
});

const lastCall = () => h.afterRoutineTurn.mock.calls.at(-1)![0];

describe("afterRunTransition → afterRoutineTurn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.selects = 0;
    h.rows = new Map<unknown, unknown[]>([
      [routineRuns, [{ id: "rr1", routineId: "r1" }]],
      [routines, [{ name: "Daily digest", notifyEmail: true, botId: "b1" }]],
      [bots, [{ name: "Digest bot" }]],
    ]);
  });

  it("does nothing for a run that isn't a routine's", async () => {
    await afterRunTransition(run({ routineRunId: null }), "succeeded", reply("hi"));
    expect(h.afterRoutineTurn).not.toHaveBeenCalled();
    expect(h.selects).toBe(0);
  });

  it("does nothing for statuses that aren't a pause or an end", async () => {
    await afterRunTransition(run(), "queued", null);
    await afterRunTransition(run(), "running", null);
    expect(h.afterRoutineTurn).not.toHaveBeenCalled();
  });

  it("succeeded → a result (no error, no approval) with the routine's email setting", async () => {
    await afterRunTransition(run(), "succeeded", reply("Here's the digest"));
    expect(lastCall()).toEqual({
      runId: "rr1",
      routineName: "Daily digest",
      botName: "Digest bot",
      userId: "u1",
      conversationId: "c1",
      responseMessage: reply("Here's the digest"),
      pendingApproval: false,
      error: undefined,
      notifyEmail: true,
      body: undefined,
    });
  });

  it("waiting → an approval, with the default text for a portal tool", async () => {
    const msg = approval({ fact: "x" });
    await afterRunTransition(run(), "waiting", msg);
    expect(lastCall()).toMatchObject({ pendingApproval: true, error: undefined, body: undefined, responseMessage: msg });
  });

  it("waiting on a Hermes approval → the Inbox text states Hermes' deadline", async () => {
    await afterRunTransition(run(), "waiting", approval({ command: "rm -rf build", expires_in_s: 300 }));
    expect(lastCall()).toMatchObject({ pendingApproval: true });
    expect(lastCall().body).toBe(
      'Routine "Daily digest" paused before a sensitive action. Open the conversation to allow or deny it. Hermes denies it if nobody answers within 5 min.',
    );
  });

  it.each([
    ["failed", "The model endpoint returned an error: boom", "The model endpoint returned an error: boom"],
    ["failed", null, "Interrupted."],
    ["cancelled", null, "Stopped."],
    ["interrupted", "The worker running this reply stopped. Try again.", "The worker running this reply stopped. Try again."],
    ["interrupted", null, "Interrupted."],
  ] as const)("%s (error %s) → the routine run fails with %s", async (status, error, expected) => {
    await afterRunTransition(run(), status, reply("partial"), error);
    expect(lastCall()).toMatchObject({ pendingApproval: false, error: expected });
  });

  it("a run that ended before saving anything reports an empty message with the run's message id", async () => {
    await afterRunTransition(run(), "failed", null, "This account is disabled.");
    expect(lastCall()).toMatchObject({ responseMessage: { id: "m1", role: "assistant", parts: [] }, error: "This account is disabled." });
  });

  it("uses the routine's bot when the run has none, and a fallback name when the bot is gone", async () => {
    h.rows.set(bots, []);
    await afterRunTransition(run({ botId: null }), "succeeded", reply("ok"));
    expect(lastCall()).toMatchObject({ botName: "Your bot" });
  });

  it("does nothing when the routine run or the routine is gone", async () => {
    h.rows.set(routines, []);
    await afterRunTransition(run(), "succeeded", reply("ok"));
    h.rows.set(routineRuns, []);
    await afterRunTransition(run(), "succeeded", reply("ok"));
    expect(h.afterRoutineTurn).not.toHaveBeenCalled();
  });
});

describe("routineErrorFor / approvalBodyFor", () => {
  it("maps only failed, cancelled and interrupted to an error", () => {
    expect(routineErrorFor("succeeded", "x")).toBeUndefined();
    expect(routineErrorFor("waiting", "x")).toBeUndefined();
    expect(routineErrorFor("failed", "")).toBe("Interrupted.");
    expect(routineErrorFor("cancelled")).toBe("Stopped.");
  });

  it("rounds the deadline to whole minutes (at least 1) and uses the earliest one", () => {
    expect(approvalBodyFor("R", approval({ expires_in_s: 20 }))).toContain("within 1 min");
    const two: PortalUIMessage = {
      id: "m",
      role: "assistant",
      parts: [...approval({ expires_in_s: 1800 }).parts, ...approval({ expires_in_s: 600 }).parts],
    };
    expect(approvalBodyFor("R", two)).toContain("within 10 min");
    expect(approvalBodyFor("R", null)).toBeUndefined();
    expect(approvalBodyFor("R", reply("no approvals"))).toBeUndefined();
  });
});
