import { PersonalHermes } from "@/components/settings/personal-hermes";
import { dockerAllowed, assertDockerCreate } from "@/lib/docker-hermes/policy";
import { and, desc, eq, isNull } from "drizzle-orm";
import { PageFrame } from "@/components/page-frame";
import { SettingsView } from "@/components/settings-view";
import { SecurityPanel } from "@/components/settings/security-panel";
import { db } from "@/db";
import { bots, conversations, memories, toolGrants } from "@/db/schema";
import { listAccessibleModels } from "@/lib/authz";
import { listStartBots } from "@/lib/chat/targets";
import { getPendingChatGPTLogin } from "@/lib/llm/chatgpt/device";
import { planLabel, userMayUseChatGPT } from "@/lib/llm/chatgpt/policy";
import { getChatGPTCredential } from "@/lib/llm/chatgpt/store";
import { requirePagePrincipal } from "@/lib/session";
import { workspaceView } from "@/lib/sandbox/view";
import { getSetting } from "@/lib/settings";
import type { ChatGPTConnectionView } from "@/components/settings/chatgpt-connection";

export default async function SettingsPage() {
  const p = await requirePagePrincipal();
  const [chatgptSettings, credential, pendingLogin] = await Promise.all([
    getSetting("chatgpt"),
    getChatGPTCredential(p.user.id),
    getPendingChatGPTLogin(p.user.id),
  ]);
  let hermes = null;
  if (dockerAllowed(p)) {
    let canCreate = true;
    try { assertDockerCreate(p, await getSetting("tools")); } catch { canCreate = false; }
    hermes = <PersonalHermes canCreate={canCreate} />;
  }
  const allowed = userMayUseChatGPT(p, chatgptSettings);
  // Only non-secret account facts reach the browser. The tab shows when people may connect, or have a connection.
  const chatgpt: ChatGPTConnectionView | null =
    allowed || credential
      ? {
          allowed,
          pending: allowed ? pendingLogin : null,
          connection: credential
            ? {
                email: credential.email,
                plan: planLabel(credential.planType),
                accountId: credential.accountId,
                status: credential.status,
                connectedAt: credential.createdAt.toISOString(),
                lastRefreshAt: credential.lastRefreshAt?.toISOString() ?? null,
                rateLimits: (credential.rateLimits ?? null) as NonNullable<ChatGPTConnectionView["connection"]>["rateLimits"],
              }
            : null,
        }
      : null;
  const [apps, startBots, mems, archived, grants, workspace] = await Promise.all([
    listAccessibleModels(p),
    listStartBots(p),
    db.select().from(memories).where(and(eq(memories.userId, p.user.id), isNull(memories.botId))).orderBy(desc(memories.updatedAt)),
    db
      .select({ id: conversations.id, title: conversations.title, updatedAt: conversations.updatedAt })
      .from(conversations)
      .where(and(eq(conversations.userId, p.user.id), eq(conversations.archived, true)))
      .orderBy(desc(conversations.updatedAt)),
    db
      .select({ botId: toolGrants.botId, toolName: toolGrants.toolName, botName: bots.name })
      .from(toolGrants)
      .innerJoin(bots, eq(bots.id, toolGrants.botId))
      .where(eq(toolGrants.userId, p.user.id)),
    workspaceView(p),
  ]);
  return (
    <PageFrame title="Settings">
      <SettingsView
        prefs={p.user.prefs ?? {}}
        apps={apps.map((a) => ({ id: a.id, name: a.name }))}
        bots={startBots.map((b) => ({ id: b.id, name: b.name }))}
        memories={mems.map((m) => ({ id: m.id, content: m.content, pinned: m.pinned }))}
        archived={archived.map((a) => ({ id: a.id, title: a.title, updatedAt: a.updatedAt.toISOString() }))}
        grants={grants}
        user={{ name: p.user.name, upn: p.user.upn, authSource: p.user.authSource }}
        chatgpt={chatgpt}
        workspace={workspace}
        security={<SecurityPanel />}
        hermes={hermes}
      />
    </PageFrame>
  );
}
