import { PgBoss } from "pg-boss";
import { isBackgroundSegment, runConfig } from "@/lib/runs/types";

export const QUEUES = {
  /** One segment of a durable run (src/lib/runs/execute.ts): every direct-chat turn, and routines once answered. */
  agentRun: "agent.run",
  /**
   * A routine's first segment (nobody watching). Its own queue with few slots, so a burst of routines can't take the
   * slots chat replies need.
   */
  agentRunBackground: "agent.run.bg",
  /** Native delegated jobs have separate slots; suspended parents release theirs. */
  agentRunTasks: "agent.run.tasks",
  routineRun: "routine.run",
  memoryExtract: "memory.extract",
  /** Hourly: re-list MCP servers' tools and flag changes for review (src/lib/mcp/servers.ts). */
  mcpRefresh: "mcp.refresh",
  /** Hourly: destroy workspaces of people disabled long enough, and orphaned sandboxes (src/lib/sandbox/lifecycle.ts). */
  sandboxCleanup: "sandbox.cleanup",
} as const;

export type RoutineRunJob = { runId: string };
export type AgentRunJob = { runId: string; segment: number };

/**
 * agent.run: one job per segment, never retried (tool side effects), heartbeat so a dead worker's job is released,
 * and notify so an idle worker picks it up at once instead of on its next poll. Heartbeats don't extend the expiry, so
 * it covers the longest segment. createQueue never changes an existing queue, and updateQueue can't change
 * heartbeatSeconds: the worker applies the rest with updateQueue on start.
 */
export function agentRunQueueOptions() {
  const { runTimeoutMs, routineTimeoutMs } = runConfig();
  return {
    expireInSeconds: Math.min(86_400, Math.ceil(Math.max(runTimeoutMs, routineTimeoutMs) / 1000) + 900),
    heartbeatSeconds: 30,
    retryLimit: 0,
    notify: true,
  };
}
export type MemoryExtractJob = { conversationId: string };

const g = globalThis as unknown as { __boss?: Promise<PgBoss> };

/**
 * Lazily started pg-boss client. The web app only sends jobs; the worker process consumes them and passes
 * `{ worker: true }` on its first call, which listens for job notifications (instant pickup) and uses a larger pool.
 */
export function getBoss(opts: { worker?: boolean } = {}): Promise<PgBoss> {
  g.__boss ??= (async () => {
    const boss = new PgBoss({
      connectionString: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/portal",
      max: opts.worker ? Number(process.env.JOBS_POOL_MAX ?? 6) : 3,
      ...(opts.worker ? { useListenNotify: true } : {}),
    });
    boss.on("error", (err) => console.error("[jobs]", err));
    await boss.start();
    for (const name of Object.values(QUEUES)) {
      const options = [QUEUES.agentRun, QUEUES.agentRunBackground, QUEUES.agentRunTasks].includes(name as typeof QUEUES.agentRun) ? agentRunQueueOptions() : undefined;
      if (!(await boss.getQueue(name))) await boss.createQueue(name, options);
      else if (options && opts.worker) {
        const { heartbeatSeconds: _fixed, ...updatable } = options;
        void _fixed;
        await boss.updateQueue(name, updatable);
      }
    }
    return boss;
  })().catch((err) => {
    g.__boss = undefined;
    throw err;
  });
  return g.__boss;
}

export async function enqueue(name: string, data: object, options?: Parameters<PgBoss["send"]>[2]) {
  try {
    const boss = await getBoss();
    return await boss.send(name, data, options ?? {});
  } catch (err) {
    console.error(`[jobs] failed to enqueue ${name}`, err);
    return null;
  }
}

/** The queue a run's segment goes to: a routine's first segment runs on the background queue. */
export const runQueue = (run: Parameters<typeof isBackgroundSegment>[0]) =>
  run.executionMode === "async_delegate" ? QUEUES.agentRunTasks : isBackgroundSegment(run) ? QUEUES.agentRunBackground : QUEUES.agentRun;

/**
 * Queues one segment of a run (on runQueue's queue). Throws when the queue is unreachable (the caller fails the run
 * rather than leaving it queued forever). Duplicate sends for the same segment are harmless: claiming is idempotent.
 */
export async function enqueueRun(run: { id: string; segment: number; background: boolean }, opts: { delaySeconds?: number } = {}) {
  const { getRun } = await import("@/lib/runs/state");
  const stored = await getRun(run.id);
  if (!stored || stored.executionMode === "inline_delegate") throw new Error("Inline delegated tasks cannot be queued.");
  const boss = await getBoss();
  const { id: runId, segment } = run;
  return boss.send(runQueue(stored), { runId, segment } satisfies AgentRunJob, {
    singletonKey: `${runId}:${segment}`,
    ...(opts.delaySeconds ? { startAfter: opts.delaySeconds } : {}),
  });
}

/** Debounced memory extraction: runs once the conversation has been quiet for a few minutes. */
export async function scheduleMemoryExtraction(conversationId: string) {
  try {
    const boss = await getBoss();
    await boss.sendDebounced(QUEUES.memoryExtract, { conversationId }, null, 180, conversationId);
  } catch (err) {
    console.error("[jobs] memory extraction enqueue failed", err);
  }
}
