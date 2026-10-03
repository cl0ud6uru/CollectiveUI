/**
 * Pure logic behind the admin Apps form: validation, base URL normalization and the credential rules.
 * Kept separate from the server actions so the rules are unit-testable.
 *
 * Credential rule: a stored secret is reused (blank credential fields) only when the app still points at the same
 * place — same provider, same base-URL origin, same Bedrock auth/region, same Vertex project. Otherwise the admin
 * must re-enter it, so a write-only key can never be redirected to a new endpoint.
 */
import type { AiApp } from "@/db/schema";
import { HttpError } from "@/lib/authz";
import {
  CATALOG,
  normalizeBaseUrl,
  readProviderConfig,
  type AnyProviderConfig,
  type ChatGPTAppConfig,
  type CredentialsInput,
  type EnabledKind,
  type ParsedAppInput,
} from "./catalog";
import { credentialTarget, decodeSecret, encodeSecretInput, openAppSecret, SecretError, type AppSecret } from "./secrets";

type StoredApp = Pick<AiApp, "id" | "provider" | "providerConfig" | "baseUrl" | "apiKeyEnc">;

const CLEAR = "__clear__";

/**
 * ChatGPT plan apps can only be created (or an app switched to one) while an admin has Sign in with ChatGPT turned
 * on. Existing ones stay editable, e.g. to disable them after the feature was turned off.
 */
export function assertCreatableProvider(provider: unknown, opts: { chatgptEnabled: boolean; existingProvider?: string }) {
  if (provider === "chatgpt" && opts.existingProvider !== "chatgpt" && !opts.chatgptEnabled) {
    throw new HttpError(400, "Turn on Sign in with ChatGPT under Admin → Settings first.");
  }
}

function normalizedBaseUrl(kind: EnabledKind, raw: string | null | undefined): string | null {
  const r = normalizeBaseUrl(kind, raw);
  if (!r.ok) throw new HttpError(400, r.error);
  return r.value;
}

function encode(kind: EnabledKind, config: AnyProviderConfig, credentials: CredentialsInput): string | null {
  try {
    return encodeSecretInput(kind, config, credentials);
  } catch (err) {
    if (err instanceof SecretError) throw new HttpError(400, err.message);
    throw err;
  }
}

/** Whether the stored credential of `existing` may be reused for an app configured like this. */
export function canReuseStoredSecret(existing: StoredApp | undefined, kind: EnabledKind, baseUrl: string | null, config: AnyProviderConfig): boolean {
  if (!existing?.apiKeyEnc) return false;
  return credentialTarget(existing.provider, existing.baseUrl, existing.providerConfig) === credentialTarget(kind, baseUrl, config);
}

export type AppWrite = {
  baseUrl: string | null;
  providerConfig: AnyProviderConfig | ChatGPTAppConfig;
  /** undefined = leave the stored secret as it is; null = remove it; string = new plaintext to seal. */
  secret: string | null | undefined;
};

/** Validates a save and decides what happens to the stored credential. Throws HttpError(400) with a friendly message. */
export function planAppWrite(input: ParsedAppInput, existing: StoredApp | undefined): AppWrite {
  // A ChatGPT app has no credentials or endpoint of its own; any stored company key is removed.
  if (input.provider === "chatgpt") return { baseUrl: null, providerConfig: input.config, secret: existing?.apiKeyEnc ? null : undefined };
  const kind = input.provider;
  const config = input.config as AnyProviderConfig;
  const baseUrl = normalizedBaseUrl(kind, input.baseUrl);

  if (kind === "openai-compatible" && input.credentials.apiKey?.trim() === CLEAR) return { baseUrl, providerConfig: config, secret: null };
  const entered = encode(kind, config, input.credentials);
  if (entered) return { baseUrl, providerConfig: config, secret: entered };

  if (canReuseStoredSecret(existing, kind, baseUrl, config)) return { baseUrl, providerConfig: config, secret: undefined };
  if (existing?.apiKeyEnc) {
    // Pointing a stored key at a different endpoint or provider requires re-entering it.
    throw new HttpError(400, `Re-enter the credentials: the endpoint or provider changed (${CATALOG[kind].label}).`);
  }
  if (kind !== "openai-compatible") throw new HttpError(400, `Enter the credentials for ${CATALOG[kind].label}.`);
  return { baseUrl, providerConfig: config, secret: null };
}

export type ConnectionTestPlan = { baseUrl: string | null; config: AnyProviderConfig; secret: AppSecret | undefined };

/** Resolves what "Test connection" should use: entered credentials, or the stored ones under the reuse rule. */
export function planConnectionTest(
  kind: EnabledKind,
  rawConfig: unknown,
  rawBaseUrl: string | null | undefined,
  credentials: CredentialsInput,
  existing: StoredApp | undefined,
): ConnectionTestPlan {
  const config = readProviderConfig(kind, rawConfig);
  if (!config) throw new HttpError(400, "Fill in the provider settings first.");
  const baseUrl = normalizedBaseUrl(kind, rawBaseUrl);
  const entered = encode(kind, config, credentials);
  let plaintext: string | undefined = entered ?? undefined;
  if (!plaintext && canReuseStoredSecret(existing, kind, baseUrl, config)) plaintext = openAppSecret(existing!);
  if (!plaintext) {
    if (kind === "openai-compatible") return { baseUrl, config, secret: undefined };
    throw new HttpError(400, existing?.apiKeyEnc ? "Re-enter the credentials to test the new endpoint." : "Enter the credentials to test.");
  }
  try {
    return { baseUrl, config, secret: decodeSecret(kind, config, plaintext) };
  } catch (err) {
    if (err instanceof SecretError) throw new HttpError(400, err.message);
    throw err;
  }
}
