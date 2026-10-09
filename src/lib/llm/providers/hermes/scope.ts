import { createHash } from "node:crypto";
import type { AiApp } from "@/db/schema";
import { readProviderConfig } from "@/lib/llm/catalog";

/** Server-only binding: a profile, endpoint or credential change invalidates previously recorded upstream ids. */
export function hermesTargetKey(app: Pick<AiApp, "id" | "providerConfig" | "baseUrl" | "apiKeyEnc">): string {
  const config = readProviderConfig("hermes", app.providerConfig);
  const identity: unknown[] = [app.id, app.baseUrl, config?.profile ?? "", app.apiKeyEnc];
  if (app.providerConfig.managed !== undefined) identity.push(app.providerConfig.managed);
  if (app.providerConfig.docker !== undefined) identity.push(app.providerConfig.docker);
  if (app.providerConfig.local !== undefined) identity.push(app.providerConfig.local);
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

export function allowedHermesModels(app: Pick<AiApp, "providerConfig">): string[] {
  return [...new Set((readProviderConfig("hermes", app.providerConfig)?.allowedModels ?? "").split(/[,\s]+/).filter(Boolean))];
}

export type HermesRunContext = { targetKey: string; model: string | null; provisionId?: string | null };

/** The caller-supplied Runs identity, shared by inference and session controls. */
export const hermesSessionId = (conversationId: string, botId?: string | null) =>
  `portal-${conversationId}${botId ? `-${botId}` : ""}`;
