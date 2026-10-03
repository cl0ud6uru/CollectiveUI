import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { aiApps, bots, botPetDefaults } from "@/db/schema";
import { requireAdminPage } from "@/lib/session";
import { listAdminCatalog } from "@/lib/pets/catalog";
import { PetsAdmin } from "@/components/admin/pets-admin";
import { hasSharedPetIdentity } from "@/lib/pets/policy";
export default async function AdminPetsPage() {
  const p = await requireAdminPage();
  const [catalog, rows] = await Promise.all([
    listAdminCatalog(p),
    db.select({ id: bots.id, ownerId: bots.ownerId, name: bots.name, avatar: bots.avatar, enabled: bots.enabled, visibility: bots.visibility, executionMode: bots.executionMode, appearance: botPetDefaults.appearance, catalogId: botPetDefaults.catalogId }).from(bots).leftJoin(botPetDefaults, eq(botPetDefaults.botId, bots.id)).leftJoin(aiApps,eq(aiApps.id,bots.appId)).where(sql`${aiApps.providerConfig}->'docker' is null or ${bots.ownerId} = ${p.user.id}`).orderBy(asc(bots.name)),
  ]);
  return <PetsAdmin catalog={catalog} bots={rows.map((row) => ({ ...row, sharedIdentity: hasSharedPetIdentity(row), appearance: row.appearance ?? "off" }))} />;
}
