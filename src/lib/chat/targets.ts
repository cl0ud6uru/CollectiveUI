import type { TargetOption } from "@/components/chat/types";
import { userBotPrefs, type AiApp, type Bot } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import type { Principal } from "@/lib/auth/groups";
import { getAccessibleBot, getAccessibleModel, getUsableBot, listAccessibleBots, listAccessibleModels, HttpError } from "@/lib/authz";
import { skillsForBot } from "@/lib/agent/tools/skills";
import { learnedSkillsForBot, learningIsEnabled } from "@/lib/agent/learning/store";
import { getSetting } from "@/lib/settings";
import { loadGroupMembers } from "@/lib/agent/group";
import { getChatGPTCredential } from "@/lib/llm/chatgpt/store";
import { resolveTurnTarget } from "@/lib/agent/target";

type PlanStatus = NonNullable<TargetOption["personalPlan"]>["status"];

/** Whether this person has connected their ChatGPT plan (only looked up when a ChatGPT app is offered). */
export async function personalPlanStatus(p: Principal, apps: Pick<AiApp, "provider">[]): Promise<PlanStatus | null> {
  if (!apps.some((a) => a.provider === "chatgpt")) return null;
  const c = await getChatGPTCredential(p.user.id);
  return !c ? "not_connected" : c.status === "active" ? "connected" : "needs_reauth";
}

export const appOption = (a: AiApp, planStatus?: PlanStatus | null): TargetOption => ({
  kind: "app",
  id: a.id,
  name: a.name,
  icon: a.icon,
  description: a.description,
  supportsVision: a.supportsVision,
  hermes: a.provider === "hermes",
  ...(a.provider === "chatgpt" && planStatus ? { personalPlan: { provider: "chatgpt" as const, status: planStatus } } : {}),
});

export const botOption = (b: Bot, hermes = false): TargetOption => ({
  kind: "bot",
  id: b.id,
  name: b.name,
  icon: b.avatar,
  label: b.label,
  description: b.description,
  starters: b.starters,
  hermes: hermes || b.hermesTeam,
  hermesTeam: b.hermesTeam,
});

/** A bot new chats may start with. The organization default must be shared with everyone. */
export async function assertDefaultBot(p: Principal, botId: string, { shared = false } = {}) {
  const bot = await getUsableBot(p, botId);
  if (shared && bot.visibility !== "org") throw new HttpError(400, "Choose a bot shared with everyone to start new chats with.");
  if (!shared && !(await listStartBots(p)).some(b => b.id === bot.id)) throw new HttpError(403, "This default bot is unavailable.");
  await resolveTurnTarget(p, { botId: bot.id, appId: null });
  return bot;
}

/** Automatic entry uses the person's audience and visibility preferences, never admin oversight. */
export async function listStartBots(p: Principal) {
  const [bots, hidden] = await Promise.all([
    listAccessibleBots(p),
    db.select({ botId: userBotPrefs.botId }).from(userBotPrefs).where(and(eq(userBotPrefs.userId, p.user.id), eq(userBotPrefs.hidden, true))),
  ]);
  const hiddenIds = new Set(hidden.map(b => b.botId));
  return bots.filter(b => !hiddenIds.has(b.id));
}

export async function resolveTargetOption(
  p: Principal,
  opts: { appId?: string | null; botId?: string | null; conversationId?: string; group?: { id: string; title: string }; allowDefault?: boolean; modelsOnly?: boolean },
): Promise<{ unavailableReason?: string; target: TargetOption | null; skills: { slug: string; name: string; description: string }[] }> {
  if (opts.group) {
    const members = (await loadGroupMembers(p, opts.group.id)).map((m) => botOption(m.bot));
    return {
      target: { kind: "group", id: opts.group.id, name: opts.group.title, icon: null, description: null, members },
      skills: [],
    };
  }
  if (opts.botId) {
    const candidate = await getAccessibleBot(p, opts.botId).catch(() => null);
    if (candidate?.hermesTeam) {
      const { authorizeTeam } = await import('@/lib/hermes-team/store');
      const { authorizeTeamConversation } = await import('@/lib/hermes-team/conversations');
      try {
        if (opts.conversationId) {
          const context = await authorizeTeamConversation(p, opts.conversationId);
          if (context.bot.id !== candidate.id) throw new HttpError(404, 'Team conversation not found.');
        }
        else {
          try { await authorizeTeam(p, candidate.id, 'member'); }
          catch (e) { if (!(e instanceof HttpError) || e.status !== 403) throw e; await authorizeTeam(p, candidate.id, 'admin'); }
        }
        return { target: botOption(candidate, true), skills: [] };
      } catch { return { target: null, skills: [], unavailableReason: 'Your Team Bot access changed.' }; }
    }
    const bot = await getUsableBot(p, opts.botId).catch(() => null);
    if (bot) {
      const resolved = await resolveTurnTarget(p, { botId: bot.id, appId: null }).catch(() => null);
      const hermes = resolved?.app.provider === "hermes";
      const available = hermes ? [] : await skillsForBot(bot.id, bot.ownerId);
      if (!hermes && bot.executionMode !== "service" && await learningIsEnabled(p)) available.push(...await learnedSkillsForBot(bot.id, p.user.id));
      const skills = available.map((s) => ({ slug: s.slug, name: s.name, description: s.description }));
      return { target: botOption(bot, hermes), skills };
    }
    return { target: null, skills: [] };
  }
  if (opts.appId) {
    try {
      const app = await getAccessibleModel(p, opts.appId);
      return { target: appOption(app, await personalPlanStatus(p, [app])), skills: [] };
    } catch (err) {
      return { target: null, skills: [], unavailableReason: err instanceof HttpError ? err.message : "This model is unavailable. Choose a model or bot to start a new chat." };
    }
  }
  if (opts.allowDefault === false) return { target: null, skills: [] };
  // A configured default is a billing choice: never silently replace an invalid choice.
  // A person's own default (a bot or a model) wins over the organization's; each level holds at most one.
  const prefs = p.user.prefs ?? {};
  const personal = opts.modelsOnly ? !!prefs.defaultAppId : !!(prefs.defaultBotId || prefs.defaultAppId);
  const selected = personal ? prefs : await getSetting("branding");
  const defaultBotId = opts.modelsOnly ? undefined : selected.defaultBotId;
  const defaultId = selected.defaultAppId;
  if (defaultBotId) {
    try {
      const bot = await assertDefaultBot(p, defaultBotId);
      if (!personal && bot.visibility !== "org") throw new HttpError(403, "The organization default is no longer shared.");
      return await resolveTargetOption(p, { botId: bot.id, allowDefault: false });
    } catch {
      return { target: null, skills: [], unavailableReason: "Your default bot is unavailable. Choose a model or bot, or update your default in Settings." };
    }
  }
  if (defaultId) {
    const result = await resolveTargetOption(p, { appId: defaultId, allowDefault: false });
    return result.target ? result : { ...result, unavailableReason: `Your default model is unavailable. Choose a model or update your default in Settings. ${result.unavailableReason ?? ""}` };
  }
  const [preferred] = await listAccessibleModels(p);
  return { target: preferred ? appOption(preferred, await personalPlanStatus(p, [preferred])) : null, skills: [],
    ...(!preferred ? { unavailableReason: "No models are available. Choose a bot, or ask an admin to configure a model connection." } : {}) };
}
