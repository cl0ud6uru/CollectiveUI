import { and, desc, eq, or, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { agentRuns, conversations, hermesChatSettings, hermesRunContexts, usageEvents } from "@/db/schema";
import { resolveTurnTarget } from "@/lib/agent/target";
import type { Principal } from "@/lib/auth/groups";
import { HttpError } from "@/lib/authz";
import { discoverHermes } from "@/lib/llm/providers/hermes/client";
import { allowedHermesModels, hermesTargetKey } from "@/lib/llm/providers/hermes/scope";
import { hermesTargetFor } from "@/lib/llm/resolve";
import { assertHermesIdle, hermesSettings } from "@/lib/runs/hermes-context";
import { reconcileHermesStop, stopHermesConversation } from "@/lib/runs/hermes-stop";
import { lockUserRuns } from "@/lib/runs/lock";
import { stopRunFor } from "@/lib/runs/store";
import { HERMES_COMMANDS, parseHermesInput, unsupportedHermesCommand, type CommandResult, type HermesCommandCatalog } from "./hermes-commands";
import { freshConversation } from "./fresh";
import { isLocalHermes } from "@/lib/local-hermes/config";

export type CommandTarget = { conversationId: string; appId?: string; botId?: string };

/** Every request resolves ownership and effective app anew. Client identifiers can only name portal resources. */
export async function resolveCommandTarget(p: Principal, input: CommandTarget) {
  const [conv] = await db.select().from(conversations).where(eq(conversations.id, input.conversationId));
  if (conv && conv.userId !== p.user.id) throw new HttpError(404, "Conversation not found");
  if (conv?.isGroup || (conv && conv.source !== "chat")) throw new HttpError(400, "Slash controls are available in direct chats, not groups or routine results.");
  const target = conv ?? { appId: input.botId ? null : (input.appId ?? null), botId: input.botId ?? null };
  const { app, bot } = await resolveTurnTarget(p, target);
  return { conv, app, bot, input, userId: p.user.id };
}
type Target = Awaited<ReturnType<typeof resolveCommandTarget>>;

export async function commandCatalog(t: Target): Promise<HermesCommandCatalog | { backend: "other" }> {
  if (t.app.provider !== "hermes") return { backend: "other" };
  const settings = await hermesSettings(t.input.conversationId);
  let discovery: Awaited<ReturnType<typeof discoverHermes>>;
  try {
    const { target } = await hermesTargetFor(t.app, t.bot ? { userId: t.userId, botId: t.bot.id } : undefined);
    discovery = await discoverHermes(target);
  } catch {
    const unavailable = { available: false as const, reason: "Hermes discovery is unavailable. Local commands still work; an admin can check the connection." };
    discovery = { models: unavailable, skills: unavailable, tools: unavailable, canStopRemotely: false, capabilityWarning: unavailable.reason };
  }
  const allowed = allowedHermesModels(t.app);
  return {
    backend: "hermes", commands: isLocalHermes(t.app) ? HERMES_COMMANDS.filter(c => !["model", "skills", "tools"].includes(c.name)) : HERMES_COMMANDS, ...discovery,
    models: discovery.models.available ? { available: true, items: discovery.models.items.filter((m) => allowed.includes(m) && m !== "default") } : discovery.models,
    requestedModel: settings?.model ?? null, revision: settings?.revision ?? 0,
  };
}

async function ensureConversation(tx: Tx, t: Target) {
  await tx.insert(conversations).values({ id: t.input.conversationId, userId: t.userId, appId: t.bot ? null : t.app.id, botId: t.bot?.id ?? null }).onConflictDoNothing();
  const [conv] = await tx.select().from(conversations).where(eq(conversations.id, t.input.conversationId));
  if (!conv || conv.userId !== t.userId) throw new HttpError(404, "Conversation not found");
  if (conv.botId !== (t.bot?.id ?? null) || conv.appId !== (t.bot ? null : t.app.id) || conv.isGroup || conv.source !== "chat")
    throw new HttpError(409, "This conversation's target changed. Reload before trying again.");
}

const MODEL_NOTE = "This is a request for future turns in this chat. Hermes may select a different runtime; /status shows the last reported model. Shared profile defaults are unchanged.";

export async function executeHermesCommand(p: Principal, input: CommandTarget & { text: string; revision?: number; newConversationId?: string; messageId?: string }): Promise<CommandResult> {
  const t = await resolveCommandTarget(p, input);
  const command = parseHermesInput(input.text);
  if (command.kind !== "command") throw new HttpError(400, "Enter a slash command.");
  const { name, args, namespace } = command;
  if ((name === "new" || name === "reset") && (t.app.provider === "hermes" || t.bot)) {
    if (args) throw new HttpError(400, `/${name} doesn't accept arguments here.`);
    const next = await freshConversation(p, { conversationId: input.conversationId, bot: t.bot, app: t.app, requireSource: !!t.conv }, input.newConversationId ?? "");
    return { title: next.isBotHome ? "Fresh home chat" : "Fresh session", lines: ["Started a fresh chat. The previous transcript and long-term memory are preserved in history."], navigateTo: `/c/${next.id}` };
  }
  if (t.app.provider !== "hermes") throw new HttpError(400, "Only /new and /reset are available for this bot.");
  if (namespace !== "hermes" || !HERMES_COMMANDS.some((c) => c.name === name)) throw new HttpError(400, unsupportedHermesCommand(name, namespace));
  if (isLocalHermes(t.app) && ["model", "skills", "tools"].includes(name))
    throw new HttpError(400, "This Local Hermes pilot does not expose native model, skill or tool management commands. The bot's selected model and native profile configuration remain authoritative; manage the profile in Hermes after stopping the controller.");
  if (name !== "model" && args) throw new HttpError(400, `/${name} doesn't accept arguments here.`);
  if (name === "help" && isLocalHermes(t.app)) return { title: "Local Hermes pilot", lines: [
    "/status, /usage, /new, /reset and /stop are available. Native model, skills, tools, branching, clarify and secret prompts are not exposed in this pilot.",
    "Hermes owns this bot's persona, skills, memory and saved sessions. Stop the controller before using another Hermes app with this profile.",
    "Commands do not enter inference. Use // to send literal leading slash text.",
  ] };
  if (name === "help") return { title: "Hermes commands", lines: [
    ...HERMES_COMMANDS.map((c) => `/${c.name}${c.args ? ` ${c.args}` : ""} — ${c.description}`),
    "Use /hermes <command> for the explicit namespace. Portal skills aren't offered with this backend. Native CLI, gateway and skill execution are planned for a later release.",
    "Commands do not send a model message. Use // to send a literal leading slash. Discovery shows at most 200 entries per category.",
  ] };
  if (name === "stop") {
    if (input.messageId) {
      const [known] = await db.select({ id: agentRuns.id }).from(agentRuns).where(and(eq(agentRuns.conversationId, input.conversationId), eq(agentRuns.userId, t.userId), or(eq(agentRuns.messageId, input.messageId), eq(agentRuns.parentMessageId, input.messageId)))).limit(1);
      // A click can beat admission of the message visible in the browser. Wait briefly using the same contract as Stop.
      if (!known) await stopRunFor(p, input.conversationId, input.messageId);
    }
    return { title: "Cancellation", lines: await stopHermesConversation(t.userId, input.conversationId), refresh: true };
  }
  if (name === "status") {
    const [latest] = await db.select().from(agentRuns).where(and(eq(agentRuns.conversationId, input.conversationId), eq(agentRuns.userId, t.userId))).orderBy(desc(agentRuns.createdAt)).limit(1);
    // Before command support the ledger stored the configured alias, not the reported runtime. Exclude those rows.
    const [runtime] = await db.select({ model: usageEvents.model }).from(usageEvents).innerJoin(hermesRunContexts, eq(hermesRunContexts.runId, usageEvents.runId))
      .where(and(eq(usageEvents.conversationId, input.conversationId), eq(usageEvents.userId, t.userId), eq(usageEvents.providerKind, "hermes"))).orderBy(desc(usageEvents.createdAt)).limit(1);
    const settings = await hermesSettings(input.conversationId);
    const pending = await db.select({ run: agentRuns }).from(agentRuns).innerJoin(hermesRunContexts, eq(hermesRunContexts.runId, agentRuns.id))
      .where(and(eq(agentRuns.conversationId, input.conversationId), eq(agentRuns.userId, t.userId), eq(hermesRunContexts.stopState, "pending")));
    return { title: "Chat status", lines: [
      `Portal reply: ${latest?.status ?? "no replies yet"}${latest?.cancelRequestedAt ? " (stop requested)" : ""}.`,
      `Requested model: ${settings?.model ?? "Hermes default"}. Last reported model: ${runtime?.model && runtime.model !== "unreported" ? runtime.model : "not reported yet"}.`,
      ...(settings && settings.targetKey !== hermesTargetKey(t.app) ? ["This chat's Hermes connection changed. Use /model default to clear an old preference once idle."] : []),
      ...await Promise.all(pending.map(({ run }) => reconcileHermesStop(run, false))),
      "A fresh portal chat creates a separate Hermes session. Profile files and long-term memory may still be shared; /new does not erase them.",
    ], revision: settings?.revision ?? 0 };
  }
  if (name === "usage") {
    const [usage] = await db.select({
      replies: sql<number>`count(*)::int`, reported: sql<number>`count(${usageEvents.inputTokens})::int`,
      input: sql<number>`coalesce(sum(${usageEvents.inputTokens}), 0)::bigint`, output: sql<number>`coalesce(sum(${usageEvents.outputTokens}), 0)::bigint`,
    }).from(usageEvents).where(and(eq(usageEvents.conversationId, input.conversationId), eq(usageEvents.userId, t.userId), eq(usageEvents.providerKind, "hermes")));
    return { title: "Conversation usage", lines: [`${usage.replies} recorded Hermes usage events; ${usage.reported} reported input tokens.`, `Reported totals: ${usage.input} input tokens; ${usage.output} output tokens.`, "Portal ledger for this conversation only. Missing or interrupted reports are not zero usage; this is not a profile-wide bill or context-window measurement."] };
  }
  if (name === "model" && args === "default") return setModel(t, null, input.revision);
  const catalog = await commandCatalog(t) as HermesCommandCatalog;
  if (name === "model") {
    if (!args) return { title: "Model request", revision: catalog.revision, lines: [
      `Requested: ${catalog.requestedModel ?? "Hermes default"}.`,
      catalog.models.available ? `Allowed routes: ${catalog.models.items.join(", ") || "none configured by the admin"}.` : catalog.models.reason,
      "Use /model <route> or /model default while the chat is idle.", MODEL_NOTE,
    ] };
    if (!catalog.models.available || !catalog.models.items.includes(args)) throw new HttpError(400, "That model route is not currently advertised and allowed. Use /model to see available choices.");
    return setModel(t, args, input.revision);
  }
  if (name === "skills") return { title: "Hermes skills — discovery only", lines: catalog.skills.available
    ? [...catalog.skills.items.map((s) => `${s.name} — ${s.description}`), "Native /skill invocation is not available yet. This list is metadata, not an executable command catalog."]
    : [catalog.skills.reason, "Some Hermes releases have a skills-discovery bug. An operator can update or patch Hermes; local commands remain available."] };
  return { title: "Hermes toolsets — read only", lines: catalog.tools.available
    ? [...catalog.tools.items.map((s) => `${s.name}: ${s.enabled ? "enabled" : "disabled"}, ${s.configured ? "configured" : "not configured"} — ${s.description}`), "Toolset changes require a Hermes operator. This command does not enable tools or grant approval."]
    : [catalog.tools.reason] };
}

async function setModel(t: Target, model: string | null, revision?: number): Promise<CommandResult> {
  const next = await db.transaction(async (tx) => {
    await lockUserRuns(tx, t.userId);
    await ensureConversation(tx, t);
    await assertHermesIdle(tx, t.input.conversationId);
    const current = await hermesSettings(t.input.conversationId, tx);
    const targetKey = hermesTargetKey(t.app);
    // Repeating an absolute selection is idempotent, including after a lost HTTP response.
    if (current?.model === model && current.targetKey === targetKey) return current;
    if (revision !== (current?.revision ?? 0)) throw new HttpError(409, "The model preference changed in another tab. Run /model and try again.");
    const [updated] = await tx.insert(hermesChatSettings).values({ conversationId: t.input.conversationId, targetKey, model, revision: (current?.revision ?? 0) + 1 })
      .onConflictDoUpdate({ target: hermesChatSettings.conversationId, set: { targetKey, model, revision: (current?.revision ?? 0) + 1 } }).returning();
    return updated;
  });
  return { title: "Model request saved", lines: [`Requested: ${model ?? "Hermes default"}.`, MODEL_NOTE], revision: next.revision, conversationId: t.input.conversationId };
}
