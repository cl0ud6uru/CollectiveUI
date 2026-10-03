import { defaultCoordinator } from "@/lib/coordinator/store";
import { and, count, desc, eq, inArray, isNull } from "drizzle-orm";
import { ChatShell } from "@/components/chat/chat-shell";
import { ShellProvider } from "@/components/chat/shell-context";
import type { TargetOption } from "@/components/chat/types";
import { db } from "@/db";
import { aiApps, conversations, folders, inboxItems, userBotPrefs } from "@/db/schema";
import { readAccessiblePets } from "@/lib/pets/store";
import { PetProvider } from "@/components/pets/pet-context";
import { listAccessibleModels, listAccessibleBots } from "@/lib/authz";
import { personalPlanStatus } from "@/lib/chat/targets";
import { requirePagePrincipal } from "@/lib/session";
import { getPublicBranding } from "@/lib/branding/store";
import { loadBotRoster } from "@/lib/chat/roster";
import { loadRecentTasks } from "@/lib/chat/recent-tasks";
import { mergeRecentTasks } from "@/lib/chat/recent-task-state";

export default async function ChatLayout({ children }: LayoutProps<"/">) {
  const p = await requirePagePrincipal();
  const [convs, folderRows, apps, bots, branding, [unread], prefs, tasks] = await Promise.all([
    db
      .select({
        id: conversations.id,
        title: conversations.title,
        pinned: conversations.pinned,
        folderId: conversations.folderId,
        botId: conversations.botId,
        appId: conversations.appId,
        source: conversations.source,
        isGroup: conversations.isGroup,
        isBotHome: conversations.isBotHome,
        updatedAt: conversations.updatedAt,
      })
      .from(conversations)
      .where(and(eq(conversations.userId, p.user.id), eq(conversations.archived, false)))
      .orderBy(desc(conversations.updatedAt))
      .limit(500),
    db.select({ id: folders.id, name: folders.name }).from(folders).where(eq(folders.userId, p.user.id)).orderBy(folders.sortOrder, folders.createdAt),
    listAccessibleModels(p),
    listAccessibleBots(p),
    getPublicBranding(),
    db
      .select({ n: count() })
      .from(inboxItems)
      .where(and(eq(inboxItems.userId, p.user.id), isNull(inboxItems.readAt))),
    db.select().from(userBotPrefs).where(eq(userBotPrefs.userId, p.user.id)),
    loadRecentTasks(p),
  ]);
  const coordinator = await defaultCoordinator(p);
  const prefByBot = new Map(prefs.map((x) => [x.botId, x]));
  const homes = new Map<string, { botId: string; conversationId: string; updatedAt: Date }>();
  for (const c of convs) if (c.isBotHome && c.botId && !homes.has(c.botId)) homes.set(c.botId, { botId: c.botId, conversationId: c.id, updatedAt: c.updatedAt });
  const roster = await loadBotRoster(p.user.id, [...homes.values()]);
  const initialPets = await readAccessiblePets(p, bots);
  const planStatus = await personalPlanStatus(p, apps);
  const botAppIds = bots.flatMap((b) => b.appId ? [b.appId] : []);
  const hermesApps = new Set(botAppIds.length ? (await db.select({ id: aiApps.id }).from(aiApps).where(and(inArray(aiApps.id, botAppIds), eq(aiApps.provider, "hermes")))).map((a) => a.id) : []);
  const appOptions: TargetOption[] = apps.map((a) => ({
    kind: "app",
    id: a.id,
    name: a.name,
    label: a.model,
    icon: a.icon,
    description: a.description,
    supportsVision: a.supportsVision,
    hermes: a.provider === "hermes",
    ...(a.provider === "chatgpt" && planStatus ? { personalPlan: { provider: "chatgpt" as const, status: planStatus } } : {}),
  }));
  // Keep the roster order stable (alphabetical within pinned/hidden); rows only show a preview line and busy status.
  const botOptions: TargetOption[] = bots.map((b) => ({
    kind: "bot",
    coordinator: b.id === coordinator?.bot.id,
    id: b.id,
    name: b.name,
    icon: b.avatar,
    label: b.label,
    description: b.description,
    starters: b.starters,
    hermes: !!b.appId && hermesApps.has(b.appId),
    pinned: prefByBot.get(b.id)?.pinned ?? false,
    hidden: prefByBot.get(b.id)?.hidden ?? false,
    preview: roster.get(b.id)?.preview ?? null,
    lastAt: roster.get(b.id)?.lastAt ?? null,
    status: roster.get(b.id)?.status ?? null,
  }));

  return (
    <ShellProvider
      user={{ id: p.user.id, name: p.user.name, email: p.user.email, isAdmin: p.isAdmin, canCreateBots: p.canCreateBots }}
      branding={branding}
      conversations={mergeRecentTasks(convs.map((c) => ({ ...c, updatedAt: c.updatedAt.toISOString() })), tasks)}
      folders={folderRows}
      apps={appOptions}
      bots={botOptions}
      inboxUnread={unread?.n ?? 0}
    >
      <PetProvider key={p.user.id} accountId={p.user.id} initialPets={initialPets}><ChatShell>{children}</ChatShell></PetProvider>
    </ShellProvider>
  );
}
