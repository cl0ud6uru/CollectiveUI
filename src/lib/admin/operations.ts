import { and, desc, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  agentRuns, aiApps, bots, dockerHermesEnrollments, hermesProvisions, mcpServers, providerBillingAccounts, routineRuns, routines, toolCalls, users,
} from "@/db/schema";
import type { Principal } from "@/lib/auth/groups";
import { assertAdmin } from "@/lib/authz";
import { readBillingAccounts } from "@/lib/billing/read";
import { QUEUES } from "@/lib/jobs";
import { sandboxd } from "@/lib/sandbox/client";
import { workspaceConfigState } from "@/lib/sandbox/setup";
import { readWorkspaceSetup } from "@/lib/sandbox/setup-check";
import { listSandboxRows, listWorkspaceInstances } from "@/lib/sandbox/store";
import { getSetting } from "@/lib/settings";
import { usageSummary } from "@/lib/usage";
import packageJson from "../../../package.json";

/*
 * Read-only operational state for The Architect. Every function checks assertAdmin itself, never changes state (no
 * MCP tests, billing refreshes or workspace starts) and returns explicit, non-secret fields. Health checks say what was
 * actually verified; anything that could not be checked is reported as such, never as passing.
 */

const ACTIVE_RUN = ["queued", "running", "waiting", "waiting_tasks"] as const;
const num = (v: unknown) => Number(v ?? 0);
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
const clamp = (v: number | undefined, d: number, max: number) => Math.min(Math.max(v ?? d, 1), max);

/** Resolves to the value, or to `timedOut` if the check takes longer than `ms`. */
async function within<T>(ms: number, check: Promise<T>, timedOut: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([check, new Promise<T>(resolve => { timer = setTimeout(() => resolve(timedOut), ms); })]);
  } finally { clearTimeout(timer); }
}

export async function adminStatus(p: Principal, opts: { days?: number } = {}) {
  assertAdmin(p);
  const days = clamp(opts.days, 30, 365);
  const [usage, people, botCounts, models, servers, runs, settings] = await Promise.all([
    usageSummary(days),
    db.select({ total: sql<number>`count(*)::int`, disabled: sql<number>`count(*) filter (where ${users.disabled})::int`,
      accountAdmins: sql<number>`count(*) filter (where ${users.isAdmin})::int` }).from(users),
    db.select({ total: sql<number>`count(*)::int`, enabled: sql<number>`count(*) filter (where ${bots.enabled})::int` }).from(bots),
    db.select({ total: sql<number>`count(*)::int`, enabled: sql<number>`count(*) filter (where ${aiApps.enabled})::int` }).from(aiApps),
    db.select({ status: mcpServers.status, count: sql<number>`count(*)::int` }).from(mcpServers).groupBy(mcpServers.status),
    db.select({ status: agentRuns.status, count: sql<number>`count(*)::int` }).from(agentRuns).where(inArray(agentRuns.status, [...ACTIVE_RUN])).groupBy(agentRuns.status),
    Promise.all([getSetting("tools"), getSetting("sandbox"), getSetting("coordinator"), getSetting("remoteHermes"), getSetting("chatgpt"),
      getSetting("decisions"), getSetting("officeBot"), getSetting("architectBot")]),
  ]);
  const [tools, sandbox, coordinator, remoteHermes, chatgpt, decisions, officeBot, architectBot] = settings;
  const t = usage.totals;
  const { teamBotsEnabled } = await import("@/lib/hermes-team/policy");
  return {
    version: packageJson.version,
    usage: {
      days, activeUsers: num(t?.active_users), conversations: num(t?.conversations), messages: num(t?.messages),
      inputTokens: num(t?.input_tokens), outputTokens: num(t?.output_tokens), toolCalls: num(t?.tool_calls),
      thumbsUp: num(t?.thumbs_up), thumbsDown: num(t?.thumbs_down),
      busiestTargets: usage.byApp.map(a => ({ name: a.name, messages: num(a.messages), tokenCount: num(a.tokens) })),
    },
    counts: {
      users: people[0], bots: botCounts[0], models: models[0],
      mcpServers: Object.fromEntries(servers.map(s => [s.status, s.count])),
      activeRuns: Object.fromEntries(runs.map(r => [r.status, r.count])),
    },
    features: {
      workspaces: { enabled: sandbox.enabled, access: sandbox.access, standardIsolationAllowed: sandbox.allowRunc },
      coordinator: { enabled: coordinator.enabled, hasDefaultBot: !!coordinator.defaultBotId },
      remoteHermes: { enabled: remoteHermes.enabled, sessionYoloAllowed: remoteHermes.allowSessionYolo },
      chatgptPlans: { enabled: chatgpt.enabled, access: chatgpt.access, background: chatgpt.allowBackground },
      teamBots: teamBotsEnabled(),
      decisions: { queenRouting: !!decisions.queenRouting, skillPicking: !!decisions.skillPicking, toolShortlisting: !!decisions.toolShortlisting },
      tools: { disabled: tools.disabledTools, enforcedApproval: tools.enforcedApproval, webSearchProvider: tools.webSearch.provider,
        nativeSearch: !!tools.nativeSearch?.enabled, maxStepsCap: tools.maxStepsCap, botCreation: tools.botCreation },
      installed: { officeBot: !!officeBot.botId, architect: !!architectBot.botId },
    },
  };
}

type Check = { id: string; label: string; state: "pass" | "warn" | "fail" | "not-configured" | "unknown"; detail: string };

export async function adminHealth(p: Principal) {
  assertAdmin(p);
  const checks = await Promise.all([
    databaseCheck(), workerCheck(), queueCheck(), workspaceCheck(), dockerHermesCheck(), localHermesCheck(), mcpCheck(), billingCheck(),
  ]);
  return { checkedAt: new Date(), healthy: checks.every(c => c.state === "pass" || c.state === "not-configured"), checks };
}

async function databaseCheck(): Promise<Check> {
  const started = Date.now();
  const answered = await within(5000, db.execute(sql`select 1`).then(() => true, () => false), false);
  return answered
    ? { id: "database", label: "Database", state: "pass", detail: `Answered a query in ${Date.now() - started} ms.` }
    : { id: "database", label: "Database", state: "fail", detail: "The database did not answer a query within 5 seconds." };
}

async function workerCheck(): Promise<Check> {
  const [row] = await db.select({
    lastHeartbeat: sql<Date | null>`max(${agentRuns.heartbeatAt})`,
    staleRunning: sql<number>`count(*) filter (where ${agentRuns.status} = 'running' and (${agentRuns.heartbeatAt} is null or ${agentRuns.heartbeatAt} < now() - interval '2 minutes'))::int`,
    oldQueued: sql<number>`count(*) filter (where ${agentRuns.status} = 'queued' and ${agentRuns.executionMode} = 'worker' and ${agentRuns.createdAt} < now() - interval '5 minutes')::int`,
  }).from(agentRuns).where(inArray(agentRuns.status, ["queued", "running"]));
  const problems = [row.staleRunning && `${row.staleRunning} running run(s) without a heartbeat for over 2 minutes`,
    row.oldQueued && `${row.oldQueued} run(s) queued for over 5 minutes`].filter(Boolean);
  return { id: "worker", label: "Background worker", state: problems.length ? "warn" : "pass",
    detail: problems.length ? `${problems.join("; ")}. The worker may be stopped or overloaded.`
      : "No stalled or long-queued runs. (Inferred from run heartbeats; an idle worker is not probed directly.)" };
}

async function queueCheck(): Promise<Check> {
  try {
    const queues = await within(5000, readPersistedQueues(), null as QueueCounts[] | null);
    if (!queues) return { id: "queues", label: "Job queues", state: "unknown", detail: "The job queue did not answer within 5 seconds." };
    const failed = queues.reduce((n, q) => n + q.failed, 0);
    return { id: "queues", label: "Job queues", state: failed ? "warn" : "pass",
      detail: failed ? `${failed} recently failed job(s) are retained; see admin_jobs.` : `${queues.length} queues readable, no retained failures.` };
  } catch {
    return { id: "queues", label: "Job queues", state: "unknown", detail: "Persisted job queue counters could not be read." };
  }
}

async function workspaceCheck(): Promise<Check> {
  const settings = await getSetting("sandbox");
  if (!settings.enabled && workspaceConfigState(process.env) !== "configured")
    return { id: "workspaces", label: "Workspaces", state: "not-configured", detail: "Workspaces are off and sandboxd is not configured." };
  const report = await readWorkspaceSetup(settings.allowRunc);
  const failed = report.checks.filter(c => c.state !== "pass");
  return { id: "workspaces", label: "Workspaces", state: report.ready ? (report.hasWarnings ? "warn" : "pass") : "fail",
    detail: report.ready ? `All ${report.checks.length} sandboxd setup checks passed${report.hasWarnings ? ", with service warnings" : ""}.`
      : `${failed.length} setup checks did not pass. Inspect Admin → Workspaces for details.` };
}

async function dockerHermesCheck(): Promise<Check> {
  const { dockerBrokerReadiness } = await import("@/lib/docker-hermes/enrollment");
  const r = await dockerBrokerReadiness();
  return { id: "docker-hermes", label: "Personal Hermes broker", state: r.status === "ready" ? "pass" : r.status === "not-configured" ? "not-configured" : "fail", detail: r.status === "ready" ? "The broker answered its readiness check." : "The broker is unavailable or not configured; inspect Admin → Hermes." };
}

async function localHermesCheck(): Promise<Check> {
  if (!process.env.LOCAL_HERMES_SOCKET) return { id: "local-hermes", label: "Local Hermes", state: "not-configured", detail: "LOCAL_HERMES_SOCKET is not set." };
  try {
    const { localControl } = await import("@/lib/local-hermes/client");
    const answered = await within(5000, localControl("status").then(() => true, () => false), false);
    return { id: "local-hermes", label: "Local Hermes", state: answered ? "pass" : "fail",
      detail: answered ? "The local controller answered a status request." : "The local controller did not answer within 5 seconds." };
  } catch {
    return { id: "local-hermes", label: "Local Hermes", state: "fail", detail: "The local controller refused or failed a status request." };
  }
}

async function mcpCheck(): Promise<Check> {
  const rows = await db.select({ name: mcpServers.name, status: mcpServers.status, failing: sql<boolean>`${mcpServers.lastError} is not null` })
    .from(mcpServers).where(inArray(mcpServers.status, ["enabled", "needs_review"]));
  if (!rows.length) return { id: "mcp", label: "MCP servers", state: "not-configured", detail: "No MCP servers are in use." };
  const failing = rows.filter(r => r.failing).map(r => r.name), review = rows.filter(r => r.status === "needs_review").map(r => r.name);
  return { id: "mcp", label: "MCP servers", state: failing.length || review.length ? "warn" : "pass",
    detail: [`${rows.length} in use, from their last test or hourly refresh (not probed live).`,
      failing.length ? `Last check failed: ${failing.join(", ")}.` : "", review.length ? `Tool changes need review: ${review.join(", ")}.` : ""].filter(Boolean).join(" ") };
}

async function billingCheck(): Promise<Check> {
  const rows = await db.select({ name: providerBillingAccounts.name, failing: sql<boolean>`${providerBillingAccounts.lastError} is not null` })
    .from(providerBillingAccounts).where(eq(providerBillingAccounts.enabled, true));
  if (!rows.length) return { id: "billing", label: "Spending accounts", state: "not-configured", detail: "No provider spending accounts are enabled." };
  const failing = rows.filter(r => r.failing).map(r => r.name);
  return { id: "billing", label: "Spending accounts", state: failing.length ? "warn" : "pass",
    detail: failing.length ? `Last refresh failed: ${failing.join(", ")}.` : `${rows.length} account(s) refreshed without errors last time.` };
}

export async function adminRecentErrors(p: Principal, opts: { hours?: number; limit?: number } = {}) {
  assertAdmin(p);
  const hours = clamp(opts.hours, 24, 24 * 14), limit = clamp(opts.limit, 50, 200), since = hoursAgo(hours);
  const [runs, routineFailures, toolErrors, servers, billing, provisions, enrollments] = await Promise.all([
    db.select({ runId: agentRuns.id, status: agentRuns.status, hasError: sql<boolean>`${agentRuns.error} is not null`, bot: bots.name, user: users.name, background: agentRuns.background,
      at: sql<Date>`coalesce(${agentRuns.finishedAt}, ${agentRuns.updatedAt})` })
      .from(agentRuns).leftJoin(bots, eq(bots.id, agentRuns.botId)).innerJoin(users, eq(users.id, agentRuns.userId))
      .where(and(inArray(agentRuns.status, ["failed", "interrupted"]), gt(agentRuns.updatedAt, since))).orderBy(desc(agentRuns.updatedAt)).limit(limit),
    db.select({ routine: routines.name, hasError: sql<boolean>`${routineRuns.error} is not null`, trigger: routineRuns.trigger, at: sql<Date>`coalesce(${routineRuns.finishedAt}, ${routineRuns.createdAt})` })
      .from(routineRuns).innerJoin(routines, eq(routines.id, routineRuns.routineId))
      .where(and(eq(routineRuns.status, "failed"), gt(routineRuns.createdAt, since))).orderBy(desc(routineRuns.createdAt)).limit(limit),
    // Counts only: tool inputs and outputs are people's data.
    db.select({ tool: toolCalls.toolName, bot: bots.name, count: sql<number>`count(*)::int`, lastAt: sql<Date>`max(${toolCalls.createdAt})` })
      .from(toolCalls).leftJoin(bots, eq(bots.id, toolCalls.botId))
      .where(and(eq(toolCalls.status, "error"), gt(toolCalls.createdAt, since))).groupBy(toolCalls.toolName, bots.name).orderBy(desc(sql`count(*)`)).limit(limit),
    db.select({ name: mcpServers.name, status: mcpServers.status, hasError: sql<boolean>`${mcpServers.lastError} is not null`, at: mcpServers.lastTestedAt }).from(mcpServers).where(and(isNotNull(mcpServers.lastError), gt(mcpServers.lastTestedAt, since))).orderBy(desc(mcpServers.lastTestedAt)).limit(limit),
    db.select({ name: providerBillingAccounts.name, hasError: sql<boolean>`${providerBillingAccounts.lastError} is not null`, at: providerBillingAccounts.lastAttemptAt }).from(providerBillingAccounts).where(and(isNotNull(providerBillingAccounts.lastError), gt(providerBillingAccounts.lastAttemptAt, since))).orderBy(desc(providerBillingAccounts.lastAttemptAt)).limit(limit),
    db.select({ profile: hermesProvisions.profile, hasError: sql<boolean>`${hermesProvisions.error} is not null`, attempts: hermesProvisions.attempts, at: hermesProvisions.updatedAt })
      .from(hermesProvisions).where(and(eq(hermesProvisions.status, "failed"), gt(hermesProvisions.updatedAt, since))).orderBy(desc(hermesProvisions.updatedAt)).limit(limit),
    db.select({ user: users.name, hasError: sql<boolean>`${dockerHermesEnrollments.error} is not null`, at: dockerHermesEnrollments.updatedAt })
      .from(dockerHermesEnrollments).innerJoin(users, eq(users.id, dockerHermesEnrollments.userId)).where(and(isNotNull(dockerHermesEnrollments.error), gt(dockerHermesEnrollments.updatedAt, since))).orderBy(desc(dockerHermesEnrollments.updatedAt)).limit(limit),
  ]);
  return {
    windowHours: hours,
    failedRuns: runs, failedRoutineRuns: routineFailures, toolErrors, mcpServers: servers, spendingAccounts: billing,
    hermesProvisioning: provisions, personalHermes: enrollments,
  };
}

export async function adminRuns(p: Principal, opts: { hours?: number; limit?: number } = {}) {
  assertAdmin(p);
  const hours = clamp(opts.hours, 24, 24 * 14), limit = clamp(opts.limit, 50, 200);
  const [byStatus, active] = await Promise.all([
    db.select({ status: agentRuns.status, count: sql<number>`count(*)::int` }).from(agentRuns).where(gt(agentRuns.createdAt, hoursAgo(hours))).groupBy(agentRuns.status),
    // Never resumeState (provider continuation state) or holder (worker lease).
    db.select({ runId: agentRuns.id, status: agentRuns.status, bot: bots.name, user: users.name, background: agentRuns.background, mode: agentRuns.executionMode,
      segment: agentRuns.segment, createdAt: agentRuns.createdAt, startedAt: agentRuns.startedAt, heartbeatAt: agentRuns.heartbeatAt,
      cancelRequested: sql<boolean>`${agentRuns.cancelRequestedAt} is not null` })
      .from(agentRuns).leftJoin(bots, eq(bots.id, agentRuns.botId)).innerJoin(users, eq(users.id, agentRuns.userId))
      .where(inArray(agentRuns.status, [...ACTIVE_RUN])).orderBy(desc(agentRuns.createdAt)).limit(limit),
  ]);
  return { windowHours: hours, byStatus: Object.fromEntries(byStatus.map(r => [r.status, r.count])), active };
}

type QueueCounts = { name: string; ready: number; deferred: number; active: number; failed: number; total: number };

/** Read the persisted pg-boss counters without starting its client or creating queues. */
async function readPersistedQueues(): Promise<QueueCounts[]> {
  const names = Object.values(QUEUES);
  const queueNames = sql.join(names.map(name => sql`${name}`), sql`, `);
  const rows = await db.execute<QueueCounts>(sql`
      select name, ready_count as ready, deferred_count as deferred, active_count as active,
        failed_count as failed, total_count as total
      from pgboss.queue
      where name in (${queueNames})
      order by name
    `);
  return rows.rows;
}

export async function adminJobs(p: Principal) {
  assertAdmin(p);
  try {
    return { available: true, queues: await readPersistedQueues() };
  } catch {
    // The queue catalog may not have been installed or may be unavailable. Do not
    // initialize pg-boss here: this is an observational read and must not create queues.
    return { available: false, queues: [], reason: "The persisted pg-boss queue counters are unavailable." };
  }
}

export async function adminSpending(p: Principal, opts: { days?: number } = {}) {
  assertAdmin(p);
  const days = clamp(opts.days, 30, 365);
  const [accounts, usage] = await Promise.all([readBillingAccounts(p), usageSummary(days)]);
  return {
    accounts: accounts.map(a => ({ name: a.name, organization: a.organization, enabled: a.enabled, snapshot: a.snapshot, lastAttemptAt: a.lastAttemptAt, hasError: !!a.lastError })),
    usage: { days, byTarget: usage.byApp.map(a => ({ name: a.name, messages: num(a.messages), tokenCount: num(a.tokens) })),
      inputTokens: num(usage.totals?.input_tokens), outputTokens: num(usage.totals?.output_tokens),
      searchCostEstimateUsd: num(usage.totals?.search_tool_cost_estimate_micros) / 1_000_000 },
  };
}

export async function adminWorkspacesStatus(p: Principal) {
  assertAdmin(p);
  const settings = await getSetting("sandbox");
  const client = workspaceConfigState(process.env) === "configured" ? sandboxd() : null;
  const [setup, legacy, instances, states] = await Promise.all([
    readWorkspaceSetup(settings.allowRunc),
    listSandboxRows(), listWorkspaceInstances(),
    client ? client.list(15_000).catch(() => null) : Promise.resolve(null),
  ]);
  // Include template instances and unreconciled legacy rows without creating/reconciling anything.
  const byInstanceRef = new Map(instances.map(r => [r.sandboxRef, r]));
  const rows = [
    ...instances.map(r => ({ userId: r.ownerUserId, ref: r.sandboxRef, origin: r.origin, provisionState: r.provisionState, lastUsedAt: r.lastUsedAt, deleteAfter: r.deleteAfter })),
    ...legacy.filter(r => !byInstanceRef.has(r.ref)).map(r => ({ ...r, origin: "legacy_personal" as const, provisionState: null })),
  ];
  const people = rows.length
    ? await db.select({ id: users.id, name: users.name, upn: users.upn, disabled: users.disabled }).from(users).where(inArray(users.id, rows.map(r => r.userId)))
    : [];
  // Refs stay here: they address sandboxd directly.
  const byRef = new Map((states ?? []).map(s => [s.ref, s]));
  const known = new Set(rows.map(r => r.ref));
  return {
    settings: { enabled: settings.enabled, access: settings.access, allowedGroups: settings.allowedGroupIds.length, allowedUpns: settings.allowedUpns.length,
      standardIsolationAllowed: settings.allowRunc, commandTimeoutSec: settings.commandTimeoutSec, deleteAfterDays: settings.deleteAfterDays },
    setup: { ready: setup.ready, checks: setup.checks.map(c => ({ label: c.label, state: c.state })), hasWarnings: setup.hasWarnings },
    listAvailable: states !== null,
    workspaces: rows.map(r => {
      const person = people.find(u => u.id === r.userId), s = byRef.get(r.ref);
      return { user: person?.name ?? "(unknown)", upn: person?.upn ?? null, userDisabled: !!person?.disabled,
        origin: r.origin, provisionState: r.provisionState, state: s?.state ?? (states ? "missing" : "unknown"), runtime: s?.runtime ?? null, activeExecs: s?.activeExecs ?? null, drift: s ? !!s.drift : null,
        lastUsedAt: r.lastUsedAt, deleteAfter: r.deleteAfter };
    }),
    orphans: states ? states.filter(s => !known.has(s.ref)).length : null,
  };
}
