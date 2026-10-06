import { isDockerHermes } from "@/lib/docker-hermes/policy";
import Link from "next/link";
import { canEditBot, activeServiceGrants, servicePublicationStatus } from "@/lib/bots/service";
import { and, desc, eq, inArray } from "drizzle-orm";
import { MessageSquare, Pencil } from "lucide-react";
import { BotPanels } from "@/components/bots/bot-panels";
import { PageFrame } from "@/components/page-frame";
import { db } from "@/db";
import { aiApps, memories, routineRuns, routines, toolCalls, users } from "@/db/schema";
import { skillsForBot } from "@/lib/agent/tools/skills";
import { getAccessibleBot } from "@/lib/authz";
import { openWebhookSecret } from "@/lib/routines";
import { requirePagePrincipal } from "@/lib/session";
import { BotAvatar } from "@/components/bots/bot-avatar";
import { BotPetSettings } from "@/components/pets/bot-pet";
import { StartSideChat } from "@/components/chat/start-side-chat";
import { ShareTemplateButton } from "@/components/bots/share-template";
import { UseAsTemplateButton } from "@/components/bots/template-button";
import { isLocalHermes } from "@/lib/local-hermes/config";
import { LearningPanel } from "@/components/bots/learning-panel";
import { learningViews } from "@/lib/agent/learning/store";

export default async function BotProfilePage(props: PageProps<"/bots/[id]">) {
  const p = await requirePagePrincipal();
  const { id } = await props.params;
  const bot = await getAccessibleBot(p, id);
  const [app] = bot.appId ? await db.select().from(aiApps).where(eq(aiApps.id, bot.appId)) : [];
  const docker = !!app && isDockerHermes(app);
  const local = !!app && isLocalHermes(app);
  const canEdit = canEditBot(p, bot);
  const learned = !bot.hermesTeam && app && app.provider !== "hermes" && bot.executionMode !== "service" ? await learningViews(p, bot.id) : null;
  const publication = bot.executionMode === "service" ? await servicePublicationStatus(bot) : null;
  const capabilities = bot.executionMode === "service" ? await activeServiceGrants(bot.id) : [];
  const [[owner], skills, myRoutines, mems, activity] = await Promise.all([
    db.select({ name: users.name }).from(users).where(eq(users.id, bot.ownerId)),
    bot.hermesTeam ? [] : skillsForBot(bot.id, bot.ownerId),
    bot.hermesTeam ? [] : db.select().from(routines).where(and(eq(routines.botId, bot.id), eq(routines.ownerId, p.user.id))).orderBy(routines.createdAt),
    bot.hermesTeam ? [] : db.select().from(memories).where(and(eq(memories.botId, bot.id), eq(memories.userId, p.user.id))).orderBy(desc(memories.updatedAt)),
    bot.hermesTeam ? [] : db
      .select()
      .from(toolCalls)
      .where(and(eq(toolCalls.botId, bot.id), eq(toolCalls.userId, p.user.id)))
      .orderBy(desc(toolCalls.createdAt))
      .limit(30),
  ]);
  const runs = myRoutines.length
    ? await db
        .select()
        .from(routineRuns)
        .where(inArray(routineRuns.routineId, myRoutines.map((r) => r.id)))
        .orderBy(desc(routineRuns.createdAt))
        .limit(30)
    : [];
  const origin = process.env.AUTH_URL ?? "";

  return (
    <PageFrame>
      <div className="flex flex-col items-center py-8 text-center">
        <BotAvatar botId={bot.id} value={bot.avatar} size={112} state="idle" className="h-28 w-28" />
        <h1 className="mt-4 max-w-full text-2xl font-semibold tracking-tight wrap-anywhere">{bot.name}</h1>
        {bot.label && <span className="mt-1 rounded-full bg-surface-2 px-2.5 py-0.5 text-xs text-muted">{bot.label}</span>}
        <p className="mt-1 text-sm text-subtle">By {owner?.name ?? "unknown"}</p>
        {bot.executionMode === "service" && <div className="mt-3 max-w-xl rounded-xl border border-border p-3 text-sm">
          <strong>Admin-managed service bot · direct chats only</strong>
          <p>{publication?.reason}. Connector access is confined to this bot. Writes require your approval.</p>
          <ul>{capabilities.map((g) => <li key={g.id}>{g.toolName} · {g.effect} · {g.requireApproval ? "asks every time" : "reviewed automatic read"}</li>)}</ul>
        </div>}
        {bot.description && <p className="mt-3 max-w-xl text-muted">{bot.description}</p>}
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <Link prefetch={false} href={`/?bot=${bot.id}`} className="flex items-center gap-2 rounded-full bg-fg px-5 py-2.5 text-sm font-medium text-bg hover:opacity-85">
            <MessageSquare className="h-4 w-4" /> Open home chat
          </Link>
          {!bot.hermesTeam && <StartSideChat botId={bot.id} className="flex items-center gap-2 rounded-full border border-border px-5 py-2.5 text-sm hover:bg-hover" />}
          <Link href={`/bots/${bot.id}/chats`} className="rounded-full border border-border px-5 py-2.5 text-sm hover:bg-hover">Chat history</Link>
          {docker && <Link href={`/bots/${bot.id}/settings`} className="rounded-full border border-border px-5 py-2.5 text-sm hover:bg-hover">Hermes settings</Link>}
          <BotPetSettings botId={bot.id} botName={bot.name} botAvatar={bot.avatar} />
          {!local && !bot.hermesTeam && <UseAsTemplateButton botId={bot.id} />}
          {canEdit && !local && !bot.hermesTeam && <ShareTemplateButton botId={bot.id} />}
          {canEdit && (
            <Link href={`/bots/${bot.id}/edit`} className="flex items-center gap-2 rounded-full border border-border px-5 py-2.5 text-sm font-medium hover:bg-hover">
              <Pencil className="h-4 w-4" /> Edit
            </Link>
          )}
        </div>
      </div>
      {bot.hermesTeam ? <div className="rounded-xl border border-border p-5 text-sm space-y-2">
        <h2 className="font-semibold">Hermes Team Bot</h2>
        <p>Open the chat to use your private conversation. Maintainers can switch to Admin mode to share working skills and native memory, then review Publish changes.</p>
        <p>Model access must be verified before replies are available. Native learning stays with each private instance until a maintainer publishes selected resources.</p>
      </div> : local && !docker ? <div className="rounded-xl border border-border p-5 text-sm space-y-2">
        <h2 className="font-semibold">Local Hermes · private pilot</h2>
        <p>Persona, skills, tools, memory and saved sessions live in the selected native Hermes profile. This bot supports direct text chat, native tool approvals and Stop.</p>
        <p>Profile editing, native slash execution, file uploads, groups and routines are not available here yet.</p>
        {p.isAdmin && <Link className="inline-block underline" href="/admin/hermes">Engine status and controls</Link>}
      </div> : <BotPanels
        botId={bot.id}
        canEdit={canEdit && !docker}
        native={docker}
        serviceMode={bot.executionMode === "service"}
        webhookBase={`${origin}/api/routines/webhook`}
        skills={skills.map((s) => ({
          id: s.id,
          botId: s.botId,
          slug: s.slug,
          name: s.name,
          description: s.description,
          instructions: s.instructions,
          expectedOutput: s.expectedOutput,
          boundaries: s.boundaries,
          version: s.version,
          mine: s.ownerId === p.user.id,
        }))}
        routines={myRoutines.map((r) => ({
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
        }))}
        runs={runs.map((r) => ({
          id: r.id,
          routineId: r.routineId,
          status: r.status,
          trigger: r.trigger,
          conversationId: r.conversationId,
          error: r.error,
          createdAt: r.createdAt.toISOString(),
        }))}
        memories={mems.map((m) => ({ id: m.id, content: m.content, pinned: m.pinned }))}
        activity={activity.map((a) => ({
          id: a.id,
          toolName: a.toolName,
          status: a.status,
          conversationId: a.conversationId,
          createdAt: a.createdAt.toISOString(),
        }))}
      />}
      {learned && <LearningPanel rows={learned} />}
    </PageFrame>
  );
}
