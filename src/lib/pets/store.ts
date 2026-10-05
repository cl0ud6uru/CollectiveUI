import { and, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, type DbOrTx, type Tx } from "@/db";
import { auditLog, bots, botPets, botPetDefaults, petCatalog } from "@/db/schema";
import type { Principal } from "@/lib/auth/groups";
import { getEditableBot, getUsableBot, HttpError, listAccessibleBots } from "@/lib/authz";
import { lockEditableBot } from "@/lib/bots/service";
import { newId } from "@/lib/ids";
import { DEFAULT_PET, DEFAULT_PREFERENCES, HD_QUERY, type BotPetDefault, type PetManifest, type PetPreferences, type PetView } from "./shared";

import { canManagePetDefault, hasSharedPetIdentity, type PetBot } from "./policy";
import { assertPersonalPetAllowed, lockPetViewer } from "./authorization";

const columns = { botId: botPets.botId, mode: botPets.mode, appearance: botPets.appearance, catalogId: botPets.catalogId, motion: botPets.motion, custom: botPets.custom, revision: botPets.revision };
const scope = (p: Principal, botId: string) => and(eq(botPets.userId, p.user.id), eq(botPets.botId, botId));

/** Metadata only. The caller first resolves bot access; never read another person's private row. */
async function resolvePets(p: Principal, authorizedBots: PetBot[]): Promise<Record<string, PetView>> {
  const botIds = authorizedBots.map((bot) => bot.id);
  if (!botIds.length) return {};
  const [rows, defaults] = await Promise.all([
    db.select(columns).from(botPets).where(and(eq(botPets.userId, p.user.id), inArray(botPets.botId, botIds))),
    db.select({ botId: botPetDefaults.botId, appearance: botPetDefaults.appearance, catalogId: botPetDefaults.catalogId }).from(botPetDefaults).where(inArray(botPetDefaults.botId, botIds)),
  ]);
  const ids = [...new Set([...rows, ...defaults].flatMap((r) => r.catalogId ? [r.catalogId] : []))];
  const catalog = ids.length ? await db.select({ id: petCatalog.id, manifest: petCatalog.manifest, revision: petCatalog.revision, hd: sql<boolean>`${petCatalog.spriteHd} is not null` }).from(petCatalog).where(and(inArray(petCatalog.id, ids), eq(petCatalog.status, "published"))) : [];
  const assets = new Map(catalog.map((r) => [r.id, r]));
  const preferences = new Map(rows.map((r) => [r.botId, r]));
  const shared = new Map(defaults.map((r) => [r.botId, r]));
  return Object.fromEntries(authorizedBots.map((bot) => {
    const botId = bot.id;
    const sharedIdentity = hasSharedPetIdentity(bot);
    const row = preferences.get(botId);
    const preference: PetPreferences = row ? { mode: row.mode, appearance: row.appearance, catalogId: row.catalogId, motion: row.motion } : { ...DEFAULT_PREFERENCES };
    const def = shared.get(botId);
    const botDefault: BotPetDefault = def ? { appearance: def.appearance, catalogId: def.catalogId } : DEFAULT_PET.botDefault;
    const privateImport = row?.custom && row.revision ? { manifest: row.custom, revision: row.revision } : null;
    let effective: Pick<PetView, "appearance" | "custom" | "revision" | "enabled" | "source"> & { hd?: boolean } = { appearance: "moss", custom: null, revision: null, enabled: false, source: "none" };
    if (sharedIdentity || preference.mode !== "off") {
      if (botDefault.appearance === "moss" || botDefault.appearance === "ember") effective = { ...effective, appearance: botDefault.appearance, enabled: true, source: "default" };
      const defaultAsset = botDefault.catalogId && assets.get(botDefault.catalogId);
      if (defaultAsset) effective = { appearance: "catalog", custom: defaultAsset.manifest, revision: defaultAsset.revision, hd: defaultAsset.hd, enabled: true, source: "default" };
      if (!sharedIdentity && preference.mode === "personal") {
        if (preference.appearance === "moss" || preference.appearance === "ember") effective = { appearance: preference.appearance, custom: null, revision: null, enabled: true, source: "personal" };
        if (preference.appearance === "custom" && privateImport) effective = { appearance: "custom", custom: privateImport.manifest, revision: privateImport.revision, enabled: true, source: "personal" };
        const personalAsset = preference.catalogId && assets.get(preference.catalogId);
        if (personalAsset) effective = { appearance: "catalog", custom: personalAsset.manifest, revision: personalAsset.revision, hd: personalAsset.hd, enabled: true, source: "personal" };
      }
    }
    const { hd, ...shown } = effective;
    const avatarUrl = shown.revision && `/api/bots/${encodeURIComponent(botId)}/pet/avatar?v=${encodeURIComponent(shown.revision)}`;
    return [botId, { ...shown, motion: preference.motion, preference, privateImport, botDefault, sharedIdentity, canManageDefault: canManagePetDefault(p, bot), canPublish: p.isAdmin,
      spriteUrl: avatarUrl || null, spriteHdUrl: avatarUrl && hd ? `${avatarUrl}&${HD_QUERY}` : null } satisfies PetView];
  }));
}

export async function readPet(p: Principal, botId: string, editor = false): Promise<PetView> {
  const bot = editor ? await getEditableBot(p, botId) : await getUsableBot(p, botId);
  return (await resolvePets(p, [bot]))[botId];
}

/** Optional bots must come from this principal's server-side listAccessibleBots result. */
export async function readAccessiblePets(p: Principal, authorizedBots?: PetBot[]) {
  return resolvePets(p, authorizedBots ?? await listAccessibleBots(p));
}

export async function requirePublishedPet(q: DbOrTx, id: string | null) {
  const [asset] = id ? await q.select({ id: petCatalog.id }).from(petCatalog).where(and(eq(petCatalog.id, id), eq(petCatalog.status, "published"))).for("share") : [];
  if (!asset) throw new HttpError(400, "Choose a published catalog pet. This pet may have been unpublished.");
}

export async function savePet(p: Principal, botId: string, prefs: PetPreferences): Promise<PetView> {
  await db.transaction(async (tx) => {
    assertPersonalPetAllowed(await lockPetViewer(p, botId, tx));
    await tx.insert(botPets).values({ userId: p.user.id, botId }).onConflictDoNothing();
    const [current] = await tx.select(columns).from(botPets).where(scope(p, botId)).for("update");
    if (prefs.mode === "personal" && prefs.appearance === "custom" && !current.custom) throw new HttpError(400, "Import a pet first.");
    if (prefs.appearance === "catalog" && (prefs.mode === "personal" || prefs.catalogId !== current.catalogId || current.appearance !== "catalog")) await requirePublishedPet(tx, prefs.catalogId);
    await tx.update(botPets).set({ ...prefs, enabled: prefs.mode === "personal" }).where(scope(p, botId));
  });
  return readPet(p, botId);
}

export async function replacePet(p: Principal, botId: string, custom: PetManifest | null, sprite: Buffer | null): Promise<PetView> {
  await db.transaction(async (tx) => {
    assertPersonalPetAllowed(await lockPetViewer(p, botId, tx));
    await tx.insert(botPets).values({ userId: p.user.id, botId }).onConflictDoNothing();
    const [row] = await tx.select(columns).from(botPets).where(scope(p, botId)).for("update");
    // Import is an explicit personal selection. Removing an active import resets to the default.
    const selection = custom ? { mode: "personal" as const, appearance: "custom" as const, catalogId: null, enabled: true }
      : row.appearance === "custom" ? { mode: row.mode === "off" ? "off" as const : "follow" as const, appearance: "moss" as const, catalogId: null, enabled: false } : {};
    await tx.update(botPets).set({ ...selection, custom, sprite, revision: custom ? newId() : null }).where(scope(p, botId));
  });
  return readPet(p, botId);
}

/** Accessibility stays personal and never rewrites identity selections. */
export async function savePetMotion(p: Principal, botId: string, motion: PetPreferences["motion"]) {
  await db.transaction(async (tx) => {
    await lockPetViewer(p, botId, tx);
    await tx.insert(botPets).values({ userId: p.user.id, botId, motion }).onConflictDoUpdate({ target: [botPets.userId, botPets.botId], set: { motion } });
  });
  return readPet(p, botId);
}

/** Private import endpoint stays owner scoped even for administrators. */
export async function readPetSprite(p: Principal, botId: string, revision: string | null = null): Promise<Buffer> {
  await getUsableBot(p, botId);
  const [row] = await db.select({ sprite: botPets.sprite }).from(botPets).where(and(scope(p, botId), revision ? eq(botPets.revision, revision) : undefined));
  if (!row?.sprite) throw new HttpError(404, "Pet image not found.");
  return row.sprite;
}

/** `hd` reads the catalog HD rendition of the same effective revision. Private imports never have one. */
export async function readAvatarSprite(p: Principal, botId: string, revision: string | null, hd = false) {
  await getUsableBot(p, botId);
  if (!revision) throw new HttpError(404, "Pet image not found.");
  const personal = alias(petCatalog, "personal_pet");
  const shared = alias(petCatalog, "shared_pet");
  // One lookup returns only the effective bytes, never another user's row or an unused atlas.
  // Keep this priority identical to resolvePets; publication and the requested revision are checked here.
  const privateIdentity = sql`${bots.visibility} = 'private' and ${bots.executionMode} = 'caller'`;
  const disabled = sql`${privateIdentity} and (${botPets.mode} = 'off' or (${botPets.mode} = 'personal' and ${botPets.appearance} in ('moss', 'ember')))`;
  const custom = sql`${privateIdentity} and ${botPets.mode} = 'personal' and ${botPets.appearance} = 'custom' and ${botPets.custom} is not null and ${botPets.revision} is not null`;
  const selected = sql`${privateIdentity} and ${botPets.mode} = 'personal' and ${personal.id} is not null`;
  const effectiveRevision = sql`case when ${disabled} then null when ${custom} then ${botPets.revision} when ${selected} then ${personal.revision} else ${shared.revision} end`;
  const [row] = await db.select({ sprite: hd
    ? sql<Buffer | null>`case when (${disabled}) or (${custom}) then null when ${selected} then ${personal.spriteHd} else ${shared.spriteHd} end`
    : sql<Buffer | null>`case when ${disabled} then null when ${custom} then ${botPets.sprite} when ${selected} then ${personal.sprite} else ${shared.sprite} end` })
    .from(bots)
    .leftJoin(botPets, and(eq(botPets.botId, bots.id), eq(botPets.userId, p.user.id)))
    .leftJoin(botPetDefaults, eq(botPetDefaults.botId, bots.id))
    .leftJoin(personal, and(eq(personal.id, botPets.catalogId), eq(personal.status, "published")))
    .leftJoin(shared, and(eq(shared.id, botPetDefaults.catalogId), eq(shared.status, "published")))
    .where(and(eq(bots.id, botId), sql`${effectiveRevision} = ${revision}`));
  if (row?.sprite) return row.sprite;
  throw new HttpError(404, "Pet image not found.");
}

/** Called only after editor/create authorization inside this transaction. */
export async function writeBotPetDefault(tx: Tx, actorId: string, botId: string, choice: BotPetDefault) {
  if (choice.appearance === "catalog") await requirePublishedPet(tx, choice.catalogId);
  const values = { ...choice, updatedBy: actorId, updatedAt: new Date() };
  await tx.insert(botPetDefaults).values({ botId, ...values }).onConflictDoUpdate({ target: botPetDefaults.botId, set: values });
  await tx.insert(auditLog).values({ actorId, action: "pet.bot_default", target: botId, details: choice });
}

/** Only the bot-creation transaction calls this, after current creator authorization. */
export async function initializeBotPet(tx: Tx, p: Principal, bot: PetBot, choice: BotPetDefault) {
  if (hasSharedPetIdentity(bot)) return writeBotPetDefault(tx, p.user.id, bot.id, choice);
  if (choice.appearance === "catalog") await requirePublishedPet(tx, choice.catalogId);
  await tx.insert(botPets).values({ userId: p.user.id, botId: bot.id, mode: choice.appearance === "off" ? "off" : "personal",
    enabled: choice.appearance !== "off", appearance: choice.appearance === "off" ? "moss" : choice.appearance, catalogId: choice.catalogId });
}

export async function saveBotDefault(p: Principal, botId: string, choice: BotPetDefault) {
  await db.transaction(async (tx) => {
    await lockEditableBot(p, botId, tx, (fresh, bot) => {
      if (!canManagePetDefault(fresh, bot)) throw new HttpError(403, "Only an authorized bot owner or admin can change this pet.");
    });
    // Cosmetic identity is separate from capability configuration and grant revisions.
    await writeBotPetDefault(tx, p.user.id, botId, choice);
  });
}
