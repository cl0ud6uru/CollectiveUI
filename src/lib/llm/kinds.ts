// Dependency-free constants shared by the DB schema, the catalog (client-safe) and the registry.

/**
 * Model provider wire protocols an app can use. "chatgpt" runs on each user's own ChatGPT plan ("Sign in with ChatGPT");
 * "hermes" is a profile on a Hermes Agent server, which runs its own tools and model (docs/architecture/hermes.md).
 */
export const PROVIDER_KINDS = ["openai-compatible", "openai", "azure", "anthropic", "bedrock", "vertex-anthropic", "chatgpt", "hermes"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/** "runtime" apps (Codex / Claude Code in a sandbox) arrive in a later phase. */
export const APP_KINDS = ["model", "runtime"] as const;
export type AppKind = (typeof APP_KINDS)[number];

/** Whose credentials an app uses: "org" = company keys; "user" = the chatting user's own connection (ChatGPT plans). */
export const CREDENTIAL_MODES = ["org", "user", "user_or_org"] as const;
export type CredentialMode = (typeof CREDENTIAL_MODES)[number];

/** Why a model is called. Background purposes (title, memory, draft, embedding) always run on org credentials. */
export const MODEL_PURPOSES = ["chat", "group", "delegate", "title", "memory", "draft", "embedding"] as const;
export type ModelPurpose = (typeof MODEL_PURPOSES)[number];

/**
 * Who pays for a call. "org" = company credentials; "chatgpt_plan" = the user's own ChatGPT plan (Codex limits);
 * "hermes" = whatever model access the Hermes server is configured with (its own keys or subscription).
 */
export const BILLING_SOURCES = ["org", "chatgpt_plan", "hermes"] as const;
export type BillingSource = (typeof BILLING_SOURCES)[number];

/** Services a user can connect their own account for. */
export const USER_CREDENTIAL_PROVIDERS = ["chatgpt"] as const;
export type UserCredentialProvider = (typeof USER_CREDENTIAL_PROVIDERS)[number];

/** active = usable; needs_reauth = the sign-in expired or was revoked upstream (the user must reconnect). */
export const USER_CREDENTIAL_STATUSES = ["active", "needs_reauth"] as const;
export type UserCredentialStatus = (typeof USER_CREDENTIAL_STATUSES)[number];
