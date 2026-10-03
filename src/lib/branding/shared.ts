import { z } from "zod";

export const LOGO_MAX_BYTES = 2 * 1024 * 1024;
export const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"];
export const LOGIN_HEADLINE = "Good work starts with a conversation.";
export const LOGIN_DESCRIPTION = "A shared space for your ideas, your tools, and the bots that bring them together.";

export const BrandingInput = z.object({
  appName: z.string().trim().min(1, "Enter a portal name").max(60),
  welcomeText: z.string().trim().max(200),
  // An emoji, a bot-style "blob:<shape>:<color>" avatar, or empty for the portal mark.
  logoEmoji: z.string().trim().max(32),
  loginHeadline: z.string().trim().max(100).optional(),
  loginDescription: z.string().trim().max(240).optional(),
  defaultAppId: z.string().max(100).optional(),
  defaultBotId: z.string().max(100).optional(),
}).refine((v) => !(v.defaultAppId && v.defaultBotId), "Choose either a model or a bot to start new chats with.");

export type PublicBranding = {
  appName: string;
  logoEmoji: string;
  logoUrl: string | null;
  welcomeText: string;
  loginHeadline: string;
  loginDescription: string;
};

/** What the public sign-in page may know about its companion: built-in art, or one admin-confirmed catalog pet. */
export type PublicLoginPet =
  | { appearance: "off" | "moss" | "ember"; name: string }
  | { appearance: "catalog"; name: string; credit: string; spriteVersionNumber: 1 | 2; spriteUrl: string };
export const LOGIN_PET_NAMES = { off: "Portal bot", moss: "Moss", ember: "Ember" } as const;
export const loginPetSpriteUrl = (revision: string) => `/api/branding/login-pet?v=${encodeURIComponent(revision)}`;
