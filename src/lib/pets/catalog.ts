import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, botPetDefaults, botPets, petCatalog } from "@/db/schema";
import { assertAdmin, getUsableBot, HttpError } from "@/lib/authz";
import type { Principal } from "@/lib/auth/groups";
import { assertFreshPetAdmin } from "./authorization";
import { validateV2Cells } from "./import";
import { isBundledPet } from "./policy";
import type { CatalogPet, PetManifest } from "./shared";

const columns = { id: petCatalog.id, manifest: petCatalog.manifest, revision: petCatalog.revision, status: petCatalog.status };
function requireSharingConfirmation(rights: unknown): asserts rights is "confirmed" {
  if (rights !== "confirmed") throw new HttpError(400, "Confirm you have permission to share this artwork with all signed-in users.");
}
const confirmation = (revision: string) => ({ rights: "confirmed", affirmationVersion: 1, audience: "signed-in users", revision });
export async function listCatalog(_p: Principal): Promise<CatalogPet[]> {
  void _p; // Authenticated principal is required even though published catalog visibility is organization-wide.
  return db.select(columns).from(petCatalog).where(eq(petCatalog.status, "published")).orderBy(desc(petCatalog.createdAt));
}
export async function listAdminCatalog(p: Principal) {
  assertAdmin(p);
  return db.select({ ...columns,
    defaultCount: sql<number>`(select count(*)::int from bot_pet_defaults where catalog_id = ${petCatalog.id})`,
    personalCount: sql<number>`(select count(*)::int from bot_pets p join bots b on b.id = p.bot_id where p.catalog_id = "pet_catalog"."id" and p.mode = 'personal' and b.visibility = 'private' and b.execution_mode = 'caller')`,
    preferenceCount: sql<number>`(select count(*)::int from bot_pets where catalog_id = ${petCatalog.id})`,
  }).from(petCatalog).orderBy(desc(petCatalog.createdAt)).then((rows) => rows.map((row) => ({ ...row, builtIn: isBundledPet(row.id) })));
}
export async function createCatalogPet(p: Principal, manifest: PetManifest, sprite: Buffer, rights: "confirmed") {
  assertAdmin(p);
  requireSharingConfirmation(rights);
  return db.transaction(async (tx) => {
    await assertFreshPetAdmin(p, tx);
    const [row] = await tx.insert(petCatalog).values({ createdBy: p.user.id, manifest, sprite }).returning(columns);
    await tx.insert(auditLog).values({ actorId: p.user.id, action: "pet.catalog_draft", target: row.id, details: confirmation(row.revision) });
    return row;
  });
}
/** Explicitly copy only the caller's own selected import. No user ID parameter or admin privacy bypass. */
export async function copyOwnImport(p: Principal, botId: string, revision: string, rights: "confirmed") {
  assertAdmin(p);
  requireSharingConfirmation(rights);
  await getUsableBot(p, botId);
  const [row] = await db.select({ custom: botPets.custom, sprite: botPets.sprite }).from(botPets).where(and(eq(botPets.userId, p.user.id), eq(botPets.botId, botId), eq(botPets.revision, revision), eq(botPets.appearance, "custom"), eq(botPets.mode, "personal")));
  if (!row?.custom || !row.sprite) throw new HttpError(409, "Select your own imported pet first, then try again.");
  // Legacy or pre-builder private rows never passed v2 cell validation; new catalog assets must.
  if (row.custom.spriteVersionNumber !== 2) throw new HttpError(409, "Legacy v1 imports can't be added to the catalog. Import a complete Codex Pet v2 sheet first.");
  await validateV2Cells(row.sprite);
  return createCatalogPet(p, row.custom, row.sprite, rights);
}
export async function setCatalogStatus(p: Principal, id: string, status: "published" | "unpublished", rights?: "confirmed") {
  assertAdmin(p);
  if (status === "published") requireSharingConfirmation(rights);
  return db.transaction(async (tx) => {
    const [row] = await tx.update(petCatalog).set({ status, updatedAt: new Date() }).where(eq(petCatalog.id, id)).returning(columns);
    if (!row) throw new HttpError(404, "Catalog pet not found.");
    await assertFreshPetAdmin(p, tx); // The UPDATE above acquired the asset lock; a denial rolls it back.
    if (status === "published" && row.manifest.spriteVersionNumber !== 2 && !isBundledPet(id)) {
      // Publication is only possible here, and it always writes this audit row in the same transaction. Legacy
      // built-ins were installed already published. Either proves an earlier publication; a v1 draft never had one.
      const [earlier] = await tx.select({ id: auditLog.id }).from(auditLog)
        .where(and(eq(auditLog.action, "pet.catalog_published"), eq(auditLog.target, id))).limit(1);
      if (!earlier) throw new HttpError(409, "Legacy v1 pets can't be published for the first time. Import a complete Codex Pet v2 sheet instead; v1 pets that were published before can still be republished.");
    }
    await tx.insert(auditLog).values({ actorId: p.user.id, action: `pet.catalog_${status}`, target: id,
      details: status === "published" ? confirmation(row.revision) : null });
    // References stay intact so republishing restores deliberate selections. Deletion is a separate, explicit route.
    return row;
  });
}
/**
 * Permanently removes an admin draft or unpublished pet. Published pets must be unpublished first, so nobody is
 * still seeing it; bundled pets are protected. References are reset in the same transaction rather than left
 * dangling: bot defaults fall back to the original icon and personal selections to following the bot default,
 * which is what those people have seen since it was unpublished.
 */
export async function deleteCatalogPet(p: Principal, id: string) {
  assertAdmin(p);
  if (isBundledPet(id)) throw new HttpError(409, "Built-in pets ship with CollectiveUI and can't be deleted. Unpublish it to hide it from everyone.");
  return db.transaction(async (tx) => {
    const [row] = await tx.select({ ...columns }).from(petCatalog).where(eq(petCatalog.id, id)).for("update");
    if (!row) throw new HttpError(404, "This pet was already deleted.");
    await assertFreshPetAdmin(p, tx); // The row lock above serializes with publication changes.
    if (row.status === "published") throw new HttpError(409, "Unpublish this pet before deleting it.");
    const defaults = await tx.update(botPetDefaults).set({ appearance: "off", catalogId: null, updatedBy: p.user.id, updatedAt: new Date() })
      .where(eq(botPetDefaults.catalogId, id)).returning({ botId: botPetDefaults.botId });
    const selections = await tx.update(botPets).set({
      mode: sql`case when ${botPets.mode} = 'personal' then 'follow' else ${botPets.mode} end`,
      enabled: false, appearance: "moss", catalogId: null,
    }).where(eq(botPets.catalogId, id)).returning({ botId: botPets.botId });
    await tx.delete(petCatalog).where(eq(petCatalog.id, id));
    await tx.insert(auditLog).values({ actorId: p.user.id, action: "pet.catalog_deleted", target: id, details: {
      displayName: row.manifest.displayName, revision: row.revision, status: row.status, defaultsReset: defaults.length, selectionsReset: selections.length,
    } });
    return { id, displayName: row.manifest.displayName, defaultsReset: defaults.length, selectionsReset: selections.length };
  });
}
export async function readCatalogSprite(p: Principal, id: string, revision: string | null) {
  const [row] = await db.select({ sprite: petCatalog.sprite }).from(petCatalog).where(and(eq(petCatalog.id, id), p.isAdmin ? undefined : eq(petCatalog.status, "published"), revision ? eq(petCatalog.revision, revision) : undefined));
  if (!row) throw new HttpError(404, "Catalog pet not found.");
  return row.sprite;
}
