"use server";

import { isDockerHermes } from "@/lib/docker-hermes/policy";

import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { generateText, Output } from "ai";
import { z } from "zod";
import { db, type Tx } from "@/db";
import {
  aiApps,
  attachments,
  botAccess,
  botDelegates,
  bots,
  botTools,
  botMcpGrants,
  mcpServers,
  knowledgeChunks,
  routineRuns,
  botTemplates,
  conversationBots,
  conversations,
  routines,
  skills,
  type BotTemplateSnapshot,
} from "@/db/schema";
import { getAccessibleApp, getAccessibleBot, getEditableBot, HttpError, listAccessibleApps, listAccessibleMcpServers } from "@/lib/authz";
import { chunkText } from "@/lib/files/extract";
import { newToken } from "@/lib/ids";
import { enqueue, QUEUES } from "@/lib/jobs";
import { embedTexts, resolveModel, utilityApp } from "@/lib/llm";
import { newWebhookSecret, nextCronRun, openWebhookSecret } from "@/lib/routines";
import { requirePrincipal } from "@/lib/session";
import { getSetting } from "@/lib/settings";
import { mcpInputValidator } from "@/lib/mcp/input";
import { canEditBot, lockEditableBot, serviceConfigHash } from "@/lib/bots/service";
import { ServiceGrantInputSchema, validateConstraintSchema } from "@/lib/bots/service-policy";
import { offeredTools } from "@/lib/mcp/servers";
import { toolHash } from "@/lib/mcp/snapshot";
import { loadPrincipal } from "@/lib/auth/groups";
import { slugify } from "@/lib/utils";
import { nativeSearchAvailability } from "@/lib/agent/native-search";
import { BUILTIN_TOOLS } from "@/lib/agent/types";
import { availableBuiltinKeys } from "@/lib/bots/available-tools";
import { botDraftInstructions, botDraftSchema, describeDraftFailure, DRAFT_DESCRIPTION_MAX_LENGTH, finalizeDraft, INCOMPLETE_DRAFT, NO_UTILITY_MODEL, type BotDraftResult } from "@/lib/bots/draft";
import { ApprovalModeSchema, BotToolConfigSchema, normalizeToolConfig } from "@/lib/bots/tool-config";
import { randomBlob } from "@/components/bots/bot-avatar";
import { loadBotActivity, loadWorkspacePreview } from "@/lib/chat/activity";
import { botDefaultSchema } from "@/lib/pets/shared";
import { initializeBotPet } from "@/lib/pets/store";
import { addSelectedDelegators } from "@/lib/coordinator/roles";

import { assertApprovedBot, guardManagedBotMutation } from "@/lib/hermes-provisioning/bot-policy";
import { isManagedHermes } from "@/lib/hermes-provisioning/config";
import { isLocalHermes } from "@/lib/local-hermes/config";
import { saveBotNavigation } from "@/lib/bots/navigation-store";

async function localEngine(appId: string | null) {
  if (!appId) return false;
  const [app] = await db.select().from(aiApps).where(eq(aiApps.id, appId));
  return !!app && isLocalHermes(app);
}
async function requirePortableEngine(appId: string | null) {
  if (await localEngine(appId)) throw new HttpError(400, "Local Hermes supports its owner's direct chats only. Groups, routines and template sharing are unavailable in this pilot.");
}

const BotInput = z.object({
  name: z.string().trim().min(1).max(100),
  avatar: z.string().max(40).optional().nullable(),
  label: z.string().trim().max(40).optional().nullable(),
  description: z.string().max(2000).optional().nullable(),
  instructions: z.string().max(24000).optional().nullable(),
  boundaries: z.string().max(5000).optional().nullable(),
  appId: z.string().min(1),
  visibility: z.enum(["private", "groups", "org"]),
  groupIds: z.array(z.string()).max(100).default([]),
  maxSteps: z.number().int().min(1).max(50).default(10),
  starters: z.array(z.string().max(300)).max(6).default([]),
  tools: z
    .array(z.object({ key: z.string().max(80), approval: ApprovalModeSchema, config: BotToolConfigSchema.nullable().optional() }))
    .max(50)
    .default([]),
  delegateIds: z.array(z.string()).max(20).default([]),
  executionMode: z.enum(["caller", "service"]).optional(),
  initialPet: botDefaultSchema.optional(),
  coordinatorEligible: z.boolean().optional(),
  isCoordinator: z.boolean().optional(),
  // Incoming team links are selected only during creation, never inferred on save.
  delegatorIds: z.array(z.string().min(1).max(128)).max(100).optional(),
});
export type BotInput = z.infer<typeof BotInput>;

async function assertCanCreate() {
  const p = await requirePrincipal();
  const t = await getSetting("tools");
  if (t.botCreation === "admins" && !p.isAdmin) throw new HttpError(403, "Only admins can create bots");
  if (t.botCreation === "groups" && !p.canCreateBots) throw new HttpError(403, "You are not allowed to create bots");
  return p;
}

async function validateBotInput(p: Awaited<ReturnType<typeof requirePrincipal>>, input: BotInput, botId?: string) {
  if (input.executionMode === "service" && !p.isAdmin) throw new HttpError(403, "Only admins can configure service bots.");
  const app = await getAccessibleApp(p, input.appId);
  assertApprovedBot(app, botId);
  // Existing managed definitions may use the original admin form's 100/24,000 limits.
  if (!isManagedHermes(app) && (input.name.length > 80 || (input.instructions?.length ?? 0) > 20000))
    throw new HttpError(400, "Use at most 80 characters for the name and 20,000 for instructions.");
  const toolSettings = await getSetting("tools");
  const search = input.tools.find(t => t.key === "openai_web_search");
  if (search) {
    const reason = await nativeSearchAvailability(app, toolSettings, search.approval);
    if (reason) throw new HttpError(400, reason);
  }
  const builtin = await availableBuiltinKeys(p);
  const accessibleServers = await listAccessibleMcpServers(p);
  const mcpIds = new Set(accessibleServers.map((s) => `mcp:${s.id}`));
  const tools = input.tools
    .filter((t) => (builtin.has(t.key) || mcpIds.has(t.key)) && !toolSettings.disabledTools.includes(t.key) &&
      !(t.key.startsWith("mcp:") && toolSettings.disabledTools.includes("mcp")))
    // Per-tool choices only apply to MCP servers; an empty choice is the same as none.
    .map((t) => ({ ...t, config: t.key.startsWith("mcp:") ? normalizeToolConfig(t.config) : null }));
  if (input.executionMode === "service") {
    if (tools.length !== input.tools.length) throw new HttpError(400, "A selected connector is unavailable. Review the tool selection before saving.");
    for (const tool of tools) {
      const server = accessibleServers.find(s => tool.key === `mcp:${s.id}`);
      if (server) tool.config = { ...tool.config, tools: tool.config?.tools ?? offeredTools(server).map(t => t.name) };
    }
  }
  if (tools.length && !app.supportsTools) throw new HttpError(400, `${app.name} doesn't support tools. Pick another model or remove tools.`);
  if (input.executionMode === "service" && (app.provider === "hermes" || app.credentialMode !== "org" ||
      !app.supportsTools || input.tools.some((t) => !t.key.startsWith("mcp:")) || input.delegateIds.length))
    throw new HttpError(400, "Service bots require a native company model and only MCP tools, without delegation.");
  if (input.coordinatorEligible && (input.executionMode === "service" || app.provider === "hermes"))
    throw new HttpError(400, "Only native caller bots can opt into coordinator delegation.");
  if ((input.isCoordinator || input.delegatorIds?.length) && (input.executionMode === "service" || app.provider === "hermes"))
    throw new HttpError(400, "Coordinator roles and teams require native caller bots.");
  if (input.isCoordinator && !app.supportsTools)
    throw new HttpError(400, "Coordinators require a model with tool support.");
  const delegates: string[] = [];
  for (const id of input.delegateIds) {
    if (id === botId) continue;
    const delegate = await getAccessibleBot(p, id);
    await requirePortableEngine(delegate.appId);
    if (delegate.executionMode === "service") throw new HttpError(400, "Service bots cannot be delegates. Open a direct chat instead.");
    delegates.push(id);
  }
  if (input.visibility === "groups" && !input.groupIds.length) throw new HttpError(400, "Pick at least one group");
  return { tools, delegates, maxSteps: Math.min(input.maxSteps, toolSettings.maxStepsCap) };
}

export async function createBot(raw: BotInput) {
  const p = await assertCanCreate();
  const input = BotInput.parse(raw);
  const v = await validateBotInput(p, input);
  const bot = await db.transaction(async (tx) => {
    const fresh = await loadPrincipal(p.user.id, tx);
    if (!fresh || fresh.user.sessionVersion !== p.user.sessionVersion) throw new HttpError(403, "Your access changed. Sign in again.");
    if (input.executionMode === "service" && !fresh.isAdmin)
      throw new HttpError(403, "Only current admins can create service bots.");
    const policy = await getSetting("tools", tx);
    if ((policy.botCreation === "admins" && !fresh.isAdmin) || (policy.botCreation === "groups" && !fresh.canCreateBots))
      throw new HttpError(403, "You are no longer allowed to create bots.");
    const [bot] = await tx
      .insert(bots)
      .values({
        ownerId: p.user.id,
        executionMode: input.executionMode ?? "caller",
        coordinatorEligible: input.coordinatorEligible ?? false,
        isCoordinator: input.isCoordinator ?? false,
        name: input.name,
        avatar: input.avatar || randomBlob(),
        label: input.label || null,
        description: input.description,
        instructions: input.instructions,
        boundaries: input.boundaries,
        appId: input.appId,
        visibility: input.visibility,
        maxSteps: v.maxSteps,
        starters: input.starters.filter(Boolean),
      })
      .returning();
    await saveRelations(tx, bot.id, input, v);
    await addSelectedDelegators(tx, fresh, bot, input.delegatorIds ?? []);
    if (input.initialPet) await initializeBotPet(tx, fresh, bot, input.initialPet);
    return bot;
  });
  revalidatePath("/", "layout");
  return { id: bot.id };
}

async function saveRelations(tx: Tx, botId: string, input: BotInput, v: { tools: BotInput["tools"]; delegates: string[] }) {
  await tx.delete(botTools).where(eq(botTools.botId, botId));
  if (v.tools.length)
    await tx.insert(botTools).values(v.tools.map((t) => ({ botId, toolKey: t.key, approval: t.approval, config: t.config ?? null })));
  await tx.delete(botDelegates).where(eq(botDelegates.botId, botId));
  if (v.delegates.length) await tx.insert(botDelegates).values(v.delegates.map((d) => ({ botId, delegateBotId: d })));
  await tx.delete(botAccess).where(eq(botAccess.botId, botId));
  if (input.visibility === "groups" && input.groupIds.length)
    await tx.insert(botAccess).values(input.groupIds.map((g) => ({ botId, groupId: g })));
}

export async function updateBot(botId: string, raw: BotInput) {
  const p = await requirePrincipal();
  await getEditableBot(p, botId);
  const input = BotInput.parse(raw);
  if (input.initialPet) throw new HttpError(400, "Use the separate Pet avatar controls to change an existing bot's pet.");
  if (input.delegatorIds !== undefined) throw new HttpError(400, "Edit each coordinator's Team to change existing delegation links.");
  const v = await validateBotInput(p, input, botId);
  await db.transaction(async (tx) => {
    const current = await lockEditableBot(p, botId, tx);
    if (input.executionMode === "service" && !(await loadPrincipal(p.user.id))?.isAdmin)
      throw new HttpError(403, "Only current admins can configure service bots.");
    await guardManagedBotMutation(tx, p, botId, input);
    if ((input.coordinatorEligible ?? current.coordinatorEligible) && (input.executionMode ?? current.executionMode) === "service")
      throw new HttpError(400, "Service bots cannot opt into coordinator delegation.");
    if (input.isCoordinator ?? current.isCoordinator) {
      const [app] = await tx.select().from(aiApps).where(eq(aiApps.id, input.appId)).for("share");
      if ((input.executionMode ?? current.executionMode) !== "caller" || !app?.enabled || app.provider === "hermes" || !app.supportsTools)
        throw new HttpError(400, "Coordinators require a native caller bot with a tool-capable model.");
    }
    const changed = await tx
      .update(bots)
      .set({
        name: input.name,
        avatar: input.avatar || randomBlob(),
        label: input.label || null,
        description: input.description,
        instructions: input.instructions,
        boundaries: input.boundaries,
        appId: input.appId,
        visibility: input.visibility,
        maxSteps: v.maxSteps,
        starters: input.starters.filter(Boolean),
        executionMode: input.executionMode ?? current.executionMode,
        coordinatorEligible: input.coordinatorEligible ?? current.coordinatorEligible,
        isCoordinator: input.isCoordinator ?? current.isCoordinator,
        revision: current.revision + 1,
        publishedRevision: null,
        publishedConfigHash: null,
        updatedAt: new Date(),
      })
      .where(and(eq(bots.id, botId), p.isAdmin ? undefined : eq(bots.ownerId, p.user.id)))
      .returning({ id: bots.id });
    if (!changed.length) throw new HttpError(404, "Bot not found or no longer editable");
    await saveRelations(tx, botId, input, v);
    await tx.update(botMcpGrants).set({ revokedAt: new Date() }).where(and(eq(botMcpGrants.botId, botId), isNull(botMcpGrants.revokedAt)));
  });

  revalidatePath("/", "layout");
  return { id: botId };
}

export async function deleteBot(botId: string) {
  const p = await requirePrincipal();
  await getEditableBot(p, botId);
  await db.transaction(async (tx) => {
    await lockEditableBot(p, botId, tx);
    await guardManagedBotMutation(tx, p, botId, null);
    await tx.delete(bots).where(eq(bots.id, botId));
  });
  revalidatePath("/", "layout");
}

/** Explicit publication: no grant can be supplied by a normal save, copy, template or chat request. */
export async function publishServiceBot(botId: string, revision: number, rawGrants: unknown) {
  const session = await requirePrincipal();
  const p = await loadPrincipal(session.user.id);
  if (!p?.isAdmin || p.user.sessionVersion !== session.user.sessionVersion) throw new HttpError(403, "Admin only");
  const input = z.array(ServiceGrantInputSchema).min(1).max(100).parse(rawGrants);
  const result = await db.transaction(async (tx) => {
    const bot = await lockEditableBot(p, botId, tx);
    if (!(await loadPrincipal(p.user.id))?.isAdmin) throw new HttpError(403, "Admin only");
    if (bot.executionMode !== "service" || bot.revision !== revision) throw new HttpError(409, "Save and reload the current service bot before publishing.");
    await serviceConfigHash(bot, tx); // rejects unsupported model, builtins and delegates
    const settings = await getSetting("tools");
    const servers = await tx.select().from(mcpServers).where(inArray(mcpServers.id, [...new Set(input.map((g) => g.serverId))])).for("share");
    const configured = await tx.select().from(botTools).where(eq(botTools.botId, botId));
    const selectedKeys = configured.flatMap(t => (t.config?.tools ?? []).map(name => `${t.toolKey.slice(4)}:${name}`));
    if (selectedKeys.length !== input.length || selectedKeys.some(key => !input.some(g => key === `${g.serverId}:${g.toolName}`)))
      throw new HttpError(409, "The saved selection includes unavailable or unreviewed tools. Review and save the exact selection before publishing.");
    const unique = new Set<string>();
    for (const grant of input) {
      const key = `${grant.serverId}:${grant.toolName}`;
      if (unique.has(key)) throw new HttpError(400, "A tool can only be granted once.");
      unique.add(key);
      const server = servers.find((s) => s.id === grant.serverId);
      const selection = configured.find((t) => t.toolKey === `mcp:${grant.serverId}`);
      if (!server || !selection || (selection.config?.tools && !selection.config.tools.includes(grant.toolName)) ||
          settings.disabledTools.includes("mcp") || settings.disabledTools.includes(selection.toolKey))
        throw new HttpError(400, "Select and save each connector/tool before publishing.");
      if (!["enabled", "needs_review"].includes(server.status) || !server.toolsSnapshot || server.policyRevision !== grant.serverRevision ||
          server.trust !== "trusted" || !server.identityHeader || !server.identitySecretEnc)
        throw new HttpError(400, "Service grants require a tested, enabled, trusted connector with signed caller identity. Reload after connector changes.");
      const def = offeredTools(server).find((t) => t.name === grant.toolName);
      if (!def || toolHash(def) !== grant.toolHash) throw new HttpError(409, "The tool definition changed. Reload and review it.");
      mcpInputValidator({ ...def.inputSchema, additionalProperties: false }, true);
      validateConstraintSchema(def, grant.constraints);
    }
    const next = { ...bot, revision: bot.revision + 1 };
    await tx.update(botMcpGrants).set({ revokedAt: new Date() }).where(and(eq(botMcpGrants.botId, botId), isNull(botMcpGrants.revokedAt)));
    await tx.delete(botTools).where(eq(botTools.botId, botId));
    for (const server of servers) {
      const tools = input.filter((g) => g.serverId === server.id).map((g) => g.toolName);
      await tx.insert(botTools).values({ botId, toolKey: `mcp:${server.id}`, approval: "ask", config: { tools } });
    }
    await tx.insert(botMcpGrants).values(input.map((g) => ({ ...g, botId, botRevision: next.revision, grantedBy: p.user.id })));
    const publishedConfigHash = await serviceConfigHash(next, tx);
    await tx.update(bots).set({ revision: next.revision, publishedRevision: next.revision, publishedConfigHash, updatedAt: new Date() }).where(eq(bots.id, botId));
    // Transactional audit: publication must not succeed without its grant decision record.
    await tx.insert((await import("@/db/schema")).auditLog).values({ actorId: p.user.id, action: "bot.service.publish", target: botId,
      details: { revision: next.revision, tools: input.map((g) => ({ server: g.serverId, tool: g.toolName, hash: g.toolHash, effect: g.effect, approval: g.requireApproval })) } });
    return { revision: next.revision };
  });
  revalidatePath("/", "layout");
  revalidatePath("/admin/mcp");
  return result;
}

export async function revokeServiceBotGrant(grantId: string) {
  const p = await requirePrincipal();
  const fresh = await loadPrincipal(p.user.id);
  if (!fresh?.isAdmin || fresh.user.sessionVersion !== p.user.sessionVersion) throw new HttpError(403, "Admin only");
  await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(botMcpGrants).where(eq(botMcpGrants.id, grantId));
    if (!existing) return;
    await lockEditableBot(p, existing.botId, tx);
    if (!(await loadPrincipal(p.user.id))?.isAdmin) throw new HttpError(403, "Admin only");
    const [grant] = await tx.update(botMcpGrants).set({ revokedAt: new Date() }).where(eq(botMcpGrants.id, grantId)).returning();
    await tx.insert((await import("@/db/schema")).auditLog).values({ actorId: p.user.id, action: "bot.service.revoke", target: grant.botId,
      details: { grant: grant.id, revision: grant.botRevision } });
  });
  revalidatePath("/", "layout");
  revalidatePath("/admin/mcp");
}

/** "Create with chat": draft a bot configuration from a plain-language description. */
export async function draftBotFromDescription(description: string): Promise<BotDraftResult> {
  try {
    const p = await requirePrincipal();
    const idea = z.string().trim().min(1, "Describe the bot first.").max(DRAFT_DESCRIPTION_MAX_LENGTH, "Shorten the description and try again.").safeParse(description);
    if (!idea.success) return { ok: false, error: idea.error.issues[0].message };
    // No silent fallback to another model: drafting uses only the configured utility model.
    const app = await utilityApp();
    if (!app) return { ok: false, error: NO_UTILITY_MODEL };
    const available = await availableBuiltinKeys(p);
    const offered = BUILTIN_TOOLS.filter((t) => available.has(t.key));
    const { output } = await generateText({
      model: (await resolveModel(app, { purpose: "draft", principal: p })).model,
      output: Output.object({ schema: botDraftSchema(offered) }),
      instructions: botDraftInstructions(offered),
      prompt: `${idea.data}\n\n(The creator's name is ${p.user.name}.)`,
    });
    if (!output) return { ok: false, error: INCOMPLETE_DRAFT };
    return { ok: true, draft: finalizeDraft(output, offered) };
  } catch (err) {
    return describeDraftFailure(err);
  }
}

// ---------------------------------------------------------------------------
// Knowledge files
// ---------------------------------------------------------------------------

export async function addKnowledgeFile(botId: string, attachmentId: string) {
  const p = await requirePrincipal();
  await getEditableBot(p, botId);
  const [att] = await db
    .select()
    .from(attachments)
    .where(and(eq(attachments.id, attachmentId), eq(attachments.userId, p.user.id)));
  if (!att) throw new HttpError(404, "File not found");
  if (!att.extractedText) throw new HttpError(400, `${att.filename} has no readable text`);
  const chunks = chunkText(att.extractedText);
  const embeddings = await embedTexts(chunks, { userId: p.user.id, botId }).catch(() => null);
  await db.transaction(async (tx) => {
    const bot = await lockEditableBot(p, botId, tx);
    await requirePortableEngine(bot.appId);
    if (bot.executionMode === "service") throw new HttpError(400, "Service bots do not support knowledge files.");
    await tx.delete(knowledgeChunks).where(and(eq(knowledgeChunks.botId, botId), eq(knowledgeChunks.attachmentId, att.id)));
    for (let i = 0; i < chunks.length; i += 100) {
      await tx.insert(knowledgeChunks).values(
        chunks.slice(i, i + 100).map((content, j) => ({
          botId,
          attachmentId: att.id,
          chunkIndex: i + j,
          content,
          embedding: embeddings?.[i + j] ?? null,
        })),
      );
    }
    // Knowledge files imply the search tool.
    await tx.insert(botTools).values({ botId, toolKey: "knowledge", approval: "auto" }).onConflictDoNothing();
  });
  revalidatePath(`/bots/${botId}`);
  return { chunks: chunks.length, embedded: !!embeddings };
}

export async function removeKnowledgeFile(botId: string, attachmentId: string) {
  const p = await requirePrincipal();
  await getEditableBot(p, botId);
  await db.transaction(async (tx) => {
    const bot = await lockEditableBot(p, botId, tx);
    await requirePortableEngine(bot.appId);
    if (bot.executionMode === "service") throw new HttpError(400, "Service bots do not support knowledge files.");
    await tx.delete(knowledgeChunks).where(and(eq(knowledgeChunks.botId, botId), eq(knowledgeChunks.attachmentId, attachmentId)));
  });
  revalidatePath(`/bots/${botId}`);
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

const SkillInput = z.object({
  id: z.string().optional(),
  botId: z.string().nullable(),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(500),
  instructions: z.string().trim().min(1).max(20000),
  expectedOutput: z.string().max(5000).optional().nullable(),
  boundaries: z.string().max(5000).optional().nullable(),
});

export async function saveSkill(raw: z.infer<typeof SkillInput>) {
  const p = await requirePrincipal();
  const input = SkillInput.parse(raw);
  if (input.botId) await getEditableBot(p, input.botId);
  const slug = slugify(input.name) || "skill";
  await db.transaction(async (tx) => {
    const [existing] = input.id ? await tx.select().from(skills).where(and(eq(skills.id, input.id), eq(skills.ownerId, p.user.id))) : [];
    if (input.id && !existing) throw new HttpError(404, "Skill not found");
    for (const id of [...new Set([existing?.botId, input.botId].filter((x): x is string => !!x))].sort()) {
      const bot = await lockEditableBot(p, id, tx);
      await requirePortableEngine(bot.appId);
      if (bot.executionMode === "service") throw new HttpError(400, "Service bots do not support editable skills.");
    }
    if (existing) await tx.update(skills).set({ ...input, slug, version: existing.version + 1, updatedAt: new Date() }).where(eq(skills.id, existing.id));
    else {
      await tx.insert(skills).values({ ...input, ownerId: p.user.id, slug });
      if (input.botId) await tx.insert(botTools).values({ botId: input.botId, toolKey: "skills", approval: "auto" }).onConflictDoNothing();
    }
  });
  revalidatePath("/bots", "layout");
}

export async function deleteSkill(id: string) {
  const p = await requirePrincipal();
  await db.transaction(async (tx) => {
    const [skill] = await tx.select().from(skills).where(and(eq(skills.id, id), eq(skills.ownerId, p.user.id)));
    if (!skill) return;
    if (skill.botId) {
      const bot = await lockEditableBot(p, skill.botId, tx);
      await requirePortableEngine(bot.appId);
      if (bot.executionMode === "service") throw new HttpError(400, "Service bots do not support editable skills.");
    }
    await tx.delete(skills).where(and(eq(skills.id, id), eq(skills.ownerId, p.user.id)));
  });
  revalidatePath("/bots", "layout");
}

/** "Save as skill": draft a skill from a conversation that worked well. */
export async function draftSkillFromConversation(conversationId: string) {
  const p = await requirePrincipal();
  const { getOwnedConversation } = await import("@/lib/authz");
  const { loadMessageRows, pathTo, partsToText } = await import("@/lib/chat/store");
  const conv = await getOwnedConversation(p, conversationId);
  const path = pathTo(await loadMessageRows(conv.id), conv.currentLeafId);
  const app = await utilityApp();
  if (!app) throw new HttpError(400, "No utility model configured");
  const transcript = path.map((m) => `${m.role}: ${partsToText(m.parts).slice(0, 3000)}`).join("\n\n");
  const { output } = await generateText({
    model: (await resolveModel(app, { purpose: "draft", principal: p })).model,
    output: Output.object({
      schema: z.object({
        name: z.string(),
        description: z.string(),
        instructions: z.string().describe("numbered steps with decision rules"),
        expectedOutput: z.string(),
        boundaries: z.string(),
      }),
    }),
    instructions:
      "Turn the successful workflow in this conversation into a reusable skill: clear numbered steps, decision rules, the expected output format and safety boundaries.",
    prompt: transcript,
  });
  return { ...output, botId: conv.botId };
}

// ---------------------------------------------------------------------------
// Routines
// ---------------------------------------------------------------------------

const RoutineInput = z.object({
  id: z.string().optional(),
  botId: z.string(),
  name: z.string().trim().min(1).max(100),
  prompt: z.string().trim().min(1).max(10000),
  triggerType: z.enum(["cron", "webhook"]),
  cron: z.string().max(100).optional().nullable(),
  timezone: z.string().max(64).default("UTC"),
  enabled: z.boolean().default(true),
  notifyEmail: z.boolean().default(false),
});

export async function saveRoutine(raw: z.infer<typeof RoutineInput>) {
  const p = await requirePrincipal();
  const input = RoutineInput.parse(raw);
  const bot = await getAccessibleBot(p, input.botId);
  await requirePortableEngine(bot.appId);
  if (bot.executionMode === "service") throw new HttpError(400, "Service bots can only run in direct chats, not routines.");
  let nextRunAt: Date | null = null;
  if (input.triggerType === "cron") {
    if (!input.cron) throw new HttpError(400, "A schedule is required");
    try {
      nextRunAt = nextCronRun(input.cron, input.timezone);
    } catch {
      throw new HttpError(400, "Invalid cron expression");
    }
  }
  const values = {
    botId: input.botId,
    name: input.name,
    prompt: input.prompt,
    triggerType: input.triggerType,
    cron: input.triggerType === "cron" ? input.cron : null,
    timezone: input.timezone,
    enabled: input.enabled,
    notifyEmail: input.notifyEmail,
    nextRunAt: input.enabled ? nextRunAt : null,
  };
  if (input.id) {
    const res = await db
      .update(routines)
      .set(values)
      .where(and(eq(routines.id, input.id), eq(routines.ownerId, p.user.id)))
      .returning({ id: routines.id, webhookSecret: routines.webhookSecret });
    if (!res.length) throw new HttpError(404, "Routine not found");
    if (input.triggerType === "webhook" && !res[0].webhookSecret)
      await db.update(routines).set({ webhookSecret: newWebhookSecret() }).where(eq(routines.id, input.id));
  } else {
    await db.insert(routines).values({
      ...values,
      ownerId: p.user.id,
      webhookSecret: input.triggerType === "webhook" ? newWebhookSecret() : null,
    });
  }
  revalidatePath(`/bots/${input.botId}`);
}

export async function deleteRoutine(id: string) {
  const p = await requirePrincipal();
  await db.delete(routines).where(and(eq(routines.id, id), eq(routines.ownerId, p.user.id)));
  revalidatePath("/bots", "layout");
}

export async function runRoutineNow(id: string) {
  const p = await requirePrincipal();
  const [r] = await db
    .select()
    .from(routines)
    .where(and(eq(routines.id, id), eq(routines.ownerId, p.user.id)));
  if (!r) throw new HttpError(404, "Routine not found");
  const [run] = await db.insert(routineRuns).values({ routineId: r.id, trigger: "manual", lastEnqueueAt: new Date() }).returning();
  // The queued row is durable; the sweeper retries when immediate admission fails.
  await enqueue(QUEUES.routineRun, { runId: run.id }, { singletonKey: run.id });
  revalidatePath(`/bots/${r.botId}`);
  return { runId: run.id };
}

/** Snapshot of a bot's shareable configuration (no conversations, memory, knowledge files or secrets). */
async function snapshotBot(botId: string): Promise<BotTemplateSnapshot> {
  const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
  if (!bot) throw new HttpError(404, "Bot not found");
  const [tools, botSkills, botRoutines] = await Promise.all([
    db.select().from(botTools).where(eq(botTools.botId, bot.id)),
    db.select().from(skills).where(eq(skills.botId, bot.id)),
    db.select().from(routines).where(and(eq(routines.botId, bot.id), eq(routines.ownerId, bot.ownerId))),
  ]);
  return {
    name: bot.name,
    avatar: bot.avatar,
    label: bot.label,
    description: bot.description,
    instructions: bot.instructions,
    boundaries: bot.boundaries,
    starters: bot.starters,
    maxSteps: bot.maxSteps,
    tools: bot.executionMode === "service" ? [] : tools.map((t) => ({ key: t.toolKey, approval: t.approval, config: t.config })),
    skills: (bot.executionMode === "service" ? [] : botSkills).map((k) => ({
      slug: k.slug,
      name: k.name,
      description: k.description,
      instructions: k.instructions,
      expectedOutput: k.expectedOutput,
      boundaries: k.boundaries,
    })),
    routines: (bot.executionMode === "service" ? [] : botRoutines).map((r) => ({ name: r.name, prompt: r.prompt, triggerType: r.triggerType, cron: r.cron, timezone: r.timezone })),
  };
}

/** Create a private bot for the current user from a snapshot. Routines arrive paused so nothing double-fires. */
async function createBotFromSnapshot(snap: BotTemplateSnapshot, opts: { name: string; preferredAppId?: string | null; delegateIds?: string[] }) {
  const p = await assertCanCreate();
  const accessible = await listAccessibleApps(p);
  const app = accessible.find((a) => a.id === opts.preferredAppId);
  // Copies must retain the source connection, including when deletion has cleared its foreign key.
  if (!app) throw new HttpError(400, "The source bot connection is unavailable. Ask an admin to restore or configure it before copying this bot.");
  assertApprovedBot(app);
  const input: BotInput = {
    name: opts.name.slice(0, 80),
    avatar: snap.avatar,
    label: snap.label,
    description: snap.description,
    instructions: snap.instructions,
    boundaries: snap.boundaries,
    appId: app.id,
    visibility: "private",
    groupIds: [],
    maxSteps: snap.maxSteps,
    starters: snap.starters,
    tools: app.supportsTools ? snap.tools : [],
    delegateIds: opts.delegateIds ?? [],
    executionMode: "caller",
  };
  const v = await validateBotInput(p, input);
  const bot = await db.transaction(async (tx) => {
    const [bot] = await tx
      .insert(bots)
      .values({ ...input, ownerId: p.user.id, avatar: input.avatar || randomBlob(), label: input.label || null, maxSteps: v.maxSteps })
      .returning();
    await saveRelations(tx, bot.id, input, v);
    if (snap.skills.length) {
      await tx
        .insert(skills)
        .values(snap.skills.map((k) => ({ ...k, ownerId: p.user.id, botId: bot.id })))
        .onConflictDoNothing();
    }
    for (const r of snap.routines) {
      await tx.insert(routines).values({
        ownerId: p.user.id,
        botId: bot.id,
        name: r.name,
        prompt: r.prompt,
        triggerType: r.triggerType,
        cron: r.cron,
        timezone: r.timezone,
        enabled: false,
        webhookSecret: r.triggerType === "webhook" ? newWebhookSecret() : null,
      });
    }
    return bot;
  });
  revalidatePath("/", "layout");
  return { id: bot.id, pausedRoutines: snap.routines.length };
}

/**
 * Duplicate a bot (Grok Bot semantics): "<name> copy" with the profile, settings, skills, routines and avatar.
 * Conversation history, learned memory and knowledge files are not copied.
 */
export async function duplicateBot(botId: string) {
  const p = await requirePrincipal();
  const src = await getAccessibleBot(p, botId);
  await requirePortableEngine(src.appId);
  const snap = await snapshotBot(src.id);
  const delegates = await db.select().from(botDelegates).where(eq(botDelegates.botId, src.id));
  return createBotFromSnapshot(snap, {
    name: `${src.name} copy`,
    preferredAppId: src.appId,
    delegateIds: src.executionMode === "service" ? [] : delegates.map((d) => d.delegateBotId),
  });
}

// ---------------------------------------------------------------------------
// Template links ("Share → Create template"). Links require sign-in, i.e. they are team-only.
// ---------------------------------------------------------------------------

export async function getBotTemplate(botId: string) {
  const p = await requirePrincipal();
  await getEditableBot(p, botId);
  const [t] = await db
    .select({ id: botTemplates.id, updatedAt: botTemplates.updatedAt })
    .from(botTemplates)
    .where(and(eq(botTemplates.botId, botId), isNull(botTemplates.revokedAt)))
    .orderBy(desc(botTemplates.updatedAt))
    .limit(1);
  return t ? { token: t.id, updatedAt: t.updatedAt.toISOString() } : null;
}

export async function createBotTemplate(botId: string) {
  const p = await requirePrincipal();
  const bot = await getEditableBot(p, botId);
  await requirePortableEngine(bot.appId);
  const existing = await getBotTemplate(botId);
  if (existing) return existing;
  const token = newToken();
  await db.insert(botTemplates).values({ id: token, botId, createdBy: p.user.id, snapshot: await snapshotBot(botId) });
  return { token, updatedAt: new Date().toISOString() };
}

export async function updateBotTemplate(botId: string) {
  const p = await requirePrincipal();
  const bot = await getEditableBot(p, botId);
  await requirePortableEngine(bot.appId);
  const res = await db
    .update(botTemplates)
    .set({ snapshot: await snapshotBot(botId), updatedAt: new Date() })
    .where(and(eq(botTemplates.botId, botId), isNull(botTemplates.revokedAt)))
    .returning({ id: botTemplates.id });
  if (!res.length) throw new HttpError(404, "No template link for this bot");
  return { token: res[0].id, updatedAt: new Date().toISOString() };
}

export async function revokeBotTemplate(botId: string) {
  const p = await requirePrincipal();
  await getEditableBot(p, botId);
  await db
    .update(botTemplates)
    .set({ revokedAt: new Date() })
    .where(and(eq(botTemplates.botId, botId), isNull(botTemplates.revokedAt)));
}

/** "Add to my bots" from a template link. */
export async function addBotFromTemplate(token: string) {
  await requirePrincipal();
  const [t] = await db
    .select()
    .from(botTemplates)
    .where(and(eq(botTemplates.id, token), isNull(botTemplates.revokedAt)));
  if (!t) throw new HttpError(404, "This template link is no longer available");
  const [src] = await db.select({ appId: bots.appId, executionMode: bots.executionMode }).from(bots).where(eq(bots.id, t.botId));
  const snapshot = src?.executionMode === "service" ? { ...t.snapshot, tools: [], skills: [], routines: [] } : t.snapshot;
  return createBotFromSnapshot(snapshot, { name: snapshot.name, preferredAppId: src?.appId });
}

/** Data for the Grok-style side panel next to a bot chat: my routines for this bot + recent runs. */
export async function getBotPanelData(botId: string) {
  const p = await requirePrincipal();
  const bot = await getAccessibleBot(p, botId);
  const mine = await db
    .select()
    .from(routines)
    .where(and(eq(routines.botId, bot.id), eq(routines.ownerId, p.user.id)))
    .orderBy(routines.createdAt);
  const runs = mine.length
    ? await db
        .select()
        .from(routineRuns)
        .where(inArray(routineRuns.routineId, mine.map((r) => r.id)))
        .orderBy(desc(routineRuns.createdAt))
        .limit(50)
    : [];
  return {
    localEngine: await localEngine(bot.appId),
    personalHermes: bot.appId ? (await db.select().from(aiApps).where(eq(aiApps.id, bot.appId))).some(isDockerHermes) : false,
    canEdit: canEditBot(p, bot),
    serviceMode: bot.executionMode === "service",
    ...await loadBotActivity(p, bot.id),
    workspace: await loadWorkspacePreview(p, bot.id),
    routines: mine.map((r) => ({
      id: r.id,
      name: r.name,
      prompt: r.prompt,
      triggerType: r.triggerType,
      cron: r.cron,
      timezone: r.timezone,
      enabled: r.enabled,
      notifyEmail: r.notifyEmail,
      webhookSecret: openWebhookSecret(r.webhookSecret),
      nextRunAt: r.nextRunAt?.toISOString() ?? null,
      lastRunAt: r.lastRunAt?.toISOString() ?? null,
    })),
    runs: runs.map((r) => ({
      id: r.id,
      routineId: r.routineId,
      status: r.status,
      trigger: r.trigger,
      conversationId: r.conversationId,
      error: r.error,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

/** Pin a bot to the top of the sidebar or hide it (hiding never pauses the bot or its routines). */
export async function setBotSidebarPref(botId: string, pref: { pinned?: boolean; hidden?: boolean }) {
  const p = await requirePrincipal();
  await saveBotNavigation(p, { kind: "preference", botId, ...pref });
  revalidatePath("/", "layout");
}

/** Start a group chat with 2–6 bots. The first bot leads: it answers messages that don't @mention anyone. */
export async function createGroupChat(botIds: string[], name?: string) {
  const p = await requirePrincipal();
  const ids = [...new Set(z.array(z.string()).min(2).max(6).parse(botIds))];
  if (ids.length < 2) throw new HttpError(400, "Pick at least two bots");
  const members = [];
  for (const id of ids) {
    const bot = await getAccessibleBot(p, id);
    await requirePortableEngine(bot.appId);
    if (bot.executionMode === "service") throw new HttpError(400, "Service bots can only run in direct chats.");
    members.push(bot);
  }
  const names = members.map((m) => m.name);
  const title =
    name?.trim().slice(0, 120) || (names.length > 2 ? `${names.slice(0, -1).join(", ")} & ${names.at(-1)}` : names.join(" & "));
  const [conv] = await db.insert(conversations).values({ userId: p.user.id, isGroup: true, title }).returning({ id: conversations.id });
  await db.insert(conversationBots).values(ids.map((botId, position) => ({ conversationId: conv.id, botId, position })));
  revalidatePath("/", "layout");
  return { id: conv.id };
}
