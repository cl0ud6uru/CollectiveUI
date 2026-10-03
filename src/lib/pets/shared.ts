import { z } from "zod";

export const PET_MAX_BYTES = 4 * 1024 * 1024;
export const MANIFEST_MAX_BYTES = 16 * 1024;
export const PET_WIDTH = 1536;
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
export type CatalogPet = { id: string; manifest: PetManifest; revision: string; status: "draft" | "published" | "unpublished" };
export type PetView = {
  enabled: boolean; appearance: PetPreferences["appearance"]; motion: PetPreferences["motion"];
  custom: PetManifest | null; revision: string | null; spriteUrl: string | null;
  preference: PetPreferences;
  privateImport: { manifest: PetManifest; revision: string } | null;
  botDefault: BotPetDefault;
  source: "personal" | "default" | "none";
  canManageDefault: boolean;
  sharedIdentity: boolean;
  canPublish: boolean;
};
export const DEFAULT_PREFERENCES: PetPreferences = { mode: "follow", appearance: "moss", catalogId: null, motion: "auto" };
export const DEFAULT_PET: PetView = { enabled: false, appearance: "moss", motion: "auto", custom: null, revision: null, spriteUrl: null,
  preference: DEFAULT_PREFERENCES, privateImport: null, botDefault: { appearance: "off", catalogId: null }, source: "none", canManageDefault: false, sharedIdentity: false, canPublish: false };

export const catalogSpriteUrl = (id: string, revision: string) => `/api/pets/catalog/${encodeURIComponent(id)}/sprite?v=${encodeURIComponent(revision)}`;
export function catalogPreview(pet: CatalogPet): PetView {
  return { ...DEFAULT_PET, enabled: true, appearance: "catalog", custom: pet.manifest, revision: pet.revision, spriteUrl: catalogSpriteUrl(pet.id, pet.revision) };
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
