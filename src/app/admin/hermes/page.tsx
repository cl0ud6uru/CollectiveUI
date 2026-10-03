import { db } from "@/db";
import { aiApps, bots, hermesConnections, hermesProvisions, users } from "@/db/schema";
import { requireAdminPage } from "@/lib/session";
import { AdminHeader } from "@/components/admin/ui";
import { HermesAdmin } from "@/components/admin/hermes-admin";

export default async function HermesAdminPage() {
  await requireAdminPage();
  const [people, connections, profiles, apps, definitions] = await Promise.all([
    db.select({ id: users.id, name: users.name, upn: users.upn }).from(users),
    db.select({ id: hermesConnections.id, userId: hermesConnections.userId, boundaryId: hermesConnections.boundaryId, enabled: hermesConnections.enabled, quota: hermesConnections.quota }).from(hermesConnections),
    db.select({ id: hermesProvisions.id, userId: hermesProvisions.userId, botId: hermesProvisions.botId, profile: hermesProvisions.profile, status: hermesProvisions.status, attempts: hermesProvisions.attempts, error: hermesProvisions.error }).from(hermesProvisions),
    db.select({ id: aiApps.id, name: aiApps.name, providerConfig: aiApps.providerConfig }).from(aiApps),
    db.select({ id: bots.id, name: bots.name, appId: bots.appId }).from(bots),
  ]);
  return <div>
    <AdminHeader title="Automatic Hermes profiles" description="Private user runtimes with per-bot profiles. Hermes is always bot-only. Manual profile connections are under Connections → Agent backends." />
    <HermesAdmin users={people} connections={connections} profiles={profiles} templates={apps.filter((a) => a.providerConfig.managed !== undefined).map(({ id, name, providerConfig }) => ({ id, name, approvedBotId: typeof providerConfig.managedBotId === "string" ? providerConfig.managedBotId : null, candidates: definitions.filter((b) => b.appId === id).map(({ id, name }) => ({ id, name })) }))} />
  </div>;
}
