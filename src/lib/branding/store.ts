import "server-only";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, settings } from "@/db/schema";
import { storage } from "@/lib/files/storage";
import { getSetting } from "@/lib/settings";
import { LOGIN_DESCRIPTION, LOGIN_HEADLINE, type PublicBranding } from "./shared";

// Only generated identifiers can address the dedicated public-logo namespace.
export function logoKey(id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) throw new Error("Invalid logo id");
  return `branding/${id}.png`;
}

export function logoUrl(id: string | null) {
  return id ? `/api/branding/logo?v=${encodeURIComponent(id)}` : null;
}

/** Explicit public projection: no app selection, storage paths, credentials, or other settings. */
export async function getPublicBranding(): Promise<PublicBranding> {
  const [branding, logo] = await Promise.all([getSetting("branding"), getSetting("brandingLogo")]);
  return {
    appName: branding.appName,
    logoEmoji: branding.logoEmoji,
    logoUrl: logoUrl(logo.id),
    welcomeText: branding.welcomeText,
    loginHeadline: branding.loginHeadline || LOGIN_HEADLINE,
    loginDescription: branding.loginDescription || LOGIN_DESCRIPTION,
  };
}

/** Serialize swaps across processes. A failed write leaves the previous logo active. */
export async function replaceLogo(actorId: string, png: Buffer | null): Promise<string | null> {
  const id = png ? randomUUID() : null;
  if (id && png) await storage().put(logoKey(id), png);
  let previous: string | null = null;
  try {
    await db.transaction(async (tx) => {
      await tx.insert(settings).values({ key: "brandingLogo", value: { id: null } }).onConflictDoNothing();
      const [row] = await tx.select().from(settings).where(eq(settings.key, "brandingLogo")).for("update");
      previous = (row.value as { id: string | null }).id;
      await tx.update(settings).set({ value: { id }, updatedAt: new Date() }).where(eq(settings.key, "brandingLogo"));
      await tx.insert(auditLog).values({ actorId, action: id ? "settings.logo.upload" : "settings.logo.remove", details: { id } });
    });
  } catch (err) {
    if (id) await storage().delete(logoKey(id));
    throw err;
  }
  // The pointer is committed before cleanup; old bytes are never addressable by the public route.
  if (previous) await storage().delete(logoKey(previous));
  return logoUrl(id);
}
