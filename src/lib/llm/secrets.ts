/**
 * Legacy model-specific credentials in ai_apps.api_key_enc, encrypted and bound to the app row (AAD).
 * Reusable OpenAI API credentials live in provider_connections (see provider-connections.ts).
 * Plaintext formats:
 *  - API-key providers (and Bedrock in API-key mode): the key itself, exactly as before this module existed.
 *  - Bedrock with IAM access keys: {"v":1,"accessKeyId","secretAccessKey","sessionToken"?}
 *  - Vertex AI: {"v":1,"serviceAccount":{"client_email","private_key","private_key_id"?}}
 */
import { AAD, decrypt, encrypt } from "@/lib/crypto";
import { CLAUDE_AI_TOKEN, type AnyProviderConfig, type CredentialsInput, type EnabledKind } from "./catalog";

export type ApiKeySecret = { type: "api-key"; apiKey: string };
export type AwsKeysSecret = { type: "aws-keys"; accessKeyId: string; secretAccessKey: string; sessionToken?: string };
export type ServiceAccountSecret = { type: "service-account"; clientEmail: string; privateKey: string; privateKeyId?: string };
export type AppSecret = ApiKeySecret | AwsKeysSecret | ServiceAccountSecret;

/** Thrown for bad credentials input or stored values. The message never contains any part of the secret. */
export class SecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretError";
  }
}

export const appSecretAad = (appId: string) => `${AAD.appApiKey}|${appId}`;

export function sealAppSecret(appId: string, plaintext: string): string {
  return encrypt(plaintext, appSecretAad(appId));
}

/** Decrypts an app secret. Values written before row binding used the column-only AAD. */
export function openAppSecret(app: { id: string; apiKeyEnc: string | null }): string | undefined {
  if (!app.apiKeyEnc) return undefined;
  try {
    return decrypt(app.apiKeyEnc, appSecretAad(app.id));
  } catch {
    return decrypt(app.apiKeyEnc, AAD.appApiKey);
  }
}

/** True when the stored value isn't yet bound to its row (legacy or column-only AAD) and should be re-encrypted. */
export function appSecretNeedsRowBinding(app: { id: string; apiKeyEnc: string | null }): boolean {
  if (!app.apiKeyEnc) return false;
  try {
    decrypt(app.apiKeyEnc, appSecretAad(app.id));
    return !app.apiKeyEnc.startsWith("v2.");
  } catch {
    return true;
  }
}

function assertNoClaudeToken(...values: (string | undefined)[]) {
  if (values.some((v) => v && CLAUDE_AI_TOKEN.test(v))) {
    throw new SecretError("Claude.ai sign-in tokens can't be used here. Use an Anthropic API key from the Claude Console.");
  }
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Never surface JSON.parse's message: it quotes part of the input.
    throw new SecretError(`${what} is not valid JSON`);
  }
}

function serviceAccountFrom(json: unknown): ServiceAccountSecret {
  const sa = (json ?? {}) as Record<string, unknown>;
  if (sa.type !== "service_account") throw new SecretError('The key must be a service account key ("type": "service_account")');
  const email = typeof sa.client_email === "string" ? sa.client_email : "";
  const key = typeof sa.private_key === "string" ? sa.private_key : "";
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new SecretError("The service account key has no valid client_email");
  if (!key.includes("-----BEGIN PRIVATE KEY-----")) throw new SecretError("The service account key has no private_key");
  return {
    type: "service-account",
    clientEmail: email,
    privateKey: key,
    privateKeyId: typeof sa.private_key_id === "string" ? sa.private_key_id : undefined,
  };
}

/** Which secret shape a provider (and its config) needs. */
export function secretTypeFor(kind: EnabledKind, config: AnyProviderConfig): AppSecret["type"] {
  if (kind === "vertex-anthropic") return "service-account";
  if (kind === "bedrock" && (config as { auth?: string }).auth === "access-keys") return "aws-keys";
  return "api-key";
}

/** Builds the plaintext to store from form input. Returns null when no credential was entered. */
export function encodeSecretInput(kind: EnabledKind, config: AnyProviderConfig, input: CredentialsInput): string | null {
  const type = secretTypeFor(kind, config);
  const trim = (v?: string) => v?.trim() || undefined;
  if (type === "api-key") {
    const apiKey = trim(input.apiKey);
    if (!apiKey) return null;
    assertNoClaudeToken(apiKey);
    if (kind === "bedrock" && apiKey.length < 20) throw new SecretError("That doesn't look like a Bedrock API key");
    return apiKey;
  }
  if (type === "aws-keys") {
    const accessKeyId = trim(input.accessKeyId);
    const secretAccessKey = trim(input.secretAccessKey);
    const sessionToken = trim(input.sessionToken);
    if (!accessKeyId && !secretAccessKey && !sessionToken) return null;
    if (!accessKeyId || !secretAccessKey) throw new SecretError("Enter both the access key ID and the secret access key");
    return JSON.stringify({ v: 1, accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) });
  }
  const raw = trim(input.serviceAccountJson);
  if (!raw) return null;
  const sa = serviceAccountFrom(parseJson(raw, "The service account key"));
  return JSON.stringify({ v: 1, serviceAccount: { client_email: sa.clientEmail, private_key: sa.privateKey, private_key_id: sa.privateKeyId } });
}

/** Decodes a stored plaintext into the shape the provider needs. Throws SecretError when it doesn't fit. */
export function decodeSecret(kind: EnabledKind, config: AnyProviderConfig, plaintext: string): AppSecret {
  assertNoClaudeToken(plaintext);
  const type = secretTypeFor(kind, config);
  const structured = plaintext.startsWith('{"v":');
  if (type === "api-key") {
    if (structured) throw new SecretError("The stored credential doesn't match this provider; enter an API key");
    return { type, apiKey: plaintext };
  }
  if (!structured) throw new SecretError("The stored credential doesn't match this provider; enter new credentials");
  const obj = parseJson(plaintext, "The stored credential") as Record<string, unknown>;
  if (type === "aws-keys") {
    if (typeof obj.accessKeyId !== "string" || typeof obj.secretAccessKey !== "string") {
      throw new SecretError("The stored credential doesn't match this provider; enter new credentials");
    }
    return {
      type,
      accessKeyId: obj.accessKeyId,
      secretAccessKey: obj.secretAccessKey,
      sessionToken: typeof obj.sessionToken === "string" ? obj.sessionToken : undefined,
    };
  }
  return serviceAccountFrom({ type: "service_account", ...(obj.serviceAccount as object) });
}

/** Normalized origin used to decide whether a stored credential may be reused (null = the vendor default). */
export function credentialTarget(kind: string, baseUrl: string | null, config: AnyProviderConfig | Record<string, unknown>): string {
  const auth = kind === "bedrock" ? String((config as { auth?: string }).auth ?? "api-key") : "";
  let origin = "";
  if (baseUrl) {
    try {
      origin = new URL(baseUrl).origin;
    } catch {
      origin = baseUrl;
    }
  }
  const region = kind === "bedrock" ? String((config as { region?: string }).region ?? "") : "";
  const project = kind === "vertex-anthropic" ? String((config as { project?: string }).project ?? "") : "";
  // Hermes keys belong to one profile.
  const profile = kind === "hermes" ? String((config as { profile?: string }).profile ?? "") : "";
  return [kind, origin, auth, region, project, profile].join("|");
}
