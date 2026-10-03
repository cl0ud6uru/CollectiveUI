import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  heartbeatRuns: vi.fn<(holder: string, ids: string[]) => Promise<{ id: string; cancelRequestedAt: Date | null }[]>>(async () => []),
  closeAllParked: vi.fn(() => 0),
  dropParkedForAgentRun: vi.fn<(id: string) => boolean>(() => false),
  onSignal: null as null | ((sig: { r: string; k: string }) => void),
  unsubscribe: vi.fn(),
}));

vi.mock("@/lib/runs/state", () => ({ heartbeatRuns: h.heartbeatRuns }));
vi.mock("@/lib/llm/providers/hermes/runs", () => ({ closeAllParked: h.closeAllParked, dropParkedForAgentRun: h.dropParkedForAgentRun }));
vi.mock("@/lib/runs/listener", () => ({
  runListener: () => ({
    subscribeAll: (fn: (sig: { r: string; k: string }) => void) => {
      h.onSignal = fn;
      return h.unsubscribe;
    },
  }),
}));

import { RunHost } from "@/lib/runs/host";
import { abortKindOf } from "@/lib/runs/types";

const kind = (ac: AbortController) => (ac.signal.aborted ? abortKindOf(ac.signal.reason) : undefined);

describe("RunHost", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.onSignal = null;
    h.heartbeatRuns.mockResolvedValue([]);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("has a per-process instance id (host:pid:random)", () => {
    const a = new RunHost();
    const b = new RunHost();
    expect(a.instanceId).toMatch(new RegExp(`:${process.pid}:[0-9a-f]{8}$`));
    expect(a.instanceId).not.toBe(b.instanceId);
  });

  it("heartbeats every tracked run in one call; a run missing from the result aborts as lease-lost", async () => {
    const host = new RunHost();
    const a = new AbortController();
    const b = new AbortController();
    const untrackA = host.track("run-a", a);
    host.track("run-b", b);
    h.heartbeatRuns.mockResolvedValueOnce([{ id: "run-b", cancelRequestedAt: null }]);
    await host.heartbeat();
    expect(h.heartbeatRuns).toHaveBeenCalledWith(host.instanceId, ["run-a", "run-b"]);
    expect(kind(a)).toBe("lease-lost");
    expect(kind(b)).toBeUndefined();
    untrackA();
    expect(host.tracked()).toEqual(["run-b"]);
  });

  it("a cancel request seen by the heartbeat aborts as cancel", async () => {
    const host = new RunHost();
    const a = new AbortController();
    host.track("run-a", a);
    h.heartbeatRuns.mockResolvedValueOnce([{ id: "run-a", cancelRequestedAt: new Date() }]);
    await host.heartbeat();
    expect(kind(a)).toBe("cancel");
  });

  it("doesn't abort the next segment of a run that was re-tracked while the heartbeat ran", async () => {
    const host = new RunHost();
    const first = new AbortController();
    const untrack = host.track("run-a", first);
    let release!: (v: { id: string; cancelRequestedAt: Date | null }[]) => void;
    h.heartbeatRuns.mockImplementationOnce(() => new Promise((r) => (release = r)));
    const beat = host.heartbeat();
    untrack(); // the segment paused...
    const second = new AbortController();
    host.track("run-a", second); // ...and its continuation started here
    release([]); // the statement saw the run waiting
    await beat;
    expect(kind(first)).toBeUndefined();
    expect(kind(second)).toBeUndefined();
  });

  it("keeps going when the heartbeat can't reach the database", async () => {
    const host = new RunHost();
    const a = new AbortController();
    host.track("run-a", a);
    h.heartbeatRuns.mockRejectedValueOnce(new Error("connection refused"));
    vi.spyOn(console, "warn").mockImplementationOnce(() => {});
    await host.heartbeat();
    expect(a.signal.aborted).toBe(false);
  });

  it("the timer heartbeats every runConfig().heartbeatMs while something is tracked", async () => {
    vi.useFakeTimers();
    vi.stubEnv("RUN_HEARTBEAT_MS", "1000");
    try {
      const host = new RunHost();
      const untrack = host.track("run-a", new AbortController());
      h.heartbeatRuns.mockResolvedValue([{ id: "run-a", cancelRequestedAt: null }]);
      await vi.advanceTimersByTimeAsync(2500);
      expect(h.heartbeatRuns).toHaveBeenCalledTimes(2);
      untrack();
      await vi.advanceTimersByTimeAsync(5000);
      expect(h.heartbeatRuns).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("a stop signal aborts the tracked run as cancel and closes a held Hermes stream for any run", () => {
    const host = new RunHost();
    host.start();
    const a = new AbortController();
    host.track("run-a", a);
    h.onSignal!({ r: "run-a", k: "c" });
    expect(kind(a)).toBe("cancel");
    expect(h.dropParkedForAgentRun).toHaveBeenCalledWith("run-a");
    h.onSignal!({ r: "run-paused", k: "c" });
    expect(h.dropParkedForAgentRun).toHaveBeenCalledWith("run-paused");
    // Other signals don't abort anything.
    const b = new AbortController();
    host.track("run-b", b);
    h.onSignal!({ r: "run-b", k: "e" });
    h.onSignal!({ r: "run-b", k: "t" });
    expect(b.signal.aborted).toBe(false);
  });

  it("a listener reconnect triggers an immediate heartbeat", async () => {
    const host = new RunHost();
    host.start();
    host.track("run-a", new AbortController());
    h.heartbeatRuns.mockResolvedValue([{ id: "run-a", cancelRequestedAt: null }]);
    h.onSignal!({ r: "*", k: "reconnect" });
    await vi.waitFor(() => expect(h.heartbeatRuns).toHaveBeenCalledTimes(1));
  });

  it("shutdown aborts every run as shutdown, waits for them to let go, then closes held streams", async () => {
    const host = new RunHost();
    host.start();
    const a = new AbortController();
    const b = new AbortController();
    const untrackA = host.track("run-a", a);
    const untrackB = host.track("run-b", b);
    // Each segment saves and untracks shortly after its abort.
    a.signal.addEventListener("abort", () => setTimeout(untrackA, 20));
    b.signal.addEventListener("abort", () => setTimeout(untrackB, 40));
    h.closeAllParked.mockReturnValueOnce(2);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const t0 = Date.now();
    await host.shutdown(5_000);
    log.mockRestore();
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(kind(a)).toBe("shutdown");
    expect(kind(b)).toBe("shutdown");
    expect(host.tracked()).toEqual([]);
    expect(host.shuttingDown).toBe(true);
    expect(h.closeAllParked).toHaveBeenCalledTimes(1);
    expect(h.unsubscribe).toHaveBeenCalled();
    // Nothing starts once shutting down.
    const late = new AbortController();
    host.track("run-late", late);
    expect(kind(late)).toBe("shutdown");
  });

  it("shutdown gives up waiting after the timeout", async () => {
    const host = new RunHost();
    const stuck = new AbortController();
    host.track("run-stuck", stuck);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await host.shutdown(50);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("didn't finish"));
    warn.mockRestore();
    expect(kind(stuck)).toBe("shutdown");
    expect(h.closeAllParked).toHaveBeenCalledTimes(1);
  });
});
