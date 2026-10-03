import { ProviderConfigError } from "../errors";
import type { ApiKeySecret, AppSecret } from "../secrets";
import type { ProviderContext } from "./types";

/**
 * Production fetch for providers that send their key in a custom header (x-api-key / api-key): refuses
 * redirects, because fetch only strips Authorization and Cookie on cross-origin redirects.
 */
export function noRedirectFetch(ctx: ProviderContext): typeof fetch {
  const base = ctx.fetch ?? globalThis.fetch;
  return (input, init) => base(input, { ...init, redirect: "error" });
}

export function requireSecret<T extends AppSecret["type"]>(ctx: ProviderContext, type: T): Extract<AppSecret, { type: T }> {
  const s = ctx.secret;
  if (!s) throw new ProviderConfigError(ctx.appName, `${ctx.kind}: no credentials stored`);
  if (s.type !== type) throw new ProviderConfigError(ctx.appName, `${ctx.kind}: stored credentials have the wrong shape`);
  return s as Extract<AppSecret, { type: T }>;
}

export const apiKeyOf = (ctx: ProviderContext) => (requireSecret(ctx, "api-key") as ApiKeySecret).apiKey;
