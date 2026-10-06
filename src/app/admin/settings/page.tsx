import { CoordinatorForm } from "@/components/admin/coordinator-form";
import { RemoteHermesSettingsCard } from "@/components/admin/remote-hermes-settings";
import { logoUrl } from "@/lib/branding/store";
import { and, count, eq, ne, or, isNull } from "drizzle-orm";
import { ChatGPTSettingsCard } from "@/components/admin/chatgpt-settings";
import { SettingsForm } from "@/components/admin/settings-form";
import { AdminHeader } from "@/components/admin/ui";
import { db } from "@/db";
import { aiApps, bots, groups, userCredentials } from "@/db/schema";
import { listCatalog } from "@/lib/pets/catalog";
import { requireAdminPage } from "@/lib/session";
import { getSetting } from "@/lib/settings";

export default async function AdminSettingsPage() {
  const p = await requireAdminPage();
  const remoteHermes = await getSetting('remoteHermes');
  const [branding, limits, apps, chatgpt, groupRows, [connections], logo, loginPet, petCatalog, sharedBots, coordinator, coordinatorBots, coordinatorModels] = await Promise.all([
    getSetting("branding"),
    getSetting("limits"),
    db.select({ id: aiApps.id, name: aiApps.name }).from(aiApps).where(and(eq(aiApps.enabled, true), eq(aiApps.kind, "model"), ne(aiApps.provider, "hermes"))),
    getSetting("chatgpt"),
    db.select({ id: groups.id, name: groups.name }).from(groups).orderBy(groups.name),
    db.select({ n: count() }).from(userCredentials).where(eq(userCredentials.provider, "chatgpt")),
    getSetting("brandingLogo"),
    getSetting("loginPet"),
    listCatalog(p),
    // Only bots everyone can use may be the organization's start target.
    db.select({ id: bots.id, name: bots.name }).from(bots).where(and(eq(bots.enabled, true), eq(bots.visibility, "org"))).orderBy(bots.name),
    getSetting("coordinator"),
    db.select({ id: bots.id, name: bots.name }).from(bots).leftJoin(aiApps, eq(aiApps.id, bots.appId)).where(and(
      eq(bots.enabled, true), eq(bots.executionMode, "caller"),
      or(isNull(bots.appId), and(eq(aiApps.enabled, true), ne(aiApps.provider, "hermes"), eq(aiApps.supportsTools, true))),
    )).orderBy(bots.name),
    db.select({ id: aiApps.id, name: aiApps.name }).from(aiApps).where(and(eq(aiApps.enabled, true), ne(aiApps.provider, "hermes"), eq(aiApps.supportsTools, true))).orderBy(aiApps.name),
  ]);
  return (
    <div>
      <AdminHeader title="Settings" />
      <div className="mb-6"><CoordinatorForm initial={coordinator} bots={coordinatorBots} models={coordinatorModels} /></div>
      <SettingsForm initialLogoUrl={logoUrl(logo.id)} branding={branding} limits={limits} apps={apps} bots={sharedBots} loginPet={loginPet} petCatalog={petCatalog} />
      <div className="mt-6"><RemoteHermesSettingsCard initial={remoteHermes} /></div>
      <div className="mt-6">
        <ChatGPTSettingsCard initial={chatgpt} groups={groupRows} connections={connections?.n ?? 0} />
      </div>
    </div>
  );
}
