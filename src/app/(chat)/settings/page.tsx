import { PersonalHermes } from "@/components/settings/personal-hermes";
import { RemoteHermes } from "@/components/settings/remote-hermes";
import { listRemoteConnections } from "@/lib/remote-hermes/store";
import { dockerAllowed, assertDockerCreate } from "@/lib/docker-hermes/policy";
import { and, desc, eq, isNull } from "drizzle-orm";
import { PageFrame } from "@/components/page-frame";
import { SettingsView } from "@/components/settings-view";
import { SecurityPanel } from "@/components/settings/security-panel";
import { HermesTeamSavedConnections } from "@/components/settings/hermes-team-connections";
import { listOwnedMemberMcpConnections } from "@/lib/mcp/member-connections";
import { db } from "@/db";
import { botTools, bots, conversations, memories, toolGrants } from "@/db/schema";
import { listAccessibleBots, listAccessibleModels } from "@/lib/authz";
import { listStartBots } from "@/lib/chat/targets";
import { requirePagePrincipal } from "@/lib/session";
import { workspaceView } from "@/lib/sandbox/view";
import { getSetting } from "@/lib/settings";

export default async function SettingsPage() {
  const p = await requirePagePrincipal();
  const [remotePolicy, remoteConnections] = await Promise.all([getSetting('remoteHermes'), listRemoteConnections(p.user.id)]);
  let hermes = null;
  if (await dockerAllowed(p)) {
    let canCreate = true;
    try { await assertDockerCreate(p, await getSetting("tools")); } catch { canCreate = false; }
    hermes = <PersonalHermes canCreate={canCreate} />;
  }
  const [apps, startBots, accessibleBots, workspaceToolRows, mems, archived, grants, workspace, teamConnections] = await Promise.all([
    listAccessibleModels(p),
    listStartBots(p),
    listAccessibleBots(p),
    db.select({ botId: botTools.botId }).from(botTools).where(eq(botTools.toolKey, "workspace")),
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
    listOwnedMemberMcpConnections(p),
  ]);
  const workspaceBotIds = new Set(workspaceToolRows.map((row) => row.botId));
  const workspaceBots = accessibleBots.filter((bot) => workspaceBotIds.has(bot.id)).map((bot) => ({ id: bot.id, name: bot.name }));
  const savedTeamConnections = { ...teamConnections, connections: teamConnections.connections.filter(row => row.id !== undefined) };
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
        workspace={workspace}
        workspaceBots={workspaceBots}
        security={<SecurityPanel />}
        teamConnections={savedTeamConnections.connections.length > 0 ? <HermesTeamSavedConnections key={`${p.user.id}:${p.user.sessionVersion}`} initial={savedTeamConnections} /> : null}
        hermes={hermes || remotePolicy.enabled || remoteConnections.length > 0 ? <>{hermes}{(remotePolicy.enabled || remoteConnections.length > 0) && <RemoteHermes allowed={remotePolicy.enabled} initial={remoteConnections} />}</> : null}
      />
    </PageFrame>
  );
}
