import { z } from "zod";

export const decisionsSettingsSchema = z.object({
  queenRouting: z.boolean().default(false),
  skillPicking: z.boolean().default(false),
  providerAppId: z.string().min(1).max(128).nullable().default(null),
}).strict();
export type DecisionsSettings = z.infer<typeof decisionsSettingsSchema>;
export const DECISIONS_DEFAULTS: DecisionsSettings = { queenRouting: false, skillPicking: false, providerAppId: null };
export const DECISIONS_MODEL = "gpt-6-luna";
export const DECISIONS_BASE = "https://api.openai.com/v1";
export const DECISIONS_NOTICE = "Native CollectiveUI harness only. Local and remote Hermes are unsupported. Uses gpt-6-luna on the selected company OpenAI API connection, billed separately from ChatGPT plans. Sends the current request and allowed specialist or optional skill descriptions to OpenAI. Each switch is independent; off sends no requests for that feature. Uncertain or unavailable results keep the normal behavior.";

export function decisionsCapability(app: { enabled: boolean; provider: string; credentialMode: string; baseUrl: string | null }): boolean {
  return app.enabled && app.provider === "openai" && app.credentialMode === "org" &&
    (!app.baseUrl || app.baseUrl.replace(/\/$/, "") === DECISIONS_BASE);
}
