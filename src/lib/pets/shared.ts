import { z } from "zod";

export const PET_MAX_BYTES = 4 * 1024 * 1024;
export const MANIFEST_MAX_BYTES = 16 * 1024;
export const PET_WIDTH = 1536;
/**
 * Optional CollectiveUI rendition of a catalog pet at twice the v2 resolution (3072 × 4576, 384 × 416 cells). It is
 * never part of a Codex Pet v2 package: imports and exports stay standard, and anything without it uses the v2 sheet.
 */
export const PET_HD_SCALE = 2;
export const PET_HD_MAX_BYTES = 12 * 1024 * 1024;
export const petPreferencesSchema = z.object({
  mode: z.enum(["follow", "personal", "off"]),
  appearance: z.enum(["moss", "ember", "custom", "catalog"]),
  catalogId: z.string().min(1).max(100).nullable(),
  motion: z.enum(["auto", "still"]),
}).strict().refine((v) => (v.appearance === "catalog") === (v.catalogId !== null), "Choose a catalog pet.");
export const botDefaultSchema = z.object({
  appearance: z.enum(["moss", "ember", "catalog", "off"]),
  catalogId: z.string().min(1).max(100).nullable(),
}).strict().refine((v) => (v.appearance === "catalog") === (v.catalogId !== null), "Choose a catalog pet.");
export type BotPetDefault = z.infer<typeof botDefaultSchema>;
export type PetPreferences = z.infer<typeof petPreferencesSchema>;
export type PetManifest = { displayName: string; description: string; spriteVersionNumber: 1 | 2; credit: string };
export type CatalogPet = { id: string; manifest: PetManifest; revision: string; status: "draft" | "published" | "unpublished"; hd: boolean };
export type PetView = {
  enabled: boolean; appearance: PetPreferences["appearance"]; motion: PetPreferences["motion"];
  custom: PetManifest | null; revision: string | null; spriteUrl: string | null;
  /** The same atlas at PET_HD_SCALE. Only offered to the browser as a srcset candidate beside spriteUrl. */
  spriteHdUrl: string | null;
  preference: PetPreferences;
  privateImport: { manifest: PetManifest; revision: string } | null;
  botDefault: BotPetDefault;
  source: "personal" | "default" | "none";
  canManageDefault: boolean;
  sharedIdentity: boolean;
  canPublish: boolean;
};
export const DEFAULT_PREFERENCES: PetPreferences = { mode: "follow", appearance: "moss", catalogId: null, motion: "auto" };
export const DEFAULT_PET: PetView = { enabled: false, appearance: "moss", motion: "auto", custom: null, revision: null, spriteUrl: null, spriteHdUrl: null,
  preference: DEFAULT_PREFERENCES, privateImport: null, botDefault: { appearance: "off", catalogId: null }, source: "none", canManageDefault: false, sharedIdentity: false, canPublish: false };

/** Sprite routes serve the HD rendition only for this exact opt-in; anything else gets the v2 sheet. */
export const HD_QUERY = "size=2x";
export const wantsHdSprite = (url: string) => new URL(url).searchParams.get("size") === "2x";
export const catalogSpriteUrl = (id: string, revision: string, hd = false) => `/api/pets/catalog/${encodeURIComponent(id)}/sprite?v=${encodeURIComponent(revision)}${hd ? `&${HD_QUERY}` : ""}`;
export function catalogPreview(pet: CatalogPet): PetView {
  return { ...DEFAULT_PET, enabled: true, appearance: "catalog", custom: pet.manifest, revision: pet.revision,
    spriteUrl: catalogSpriteUrl(pet.id, pet.revision), spriteHdUrl: pet.hd ? catalogSpriteUrl(pet.id, pet.revision, true) : null };
}

export type PetState = "idle" | "working" | "approval" | "attention" | "unavailable";
export const PET_LABELS: Record<PetState, string> = {
  idle: "Idle in this chat",
  working: "Working in this chat",
  approval: "Waiting for your approval",
  attention: "This reply needs attention",
  unavailable: "Chat connection unavailable",
};

/** Current chat only. Never infer background runs or approval from elapsed time. */
export function petState(input: { status: string; approval: boolean; failed: boolean; online: boolean; unavailable: boolean }): PetState {
  if (!input.online || input.unavailable) return "unavailable";
  if (input.approval) return "approval";
  if (input.status === "submitted" || input.status === "streaming") return "working";
  if (input.failed || input.status === "error") return "attention";
  return "idle";
}

// Canonical Codex atlas rows; v2's extra look cells are intentionally not animated.
export const PET_FRAMES: Record<PetState, { row: number; frames: number; seconds: number }> = {
  idle: { row: 0, frames: 6, seconds: 1.2 },
  working: { row: 7, frames: 6, seconds: 0.9 },
  approval: { row: 6, frames: 6, seconds: 1.5 },
  attention: { row: 5, frames: 8, seconds: 1.5 },
  unavailable: { row: 0, frames: 1, seconds: 1 },
};
/** Codex atlas waving row. Only the sign-in companion plays it, as a reply to a click. */
export const PET_GREETING = { row: 3, frames: 4, seconds: 0.7 };
export type PetArtState = PetState | "greeting";
