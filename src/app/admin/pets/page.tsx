import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { aiApps, bots, botPetDefaults, providerConnections } from "@/db/schema";
import { requireAdminPage } from "@/lib/session";
import { listAdminCatalog } from "@/lib/pets/catalog";
import { PetsAdmin } from "@/components/admin/pets-admin";
import { hasSharedPetIdentity } from "@/lib/pets/policy";
import { getSetting } from "@/lib/settings";
import { OPENAI_DEFAULT_BASE_URL } from "@/lib/llm/providers/openai";
export default async function AdminPetsPage() {
  const p = await requireAdminPage();
  const [catalog, rows, generation, connections] = await Promise.all([
    listAdminCatalog(p),
    db.select({ id: bots.id, ownerId: bots.ownerId, name: bots.name, avatar: bots.avatar, enabled: bots.enabled, visibility: bots.visibility, executionMode: bots.executionMode, appearance: botPetDefaults.appearance, catalogId: botPetDefaults.catalogId }).from(bots).leftJoin(botPetDefaults, eq(botPetDefaults.botId, bots.id)).leftJoin(aiApps,eq(aiApps.id,bots.appId)).where(sql`${aiApps.providerConfig}->'docker' is null or ${bots.ownerId} = ${p.user.id}`).orderBy(asc(bots.name)),
    getSetting("petGeneration"),
    db.select({ id: providerConnections.id, name: providerConnections.name, provider: providerConnections.provider, baseUrl: providerConnections.baseUrl, enabled: providerConnections.enabled }).from(providerConnections).where(eq(providerConnections.enabled, true)),
  ]);
  return <PetsAdmin catalog={catalog} bots={rows.map((row) => ({ ...row, sharedIdentity: hasSharedPetIdentity(row), appearance: row.appearance ?? "off" }))}
    generation={{ settings: generation, connections: connections.filter(connection => connection.provider === "openai" && (connection.baseUrl === null || connection.baseUrl === OPENAI_DEFAULT_BASE_URL)) }} />;
}
