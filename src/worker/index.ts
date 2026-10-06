import { reconcileDockerRuntimes } from "@/lib/docker-hermes/lifecycle";
/**
 * Background worker: every chat and routine reply (durable runs, src/lib/runs/execute.ts), routines (cron + webhook),
 * memory extraction, MCP tool-list refresh, workspace cleanup. Run with `npm run worker` (tsx) alongside the web app;
 * chat needs it. Safe to run multiple instances.
 */
import { startActivityDelivery } from "@/lib/live-activities/delivery";
import { pool } from "@/db";
import { getBoss, QUEUES, type AgentRunJob, type MemoryExtractJob, type RoutineRunJob } from "@/lib/jobs";
import { extractMemoriesFromConversation } from "@/lib/agent/memory";
import { recoverLearningReviews, reviewNativeRun } from "@/lib/agent/learning/review";
import { executeRoutineRun, scheduleDueRoutines } from "@/lib/agent/routine-runner";
import { warnAboutVendorEnv } from "@/lib/env-guard";
import { refreshAllMcpServers } from "@/lib/mcp/servers";
import { executeRun } from "@/lib/runs/execute";
import { runHost } from "@/lib/runs/host";
import { runListener } from "@/lib/runs/listener";
import { sweepRuns } from "@/lib/runs/sweeper";
import { runConfig } from "@/lib/runs/types";
import { sweepSandboxes } from "@/lib/sandbox/lifecycle";
import { rewrapAllSecrets } from "@/lib/secrets-rewrap";

/** How long running replies get to save their partial output on shutdown, then pg-boss's own grace period. */
const RUNS_SHUTDOWN_MS = 20_000;
const BOSS_STOP_MS = 10_000;

async function main() {
  const boss = await getBoss({ worker: true });
  console.log("[worker] started");
  const stopActivityDelivery = startActivityDelivery();
  warnAboutVendorEnv("worker");

  // Durable runs: one job per segment. Stops and listener reconnects reach running segments through the host.
  const host = runHost();
  host.start();
  const slots = (name: string, fallback: number) => {
    const n = Number(process.env[name] ?? fallback);
    return n > 0 ? n : fallback;
  };
  const runJob = async ([job]: { data: AgentRunJob; signal: AbortSignal }[]) => {
    await executeRun(job.data.runId, { signal: job.signal });
  };
  await boss.work<AgentRunJob>(QUEUES.agentRun, { batchSize: 1, localConcurrency: slots("AGENT_RUN_CONCURRENCY", 16) }, runJob);
  // Routines' first segments have slots of their own, so they never hold up chat replies.
  await boss.work<AgentRunJob>(QUEUES.agentRunBackground, { batchSize: 1, localConcurrency: slots("ROUTINE_RUN_CONCURRENCY", 2) }, runJob);
  await boss.work<AgentRunJob>(QUEUES.agentRunTasks, { batchSize: 1, localConcurrency: slots("TASK_RUN_CONCURRENCY", 4) }, runJob);
  let sweeping = false;
  const sweep = async (startup = false) => {
    if (sweeping) return;
    sweeping = true;
    try {
      const r = await sweepRuns({ startup });
      if (r.interrupted || r.requeued || r.cancelled || r.routines)
        console.log(`[worker] runs: ${r.interrupted} interrupted, ${r.requeued} re-enqueued, ${r.cancelled} cancelled, ${r.routines} routine runs reconciled`);
    } catch (err) {
      console.error("[worker] run sweeper error", err);
    } finally {
      sweeping = false;
    }
  };
  // At start too: runs a previous worker left running are interrupted once their heartbeat is stale, and every queued
  // run is enqueued again (a job taken by a worker that was shutting down is gone).
  void sweep(true);
  const sweepTimer = setInterval(() => void sweep(), runConfig().sweepMs);
  let reconcilingHermes = false;
  const reconcileHermes = async () => {
    if (reconcilingHermes) return;
    reconcilingHermes = true;
    try { await reconcileDockerRuntimes(); } catch { console.error('[worker] personal Hermes reconciliation failed; broker leases expire closed'); }
    finally { reconcilingHermes = false; }
  };
  void reconcileHermes();
  const hermesTimer = setInterval(() => void reconcileHermes(), 15000);

  // Re-encrypt secrets under the primary key (no-op when nothing changed). Safe with several replicas.
  rewrapAllSecrets()
    .then((n) => n && console.log(`[worker] re-encrypted ${n} stored secret(s)`))
    .catch((err) => console.error("[worker] secret re-encryption failed", err));

  await boss.work<RoutineRunJob>(QUEUES.routineRun, { batchSize: 1 }, async ([job]) => {
    console.log("[worker] routine run", job.data.runId);
    await executeRoutineRun(job.data.runId);
  });

  await boss.work<MemoryExtractJob>(QUEUES.memoryExtract, { batchSize: 1 }, async ([job]) => {
    const n = await extractMemoriesFromConversation(job.data.conversationId);
    if (n) console.log(`[worker] stored ${n} memories from ${job.data.conversationId}`);
  });

  await boss.work<{ runId: string }>(QUEUES.learningReview, { batchSize: 1, localConcurrency: 1 }, async ([job]) => {
    const n = await reviewNativeRun(job.data.runId);
    if (n) console.log(`[learning] saved ${n} lessons`);
  });
  const recoverLearning = () => recoverLearningReviews().catch(err => console.error("[learning] recovery failed", err));
  void recoverLearning();
  const learningTimer = setInterval(() => void recoverLearning(), 60_000);

  // MCP tool lists: hourly (one run across replicas, via pg-boss's schedule) and once at start, which also
  // captures the first snapshot of servers enabled before snapshots existed.
  await boss.work(QUEUES.mcpRefresh, { batchSize: 1 }, async () => {
    const r = await refreshAllMcpServers();
    if (r.drifted || r.failed) console.log(`[worker] MCP refresh: ${r.checked} checked, ${r.drifted} changed, ${r.failed} unreachable`);
  });
  await boss.schedule(QUEUES.mcpRefresh, process.env.MCP_REFRESH_CRON ?? "7 * * * *");
  await boss.send(QUEUES.mcpRefresh, {}, { singletonKey: "startup", singletonSeconds: 300 });

  await boss.work(QUEUES.sandboxCleanup, { batchSize: 1 }, async () => {
    const r = await sweepSandboxes();
    if (r.expired || r.orphans) console.log(`[worker] workspaces: ${r.expired} destroyed after disable, ${r.orphans} orphans removed`);
  });
  await boss.schedule(QUEUES.sandboxCleanup, process.env.SANDBOX_CLEANUP_CRON ?? "23 * * * *");

  const tick = async () => {
    try {
      const n = await scheduleDueRoutines();
      if (n) console.log(`[worker] queued ${n} scheduled routine(s)`);
    } catch (err) {
      console.error("[worker] scheduler error", err);
    }
  };
  await tick();
  const timer = setInterval(tick, Number(process.env.SCHEDULER_INTERVAL_MS ?? 20_000));

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    console.log("[worker] shutting down");
    stopActivityDelivery();
    clearInterval(timer);
    clearInterval(sweepTimer);
    clearInterval(hermesTimer);
    clearInterval(learningTimer);
    // Stop fetching runs without waiting for the running ones (offWork's default waits for them to finish)...
    for (const q of [QUEUES.agentRun, QUEUES.agentRunBackground, QUEUES.agentRunTasks])
      await boss.offWork(q, { wait: false }).catch((err) => console.error("[worker] offWork failed", err));
    // ...which are aborted instead: each saves its partial reply as interrupted.
    await host.shutdown(RUNS_SHUTDOWN_MS).catch((err) => console.error("[worker] run shutdown failed", err));
    await boss.stop({ graceful: true, timeout: BOSS_STOP_MS }).catch(() => {});
    await runListener()
      .close()
      .catch(() => {});
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[worker] fatal", err);
  process.exit(1);
});
