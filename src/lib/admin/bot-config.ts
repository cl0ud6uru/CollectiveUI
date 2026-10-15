import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, type Tx } from "@/db";
import { aiApps, botAccess, botDelegates, botTools, botUserAccess, bots, codexBotConfigs, providerConnections } from "@/db/schema";
import type { Principal } from "@/lib/auth/groups";
import { HttpError } from "@/lib/authz";
import { auditVia } from "@/lib/audit";
import { BUILTIN_TOOLS } from "@/lib/agent/types";
import { availableBuiltinKeys } from "@/lib/bots/available-tools";
import { persistBotToolAssignments, persistBotUpdate, saveBotRelations } from "@/lib/bots/persist";
import { architectModelEligible, ARCHITECT_SETTING } from "@/lib/bots/architect-policy";
import { getSetting } from "@/lib/settings";
import type { AgentCtx } from "@/lib/agent/types";
import { authorizeArchitectCall, lockArchitectActor } from "@/lib/agent/tools/admin-guard";

const toolGroup = z.object({ key: z.string().min(1).max(80), approval: z.enum(["auto", "ask", "smart"]) }).strict();
export const architectBotCreateInput = z.object({
  name: z.string().trim().min(1).max(80), appId: z.string().min(1).max(128),
  description: z.string().max(2000).nullable().optional(), instructions: z.string().max(20000).nullable().optional(),
}).strict();
export const architectBotUpdateInput = z.object({
  botId: z.string().min(1).max(128), expectedRevision: z.number().int().min(1),
  name: z.string().trim().min(1).max(80).optional(), appId: z.string().min(1).max(128).optional(),
  label: z.string().trim().max(40).nullable().optional(), description: z.string().max(2000).nullable().optional(),
  instructions: z.string().max(20000).nullable().optional(), boundaries: z.string().max(5000).nullable().optional(),
}).strict().refine(x => [x.name, x.appId, x.label, x.description, x.instructions, x.boundaries].some(v => v !== undefined), "Choose at least one bot field to update.");
export const architectBotToolsInput = z.object({ botId: z.string().min(1).max(128), expectedRevision: z.number().int().min(1), tools: z.array(toolGroup).max(20) }).strict();
const via = (ctx: AgentCtx) => ({ agent: "architect" as const, botId: ctx.bot!.id });
const checkAbort = (signal?: AbortSignal) => signal?.throwIfAborted();

async function assertModel(tx: Tx, appId: string) {
  const [app] = await tx.select().from(aiApps).where(eq(aiApps.id, appId)).for("share");
  if (!app || !architectModelEligible(app)) throw new HttpError(400, "Choose an enabled, shared, tool-capable model for an ordinary bot.");
  if (app.providerConnectionId) {
    const [connection] = await tx.select({ enabled: providerConnections.enabled }).from(providerConnections).where(eq(providerConnections.id, app.providerConnectionId)).for("share");
    if (!connection?.enabled) throw new HttpError(409, "The selected model's saved provider connection is disabled.");
  }
  return app;
}

async function readBack(tx: Tx, botId: string) {
  const [bot] = await tx.select({ id: bots.id, revision: bots.revision, name: bots.name, label: bots.label,
    description: bots.description, instructions: bots.instructions, boundaries: bots.boundaries,
    appId: bots.appId, visibility: bots.visibility, enabled: bots.enabled,
    executionMode: bots.executionMode, hermesTeam: bots.hermesTeam }).from(bots).where(eq(bots.id, botId));
  const tools = await tx.select({ key: botTools.toolKey, approval: botTools.approval, config: botTools.config }).from(botTools).where(eq(botTools.botId, botId));
  return { bot, tools };
}

const publicBot = (bot: NonNullable<Awaited<ReturnType<typeof readBack>>["bot"]>) => ({
  id: bot.id, revision: bot.revision, name: bot.name, label: bot.label, appId: bot.appId,
  visibility: bot.visibility, enabled: bot.enabled, executionMode: bot.executionMode, hermesTeam: bot.hermesTeam,
});

async function prepareWrite(ctx: AgentCtx, tx: Tx) {
  await lockArchitectActor(ctx, tx);
  const fresh = await authorizeArchitectCall(ctx, tx);
  if (!fresh.isAdmin) throw new HttpError(403, "Admin tools are for administrators only.");
  return fresh;
}

async function assertOrdinaryBot(tx: Tx, botId: string, expectedRevision: number) {
  const [row] = await tx.select().from(bots).where(eq(bots.id, botId)).for("update");
  if (!row) throw new HttpError(404, "Bot not found.");
  if (row.revision !== expectedRevision) throw new HttpError(409, "Bot configuration changed. Read it again and request fresh approval.");
  const [receipt, office, coordinator] = await Promise.all([
    getSetting(ARCHITECT_SETTING, tx), getSetting("officeBot", tx), getSetting("coordinator", tx),
  ]);
  if (row.id === receipt.botId || row.id === office.botId || row.id === coordinator.defaultBotId)
    throw new HttpError(400, "Built-in bots must be managed in Admin → Bots.");
  if (row.hermesTeam || row.executionMode !== "caller" || row.isCoordinator || row.coordinatorEligible)
    throw new HttpError(400, "The Architect can edit ordinary caller bots only. Manage Team, service and coordinator bots in Admin.");
  const [app] = row.appId ? await tx.select().from(aiApps).where(eq(aiApps.id, row.appId)) : [];
  if (!app || !architectModelEligible(app)) throw new HttpError(409, "This bot uses a managed, personal or unavailable model. Manage it in Admin.");
  const [delegation] = await tx.select({ botId: botDelegates.botId }).from(botDelegates).where(eq(botDelegates.botId, botId)).limit(1);
  if (delegation) throw new HttpError(400, "Bots with delegation links must be edited in Admin.");
  const [codex] = await tx.select({ botId: codexBotConfigs.botId }).from(codexBotConfigs).where(eq(codexBotConfigs.botId, botId)).limit(1);
  if (codex) throw new HttpError(400, "Codex bots must be edited in Admin.");
  return { row, app };
}

export async function createArchitectBot(ctx: AgentCtx, _actor: Principal, raw: unknown, signal?: AbortSignal) {
  const input = architectBotCreateInput.parse(raw);
  return db.transaction(async tx => {
    const fresh = await prepareWrite(ctx, tx);
    await assertModel(tx, input.appId);
    checkAbort(signal);
    const [bot] = await tx.insert(bots).values({ ownerId: fresh.user.id, name: input.name, description: input.description ?? null,
      instructions: input.instructions ?? null, appId: input.appId, visibility: "private", executionMode: "caller", enabled: true,
      maxSteps: 10, starters: [] }).returning();
    await saveBotRelations(tx, bot.id, { name: bot.name, appId: bot.appId!, visibility: "private", groupIds: [], userIds: [], maxSteps: 10,
      starters: [], tools: [], delegateIds: [], executionMode: "caller" }, { tools: [], delegates: [], userIds: [], maxSteps: 10 });
    const result = await readBack(tx, bot.id);
    if (!result.bot || result.bot.revision !== 1 || result.bot.name !== input.name || result.bot.appId !== input.appId || result.bot.visibility !== "private" ||
      result.bot.description !== (input.description ?? null) || result.bot.instructions !== (input.instructions ?? null) || result.bot.enabled !== true || result.bot.executionMode !== "caller")
      throw new HttpError(409, "Bot creation could not be verified.");
    checkAbort(signal);
    await auditVia(fresh.user.id, via(ctx), "architect.bot.create", bot.id, { revision: result.bot.revision, appId: input.appId }, tx);
    checkAbort(signal);
    return { status: "verified" as const, bot: publicBot(result.bot), tools: result.tools.map(t => ({ group: t.key, approval: t.approval })) };
  });
}

export async function updateArchitectBot(ctx: AgentCtx, _actor: Principal, raw: unknown, signal?: AbortSignal) {
  const input = architectBotUpdateInput.parse(raw);
  return db.transaction(async tx => {
    const fresh = await prepareWrite(ctx, tx);
    const { row } = await assertOrdinaryBot(tx, input.botId, input.expectedRevision);
    const nextAppId = input.appId ?? row.appId!;
    await assertModel(tx, nextAppId);
    const oldTools = await tx.select().from(botTools).where(eq(botTools.botId, row.id));
    const groups = await tx.select({ groupId: botAccess.groupId }).from(botAccess).where(eq(botAccess.botId, row.id));
    const users = await tx.select({ userId: botUserAccess.userId }).from(botUserAccess).where(eq(botUserAccess.botId, row.id));
    const delegates = await tx.select({ delegateBotId: botDelegates.delegateBotId }).from(botDelegates).where(eq(botDelegates.botId, row.id));
    const tools = oldTools.map(t => ({ key: t.toolKey, approval: t.approval, config: t.config }));
    const next = { name: input.name ?? row.name, avatar: row.avatar, label: input.label === undefined ? row.label : input.label,
      description: input.description === undefined ? row.description : input.description,
      instructions: input.instructions === undefined ? row.instructions : input.instructions,
      boundaries: input.boundaries === undefined ? row.boundaries : input.boundaries,
      appId: nextAppId, codex: undefined, visibility: row.visibility as "private" | "groups" | "org",
      groupIds: groups.map(x => x.groupId), userIds: users.map(x => x.userId), maxSteps: row.maxSteps,
      starters: row.starters, tools, delegateIds: delegates.map(x => x.delegateBotId), executionMode: "caller" as const,
      coordinatorEligible: false, isCoordinator: false };
    const validated = { tools, delegates: next.delegateIds, userIds: next.userIds, maxSteps: row.maxSteps };
    checkAbort(signal);
    const saved = await persistBotUpdate(tx, row, next, validated, input.expectedRevision);
    const result = await readBack(tx, row.id);
    if (!result.bot || result.bot.revision !== saved.revision || result.bot.name !== next.name || result.bot.appId !== next.appId ||
      result.bot.label !== next.label || result.bot.description !== next.description || result.bot.instructions !== next.instructions || result.bot.boundaries !== next.boundaries)
      throw new HttpError(409, "Bot update could not be verified.");
    checkAbort(signal);
    await auditVia(fresh.user.id, via(ctx), "architect.bot.update", row.id, { revision: saved.revision, fields: Object.keys(input).filter(k => !["botId", "expectedRevision"].includes(k)) }, tx);
    checkAbort(signal);
    return { status: "verified" as const, bot: publicBot(result.bot), tools: result.tools.map(t => ({ group: t.key, approval: t.approval })) };
  });
}

export async function assignArchitectBotTools(ctx: AgentCtx, _actor: Principal, raw: unknown, signal?: AbortSignal) {
  const input = architectBotToolsInput.parse(raw);
  const known = new Set(BUILTIN_TOOLS.map(t => t.key));
  const keys = input.tools.map(t => t.key);
  if (new Set(keys).size !== keys.length || keys.some(k => !known.has(k))) throw new HttpError(400, "Choose each built-in tool group at most once.");
  return db.transaction(async tx => {
    const fresh = await prepareWrite(ctx, tx);
    const { row } = await assertOrdinaryBot(tx, input.botId, input.expectedRevision);
    const current = await availableBuiltinKeys(fresh, tx);
    if (input.tools.some(t => !current.has(t.key))) throw new HttpError(409, "A selected tool group is disabled or unavailable to this administrator.");
    checkAbort(signal);
    const saved = await persistBotToolAssignments(tx, row, input.tools, input.expectedRevision);
    if (saved.bot.revision !== input.expectedRevision + 1) throw new HttpError(409, "Bot tool assignments could not be verified.");
    checkAbort(signal);
    await auditVia(fresh.user.id, via(ctx), "architect.bot.tools.update", row.id,
      { revision: saved.bot.revision, groups: saved.tools.map(t => t.key).sort() }, tx);
    checkAbort(signal);
    return { status: "verified" as const, bot: { id: row.id, name: row.name, revision: saved.bot.revision },
      tools: saved.tools.map(t => ({ group: t.key, approval: t.approval })) };
  });
}
