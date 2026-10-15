import { auditActorLabel } from "@/lib/audit-view";
import "server-only";
import { and, count, desc, eq, gte, ilike, lt, or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { auditLog, bots, conversations, routineRuns, routines, toolCalls, users } from "@/db/schema";
import type { Principal } from "@/lib/auth/groups";
import { HttpError } from "@/lib/authz";
import { redactSecrets } from "@/lib/redact";
import { ADMIN_PAGE_SIZE, containsPattern, pageWindow, queryText, requestedPage, type AdminSearchParams } from "./listing";

export const ACTIVITY_STATUSES: Record<"tools" | "runs" | "audit", string[]> = {
  tools: ["pending_approval", "approved", "denied", "done", "error"],
  runs: ["queued", "running", "awaiting_approval", "succeeded", "failed"],
  audit: [],
};
export type ActivityTab = keyof typeof ACTIVITY_STATUSES;

function dateBoundary(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}

export function readActivityFilters(params: AdminSearchParams) {
  const tab: ActivityTab = params.tab === "runs" ? "runs" : params.tab === "audit" ? "audit" : "tools";
  const values = {
    tab, from: queryText(params.from), to: queryText(params.to), user: queryText(params.user),
    status: tab === "audit" ? "" : queryText(params.status),
    tool: tab === "tools" ? queryText(params.tool) : "",
    action: tab === "audit" ? queryText(params.action) : "",
  };
  const from = dateBoundary(values.from);
  const to = dateBoundary(values.to);
  const errors: string[] = [];
  if (values.from && !from) errors.push("Enter a valid start date.");
  if (values.to && !to) errors.push("Enter a valid end date.");
  if (from && to && from > to) errors.push("The end date must be on or after the start date.");
  if (values.status && !ACTIVITY_STATUSES[tab].includes(values.status)) errors.push("Choose a valid status.");
  if ([values.user, values.tool, values.action].some(value => value.length > 200)) errors.push("Filters must be 200 characters or fewer.");
  return { values, from, until: to ? new Date(to.getTime() + 86_400_000) : null, errors, requested: requestedPage(params.page) };
}

const secretKey = /^(?:authorization|proxyauthorization|cookie|setcookie|password|passwd|secret|clientsecret|apikey|apikeyenc|accesskey|secretaccesskey|accesstoken|refreshtoken|idtoken|token|credentials|credentialenc|privatekey|identitysecretenc)$/i;

/** Defense in depth for stored diagnostics. Existing redaction markers are retained. */
export function formatAdminDiagnostic(value: unknown): string {
  function clean(item: unknown): unknown {
    if (typeof item === "string") return redactSecrets(item);
    if (Array.isArray(item)) return item.map(clean);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, entry]) => [
      key, secretKey.test(key.replace(/[-_\s]/g, "")) ? "[redacted]" : clean(entry),
    ]));
    return item;
  }
  const cleaned = clean(value);
  return typeof cleaned === "string" ? cleaned : JSON.stringify(cleaned ?? null, null, 2);
}

type ActivityRow = {
  id: string; createdAt: Date; user: string | null; upn: string | null;
  subject: string; bot: string | null; status: string | null; target: string | null;
  details: string; conversationId: string | null;
};

export async function listAdminActivity(principal: Principal, filters: ReturnType<typeof readActivityFilters>) {
  if (!principal.isAdmin) throw new HttpError(403, "Admin only");
  const { values, from, until, errors, requested } = filters;
  const privateScope = sql`(not exists (select 1 from ai_apps personal where personal.id = ${bots.appId} and personal.provider_config->'docker' is not null) or ${bots.ownerId} = ${principal.user.id})`;
  const common = (createdAt: AnyPgColumn): SQL[] => {
    const clauses: SQL[] = [];
    // Invalid filters must not silently broaden the query to all activity.
    if (errors.length) clauses.push(sql`false`);
    if (from) clauses.push(gte(createdAt, from));
    if (until) clauses.push(lt(createdAt, until));
    if (values.user) clauses.push(or(ilike(users.name, containsPattern(values.user)), ilike(users.upn, containsPattern(values.user)))!);
    return clauses;
  };

  if (values.tab === "audit") {
    const clauses = common(auditLog.createdAt);
    if (values.action) clauses.push(ilike(auditLog.action, containsPattern(values.action)));
    const where = and(...clauses);
    const [{ total }] = await db.select({ total: count() }).from(auditLog).leftJoin(users, eq(users.id, auditLog.actorId)).where(where);
    const window = pageWindow(total, requested);
    const rows = await db.select({ entry: auditLog, user: users.name, upn: users.upn }).from(auditLog)
      .leftJoin(users, eq(users.id, auditLog.actorId)).where(where)
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id)).limit(ADMIN_PAGE_SIZE).offset(window.offset);
    return { window, rows: rows.map(({ entry, user, upn }): ActivityRow => ({
      id: entry.id, createdAt: entry.createdAt, user: auditActorLabel(user, entry.details), upn, subject: entry.action, bot: null,
      status: null, target: entry.target, conversationId: null,
      details: formatAdminDiagnostic({ id: entry.id, actorId: entry.actorId, action: entry.action, target: entry.target, details: entry.details }),
    })) };
  }

  if (values.tab === "runs") {
    const clauses = [...common(routineRuns.createdAt), privateScope];
    if (values.status) clauses.push(eq(routineRuns.status, values.status as typeof routineRuns.$inferSelect.status));
    const where = and(...clauses);
    const [{ total }] = await db.select({ total: count() }).from(routineRuns)
      .innerJoin(routines, eq(routines.id, routineRuns.routineId)).innerJoin(bots, eq(bots.id, routines.botId))
      .innerJoin(users, eq(users.id, routines.ownerId)).where(where);
    const window = pageWindow(total, requested);
    const rows = await db.select({ run: routineRuns, routine: routines.name, bot: bots.name, user: users.name, upn: users.upn, conversationOwner: conversations.userId }).from(routineRuns)
      .innerJoin(routines, eq(routines.id, routineRuns.routineId)).innerJoin(bots, eq(bots.id, routines.botId))
      .innerJoin(users, eq(users.id, routines.ownerId)).leftJoin(conversations, eq(conversations.id, routineRuns.conversationId))
      .where(where).orderBy(desc(routineRuns.createdAt), desc(routineRuns.id)).limit(ADMIN_PAGE_SIZE).offset(window.offset);
    return { window, rows: rows.map(({ run, routine, bot, user, upn, conversationOwner }): ActivityRow => ({
      id: run.id, createdAt: run.createdAt, user, upn, subject: routine, bot, status: run.status, target: run.trigger,
      conversationId: conversationOwner === principal.user.id ? run.conversationId : null,
      details: formatAdminDiagnostic({ id: run.id, routineId: run.routineId, trigger: run.trigger, error: run.error, payload: run.payload, startedAt: run.startedAt?.toISOString() ?? null, finishedAt: run.finishedAt?.toISOString() ?? null }),
    })) };
  }

  const clauses = [...common(toolCalls.createdAt), privateScope];
  if (values.status) clauses.push(eq(toolCalls.status, values.status as typeof toolCalls.$inferSelect.status));
  if (values.tool) clauses.push(eq(toolCalls.toolName, values.tool));
  const where = and(...clauses);
  const [{ total }] = await db.select({ total: count() }).from(toolCalls)
    .leftJoin(users, eq(users.id, toolCalls.userId)).leftJoin(bots, eq(bots.id, toolCalls.botId)).where(where);
  const window = pageWindow(total, requested);
  const rows = await db.select({ call: toolCalls, user: users.name, upn: users.upn, bot: bots.name, conversationOwner: conversations.userId }).from(toolCalls)
    .leftJoin(users, eq(users.id, toolCalls.userId)).leftJoin(bots, eq(bots.id, toolCalls.botId))
    .leftJoin(conversations, eq(conversations.id, toolCalls.conversationId)).where(where)
    .orderBy(desc(toolCalls.createdAt), desc(toolCalls.id)).limit(ADMIN_PAGE_SIZE).offset(window.offset);
  return { window, rows: rows.map(({ call, user, upn, bot, conversationOwner }): ActivityRow => ({
    id: call.id, createdAt: call.createdAt, user, upn, subject: call.toolName, bot, status: call.status, target: null,
    conversationId: conversationOwner === principal.user.id ? call.conversationId : null,
    details: formatAdminDiagnostic({ id: call.id, runId: call.runId, providerCallId: call.providerCallId, input: call.input, output: call.output, durationMs: call.durationMs, decidedBy: call.decidedBy }),
  })) };
}
