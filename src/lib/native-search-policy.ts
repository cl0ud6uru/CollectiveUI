import { z } from "zod";
import type { AiApp, ApprovalMode } from "@/db/schema";
import type { ToolSettings } from "@/lib/settings";

export const NATIVE_SEARCH_KEY = "openai_web_search";
export type NativeSearchMode = "off" | "auto";
export const SEARCH_CALL_MICROS = 10_000;
export const SEARCH_COST_NOTICE = "About $0.01 per search plus search-content tokens at model rates (GPT-4.1 mini: 8,000 input tokens per search). Uses OpenAI API billing, separate from ChatGPT subscriptions. Final charges come from OpenAI.";
export const nativeSearchSettingsSchema = z.object({
  enabled: z.boolean(),
  maxCalls: z.number().int().min(1).max(10),
  allowedDomains: z.array(z.string().trim().toLowerCase().regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*$/, "Use domain names without a scheme, path, port or wildcard")).max(100),
});
export type NativeSearchSettings = z.infer<typeof nativeSearchSettingsSchema>;
export const NATIVE_SEARCH_DEFAULTS: NativeSearchSettings = { enabled: false, maxCalls: 2, allowedDomains: [] };

// Deliberately finite: no inference from model prefixes, aliases, Azure deployments or future models.
// Verified against the Responses web-search guide and each model's Tools section, 2026-10-05.
// https://developers.openai.com/api/docs/models/<model-id> — add snapshots only after verification.
export const NATIVE_SEARCH_MODELS = [
  "gpt-4.1", "gpt-4.1-mini", "gpt-5", "gpt-5.4", "gpt-5.5",
  "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol",
  "gpt-6-luna", "gpt-6-sol", "gpt-6.1-sol", "gpt-6-astra",
] as const;
const MODELS = new Set<string>(NATIVE_SEARCH_MODELS);
export function nativeSearchCapability(app: Pick<AiApp, "provider" | "credentialMode" | "supportsTools" | "model">, baseUrl: string | null | undefined): string | null {
  if (app.provider !== "openai" || app.credentialMode !== "org") return "Requires an official OpenAI API connection. Azure, compatible endpoints, ChatGPT plans and Hermes are not supported.";
  if (baseUrl && baseUrl !== "https://api.openai.com/v1" && baseUrl !== "https://api.openai.com/v1/") return "Native search is unavailable on custom endpoints.";
  if (!app.supportsTools || !MODELS.has(app.model)) return "Native search is not verified for this model. Choose a supported OpenAI API model.";
  return null;
}

/** Hosted execution cannot use local tool approval or DNS/fetch enforcement. Fail closed before dispatch. */
export function nativeSearchPolicy(settings: ToolSettings, approval: ApprovalMode = "auto"): string | null {
  const parsed = nativeSearchSettingsSchema.safeParse(settings.nativeSearch);
  if (!parsed.success || !parsed.data.enabled) return "OpenAI native search is disabled by your administrator.";
  const keys = [NATIVE_SEARCH_KEY, "web_search", "fetch_url"];
  if (keys.some(k => settings.disabledTools.includes(k))) return "Web search or page access is disabled by your administrator.";
  if (approval === "ask" || keys.some(k => settings.enforcedApproval.includes(k))) return "Native search runs on OpenAI servers and cannot pause for per-call approval. Use a search tool that supports your approval policy.";
  if (settings.fetchAllowlist.length) return "Native search cannot enforce the local web-page allowlist. Ask an administrator to review the hosted-search domain policy.";
  return null;
}
