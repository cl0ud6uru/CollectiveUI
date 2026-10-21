import { z } from "zod";

export const decisionsSettingsSchema = z.object({
  queenRouting: z.boolean().default(false),
  skillPicking: z.boolean().default(false),
  toolShortlisting: z.boolean().default(false),
  providerAppId: z.string().min(1).max(128).nullable().default(null),
  /** Budget applies to fixed gpt-6-luna, independently of the selected API connection's model. */
  contextWindowTokens: z.number().int().min(4_096).max(2_000_000).default(16_384),
  maxOutputTokens: z.number().int().min(64).max(1_000_000).default(1_024),
}).strict().superRefine((value, ctx) => {
  if (value.maxOutputTokens >= value.contextWindowTokens || value.contextWindowTokens - value.maxOutputTokens < 1_024) {
    ctx.addIssue({ code: "custom", path: ["maxOutputTokens"], message: "Leave at least 1,024 context tokens after the output reserve." });
  }
});
export type DecisionsSettings = z.infer<typeof decisionsSettingsSchema>;
export const DECISIONS_DEFAULTS: DecisionsSettings = {
  queenRouting: false, skillPicking: false, toolShortlisting: false, providerAppId: null,
  contextWindowTokens: 16_384, maxOutputTokens: 1_024,
};
export const DECISIONS_MODEL = "gpt-6-luna";
export const DECISIONS_CONTEXT_WINDOW_TOKENS = 16_384;
export const DECISIONS_OUTPUT_TOKENS = 1_024;
export const DECISIONS_BASE = "https://api.openai.com/v1";
export const DECISIONS_NOTICE = "Native CollectiveUI harness only. Local and remote Hermes are unsupported. Uses gpt-6-luna on the selected company OpenAI API connection, billed separately from ChatGPT plans. Sends the current request and allowed specialist, optional skill or optional MCP tool descriptions to OpenAI. Context and output limits below apply to gpt-6-luna and are independent of the connection's configured model. Each switch is independent; off sends no requests for that feature. Uncertain or unavailable results keep the normal behavior.";

export function decisionsCapability(app: { enabled: boolean; provider: string; credentialMode: string; baseUrl: string | null }): boolean {
  return app.enabled && app.provider === "openai" && app.credentialMode === "org" &&
    (!app.baseUrl || app.baseUrl.replace(/\/$/, "") === DECISIONS_BASE);
}
