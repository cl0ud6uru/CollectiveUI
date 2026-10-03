import { and, eq } from "drizzle-orm";
import { db, type DbOrTx } from "@/db";
import { aiApps, botDelegates, bots, conversations, delegatedTasks, type Bot } from "@/db/schema";
import { loadPrincipal, type Principal } from "@/lib/auth/groups";
import { getAccessibleModel, getUsableBot, HttpError, listAccessibleBots } from "@/lib/authz";
import { isManagedHermes } from "@/lib/hermes-provisioning/config";
import { getSetting } from "@/lib/settings";
import type { AgentCtx } from "@/lib/agent/types";
import { resolveTaskSource, type DelegationEdge, type DelegationSource } from "@/lib/delegation/source";
import { MAX_DELEGATION_DEPTH, MAX_ROOT_TASKS } from "@/lib/delegation/policy";

export { MAX_DELEGATION_DEPTH };
export const MAX_DELEGATION_CALLS = MAX_ROOT_TASKS;
export type DelegationMode = "manual" | "coordinator";
export type { DelegationEdge };
export { delegatedAuthorityBinding } from "@/lib/delegation/authority";
const unavailable = () => new HttpError(403, "This delegate is no longer available to you.");
type Origin = DelegationSource | { kind: "direct"; ctx: AgentCtx };

async function currentPrincipal(ctx: AgentCtx, q: DbOrTx) {
  const p = await loadPrincipal(ctx.principal.user.id, q);
  if (!p || p.user.sessionVersion !== ctx.principal.user.sessionVersion) throw unavailable();
  return p;
}
async function allowedBot(p: Principal, id: string, nativeOnly: boolean, q: DbOrTx) {
  const bot = await getUsableBot(p, id, q);
  if (bot.executionMode !== "caller" || !bot.appId) throw unavailable();
  const [app] = await q.select().from(aiApps).where(eq(aiApps.id, bot.appId));
  if (!app?.enabled || isManagedHermes(app) || (nativeOnly && app.provider === "hermes")) throw unavailable();
  if (nativeOnly) await getAccessibleModel(p, app.id, q);
  return { bot, app };
}
/** Same current edge policy for discovery, transactional admission and every persisted dispatch. */
async function authorizeEdge(p: Principal, edge: DelegationEdge, origin: Origin, nativeOnly: boolean, q: DbOrTx) {
  if (edge.mode && edge.mode !== "manual" && edge.mode !== "coordinator") throw unavailable();
  const source = await allowedBot(p, edge.from, nativeOnly, q);
  const target = await allowedBot(p, edge.to, nativeOnly, q);
  if (edge.mode === "coordinator") {
    const config = await getSetting("coordinator", q);
    if (!config.enabled || config.defaultBotId !== edge.from || !source.app.supportsTools || !target.bot.coordinatorEligible) throw unavailable();
    let conversationId: string;
    if (origin.kind === "persisted-source") {
      // Resolved from the saved root; never substituted for the child's own context.
      if (origin.userId !== p.user.id || origin.sessionVersion !== p.user.sessionVersion || origin.botId !== edge.from ||
          !origin.run || origin.run.background || origin.run.routineRunId || origin.run.executionMode !== "worker") throw unavailable();
      conversationId = origin.conversationId;
    } else {
      if (origin.ctx.background || origin.ctx.inGroup || origin.ctx.depth !== 0 || origin.ctx.bot?.id !== edge.from) throw unavailable();
      conversationId = origin.ctx.conversationId;
    }
    // Admin oversight is not an automatic audience grant.
    const visible = new Set((await listAccessibleBots(p, q)).map(b => b.id));
    if (!visible.has(edge.from) || !visible.has(edge.to)) throw unavailable();
    const [conv] = await q.select().from(conversations).where(and(eq(conversations.id, conversationId), eq(conversations.userId, p.user.id)));
    if (!conv || conv.botId !== edge.from || conv.source !== "chat" || conv.isGroup || conv.archived) throw unavailable();
  } else {
    const [link] = await q.select().from(botDelegates).where(and(eq(botDelegates.botId, edge.from), eq(botDelegates.delegateBotId, edge.to)));
    if (!link) throw unavailable();
  }
  return target;
}
/** Called only with provenance resolved and bound by the durable task store. */
export async function assertPersistedDelegationEdge(p: Principal, edge: DelegationEdge, source: DelegationSource, nativeOnly: boolean, q: DbOrTx = db) {
  await authorizeEdge(p, edge, source, nativeOnly || edge.mode === "coordinator", q);
}
async function taskOf(ctx: AgentCtx, q: DbOrTx) {
  const [task] = ctx.taskId ? await q.select().from(delegatedTasks).where(and(eq(delegatedTasks.id, ctx.taskId), eq(delegatedTasks.userId, ctx.principal.user.id))) : [];
  if (!task || task.sessionVersion !== ctx.principal.user.sessionVersion || task.childConversationId !== ctx.conversationId ||
      task.childRunId !== ctx.usage?.runId || task.receiverBotId !== ctx.bot?.id || task.depth !== ctx.depth ||
      JSON.stringify(task.ancestry) !== JSON.stringify(ctx.delegationPath)) throw unavailable();
  return task;
}
/** MCP and discovery use durable provenance, never a forged foreground child context. */
export async function assertDelegationPath(ctx: AgentCtx, q: DbOrTx = db) {
  const p = await currentPrincipal(ctx, q);
  if (ctx.taskId) {
    const task = await taskOf(ctx, q);
    const { assertTaskExecution } = await import("@/lib/delegation/store");
    return assertTaskExecution(task, q);
  }
  if (ctx.depth !== 0 || ctx.delegationPath?.length) throw unavailable();
  return p;
}
export async function authorizeDelegation(ctx: AgentCtx, targetId: string, mode: DelegationMode, q: DbOrTx = db) {
  const p = await assertDelegationPath(ctx, q);
  if (!ctx.bot || ctx.depth >= MAX_DELEGATION_DEPTH || targetId === ctx.bot.id ||
      (ctx.delegationPath ?? []).some(e => e.from === targetId || e.to === targetId) || (mode === "coordinator" && ctx.depth !== 0)) throw unavailable();
  const origin: Origin = ctx.taskId ? await resolveTaskSource(await taskOf(ctx, q), q) : { kind: "direct", ctx };
  const target = await authorizeEdge(p, { from: ctx.bot.id, to: targetId, mode }, origin,
    mode === "coordinator" || (ctx.delegationPath ?? []).some(e => e.mode === "coordinator"), q);
  return { principal: p, ...target };
}
export async function discoverDelegates(ctx: AgentCtx, q: DbOrTx = db): Promise<{ bot: Bot; mode: DelegationMode }[]> {
  if (!ctx.bot || ctx.depth >= MAX_DELEGATION_DEPTH) return [];
  const links = await q.select({ bot: bots }).from(botDelegates).innerJoin(bots, eq(bots.id, botDelegates.delegateBotId)).where(eq(botDelegates.botId, ctx.bot.id));
  const choices = new Map(links.map(({ bot }) => [bot.id, { bot, mode: "manual" as DelegationMode }]));
  const config = await getSetting("coordinator", q);
  const automatic = config.enabled && config.defaultBotId === ctx.bot.id && ctx.depth === 0 && !ctx.background && !ctx.inGroup;
  if (!links.length && !automatic) return [];
  const p = await currentPrincipal(ctx, q);
  if (automatic) for (const bot of await listAccessibleBots(p, q)) {
    if (bot.coordinatorEligible && !choices.has(bot.id)) choices.set(bot.id, { bot, mode: "coordinator" });
  }
  const offered: { bot: Bot; mode: DelegationMode }[] = [];
  for (const choice of choices.values()) {
    try { offered.push({ bot: (await authorizeDelegation(ctx, choice.bot.id, choice.mode, q)).bot, mode: choice.mode }); }
    catch (err) { if (!(err instanceof HttpError)) throw err; }
  }
  return offered;
}
