import { beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.fn(async () => "job-id");
vi.mock("server-only", () => ({}));
vi.mock("@/lib/runs/state", () => ({
  getRun: vi.fn(async (id: string) => ({ id, segment: 2, background: false, executionMode: "async_delegate", routineRunId: null })),
}));

import { enqueueRun, QUEUES } from "@/lib/jobs";

describe("enqueueRun", () => {
  beforeEach(() => {
    send.mockClear();
    (globalThis as unknown as { __boss?: Promise<unknown> }).__boss = Promise.resolve({ send });
  });

  it("sends an immediate segment without a dedupe window", async () => {
    await enqueueRun({ id: "run", segment: 2, background: false });
    expect(send).toHaveBeenCalledWith(QUEUES.agentRunTasks, { runId: "run", segment: 2 }, { singletonKey: "run:2" });
  });

  it("collapses delayed claim retries for one segment into a single job per delay window", async () => {
    await enqueueRun({ id: "run", segment: 2, background: false }, { delaySeconds: 5 });
    expect(send).toHaveBeenCalledWith(QUEUES.agentRunTasks, { runId: "run", segment: 2 }, { singletonKey: "run:2", startAfter: 5, singletonSeconds: 5 });
  });
});
