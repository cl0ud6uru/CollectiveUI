import { and, eq, gt, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Principal } from '@/lib/auth/groups';
import { db } from '@/db';
import { agentRuns, aiApps, bots, dockerHermesEnrollments, hermesProvisions, mcpServers, providerBillingAccounts, routineRuns, toolCalls, users } from '@/db/schema';
import { assertAdmin } from '@/lib/authz';
import { usageSummary } from '@/lib/usage';

const ACTIVE_RUNS = ['queued', 'running', 'waiting', 'waiting_tasks'] as const;
const countRows = async (query: PromiseLike<unknown[]>) => (await query).length;

/**
 * Worker-safe diagnostic rollup. Keep this path on the shared DB/usage layer;
 * admin/operations also imports portal-only probes (billing, sandboxd, queues)
 * that are marked server-only and cannot be loaded by the background worker.
 * Return only numeric aggregates and fixed database/worker classifications.
 */
export async function adminDiagnosticBundle(p: Principal, input: { days?: number; hours?: number } = {}) {
  assertAdmin(p);
  const days = Math.min(Math.max(input.days ?? 7, 1), 30);
  const hours = Math.min(Math.max(input.hours ?? 24, 1), 24 * 7);
  const since = new Date(Date.now() - hours * 3_600_000);
  const [people, botCounts, models, activeRuns, usage, failures] = await Promise.all([
    db.select({ total: sql<number>`count(*)::int`, disabled: sql<number>`count(*) filter (where ${users.disabled})::int` }).from(users),
    db.select({ total: sql<number>`count(*)::int`, enabled: sql<number>`count(*) filter (where ${bots.enabled})::int` }).from(bots),
    db.select({ total: sql<number>`count(*)::int`, enabled: sql<number>`count(*) filter (where ${aiApps.enabled})::int` }).from(aiApps),
    db.select({ count: sql<number>`count(*)::int` }).from(agentRuns).where(inArray(agentRuns.status, [...ACTIVE_RUNS])),
    usageSummary(days),
    Promise.all([
      countRows(db.select({ id: agentRuns.id }).from(agentRuns).where(and(inArray(agentRuns.status, ['failed', 'interrupted']), gt(agentRuns.updatedAt, since))).limit(100)),
      countRows(db.select({ id: routineRuns.id }).from(routineRuns).where(and(eq(routineRuns.status, 'failed'), gt(routineRuns.createdAt, since))).limit(100)),
      countRows(db.select({ tool: toolCalls.toolName, bot: toolCalls.botId }).from(toolCalls).where(and(eq(toolCalls.status, 'error'), gt(toolCalls.createdAt, since))).groupBy(toolCalls.toolName, toolCalls.botId).limit(100)),
      countRows(db.select({ id: mcpServers.id }).from(mcpServers).where(and(isNotNull(mcpServers.lastError), gt(mcpServers.lastTestedAt, since))).limit(100)),
      countRows(db.select({ id: providerBillingAccounts.id }).from(providerBillingAccounts).where(and(isNotNull(providerBillingAccounts.lastError), gt(providerBillingAccounts.lastAttemptAt, since))).limit(100)),
      countRows(db.select({ id: hermesProvisions.id }).from(hermesProvisions).where(and(eq(hermesProvisions.status, 'failed'), gt(hermesProvisions.updatedAt, since))).limit(100)),
      countRows(db.select({ userId: dockerHermesEnrollments.userId }).from(dockerHermesEnrollments).where(and(isNotNull(dockerHermesEnrollments.error), gt(dockerHermesEnrollments.updatedAt, since))).limit(100)),
    ]),
  ]);
  const [failedRuns, failedRoutineRuns, toolErrorGroups, mcpConnections, spendingConnections, hermesProvisioning, personalHermes] = failures;

  const [databaseCheck, workerCheck] = await Promise.all([
    db.execute(sql`select 1`).then(() => ({ id: 'database', state: 'pass' as const }), () => ({ id: 'database', state: 'fail' as const })),
    db.select({ staleRunning: sql<number>`count(*) filter (where ${agentRuns.status} = 'running' and (${agentRuns.heartbeatAt} is null or ${agentRuns.heartbeatAt} < now() - interval '2 minutes'))::int`,
      oldQueued: sql<number>`count(*) filter (where ${agentRuns.status} = 'queued' and ${agentRuns.executionMode} = 'worker' and ${agentRuns.createdAt} < now() - interval '5 minutes')::int` })
      .from(agentRuns).where(inArray(agentRuns.status, ['queued', 'running']))
      .then(([row]) => ({ id: 'worker', state: row.staleRunning || row.oldQueued ? 'warn' as const : 'pass' as const })),
  ]);
  const totals = usage.totals;
  const num = (value: unknown) => Number(value ?? 0);
  return {
    generatedAt: new Date(), window: { days, hours },
    totals: {
      users: people[0]?.total ?? 0, disabledUsers: people[0]?.disabled ?? 0,
      bots: botCounts[0]?.total ?? 0, enabledBots: botCounts[0]?.enabled ?? 0,
      models: models[0]?.total ?? 0, enabledModels: models[0]?.enabled ?? 0,
      activeRuns: activeRuns[0]?.count ?? 0,
      usage: {
        activeUsers: num(totals.active_users), conversations: num(totals.conversations), messages: num(totals.messages),
        inputTokens: num(totals.input_tokens), outputTokens: num(totals.output_tokens), toolCalls: num(totals.tool_calls),
      },
    },
    // Network/service probes are intentionally excluded here: those live in the
    // portal-only Admin operations path and cannot be invoked in the worker.
    health: { checkedAt: new Date(), checks: [databaseCheck, workerCheck] },
    failureCounts: { runs: failedRuns, routineRuns: failedRoutineRuns, toolErrorGroups, mcpConnections, spendingConnections, hermesProvisioning, personalHermes },
  };
}
