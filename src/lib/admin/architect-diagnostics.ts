import type { Principal } from "@/lib/auth/groups";
import { HttpError } from "@/lib/authz";
import { adminHealth, adminRecentErrors, adminStatus } from "@/lib/admin/operations";

/** A bounded diagnostic rollup: counts and check classifications only, never names, payloads, env or URLs. */
export async function adminDiagnosticBundle(p: Principal, input: { days?: number; hours?: number } = {}) {
  if (!p.isAdmin) throw new HttpError(403, "Admin only");
  const days = Math.min(Math.max(input.days ?? 7, 1), 30);
  const hours = Math.min(Math.max(input.hours ?? 24, 1), 24 * 7);
  const [status, health, failures] = await Promise.all([
    adminStatus(p, { days }), adminHealth(p), adminRecentErrors(p, { hours, limit: 100 }),
  ]);
  return {
    generatedAt: new Date(), window: { days, hours },
    totals: {
      users: status.counts.users.total, disabledUsers: status.counts.users.disabled,
      bots: status.counts.bots.total, enabledBots: status.counts.bots.enabled,
      models: status.counts.models.total, enabledModels: status.counts.models.enabled,
      activeRuns: status.counts.activeRuns, usage: {
        activeUsers: status.usage.activeUsers, conversations: status.usage.conversations, messages: status.usage.messages,
        inputTokens: status.usage.inputTokens, outputTokens: status.usage.outputTokens, toolCalls: status.usage.toolCalls,
      },
    },
    health: { checkedAt: health.checkedAt, checks: health.checks.map(({ id, state }) => ({ id, state })) },
    failureCounts: {
      runs: failures.failedRuns.length, routineRuns: failures.failedRoutineRuns.length, toolErrorGroups: failures.toolErrors.length,
      mcpConnections: failures.mcpServers.length, spendingConnections: failures.spendingAccounts.length,
      hermesProvisioning: failures.hermesProvisioning.length, personalHermes: failures.personalHermes.length,
    },
  };
}
