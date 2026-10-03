import { createHash } from "node:crypto";
import type { ProviderConfigMap } from "../catalog";
import { requireSecret } from "./shared";
import type { ProviderImpl, ProviderInstance } from "./types";

// Provider instances keep google-auth-library's token cache, so reuse them across turns instead of minting a new
// Google access token on every call. Keyed by everything that affects them; small and bounded.
const cache = new Map<string, ProviderInstance>();
const MAX_CACHED = 32;

/**
 * Claude on Google Vertex AI. Credentials are always passed explicitly, so Application Default Credentials
 * (GOOGLE_APPLICATION_CREDENTIALS, gcloud, the metadata server) are never used. Only the service account's
 * email and private key are forwarded — never token_uri or other fields that could redirect the token request.
 */
export const vertexAnthropic: ProviderImpl = {
  async create(ctx) {
    const cfg = ctx.config as ProviderConfigMap["vertex-anthropic"];
    const sa = requireSecret(ctx, "service-account");
    const key = createHash("sha256")
      .update(JSON.stringify([ctx.appId, cfg.project, cfg.location, sa.clientEmail, sa.privateKey, !!ctx.fetch, !!ctx.generateAuthToken]))
      .digest("hex");
    const hit = ctx.fetch || ctx.generateAuthToken ? undefined : cache.get(key);
    if (hit) return hit;

    const { createGoogleVertexAnthropic } = await import("@ai-sdk/google-vertex/anthropic");
    const provider = createGoogleVertexAnthropic({
      project: cfg.project,
      location: cfg.location,
      googleAuthOptions: {
        credentials: { type: "service_account", client_email: sa.clientEmail, private_key: sa.privateKey },
        projectId: cfg.project,
      },
      ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
      ...(ctx.generateAuthToken ? { generateAuthToken: ctx.generateAuthToken } : {}),
    });
    const instance: ProviderInstance = { chat: (id) => provider(id) };
    if (!ctx.fetch && !ctx.generateAuthToken) {
      if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value!);
      cache.set(key, instance);
    }
    return instance;
  },
};
