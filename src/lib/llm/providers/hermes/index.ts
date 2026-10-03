/**
 * Hermes Agent profiles (docs/architecture/hermes.md). Models are built per turn by resolveModel, which knows the
 * conversation, the person and whether they can answer approvals; the registry entry below only serves generic
 * callers (a one-off run with no conversation and approvals denied).
 */
import type { ProviderConfigMap } from "../../catalog";
import type { ProviderContext, ProviderImpl } from "../types";
import type { HermesTarget } from "./client";
import { HermesLanguageModel } from "./model";

export { checkHermes, checkHermesUrl, HermesError, stopRun, type HermesTarget } from "./client";
export { HermesLanguageModel, type HermesTurnContext } from "./model";
export { closeAllParked, dropParkedForAgentRun } from "./runs";

export function hermesTarget(ctx: ProviderContext): HermesTarget {
  const cfg = ctx.config as ProviderConfigMap["hermes"];
  const apiKey = ctx.secret?.type === "api-key" ? ctx.secret.apiKey : "";
  return { baseUrl: ctx.baseUrl ?? "", profile: cfg.profile ?? "", apiKey, fetch: ctx.fetch };
}

export const hermes: ProviderImpl = {
  async create(ctx) {
    const cfg = ctx.config as ProviderConfigMap["hermes"];
    return {
      chat: (modelId) =>
        new HermesLanguageModel(modelId, { target: hermesTarget(ctx), sessionId: null, sessionKey: null, interactive: false, approvalTimeoutSec: cfg.approvalTimeoutSec }),
    };
  },
};
