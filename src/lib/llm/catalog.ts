/**
 * Provider catalog: what each kind of model provider needs (config, credentials, base URL rules) and how the admin
 * form shows it. Client-safe on purpose: this file imports only zod and ./kinds, so admin components can use it.
 * Everything that talks to a network or holds a secret lives in the server-only modules next to it.
 */
import { z } from "zod";
import { type ProviderKind } from "./kinds";

/** Kinds that run on company credentials: an admin enters the key or service account (for Hermes, a profile's API key). */
export const ENABLED_KINDS = ["openai-compatible", "openai", "azure", "anthropic", "bedrock", "vertex-anthropic", "hermes"] as const;
export type EnabledKind = (typeof ENABLED_KINDS)[number];
export const isEnabledKind = (k: string): k is EnabledKind => (ENABLED_KINDS as readonly string[]).includes(k);

/** Every kind an admin can create an app for. "chatgpt" apps run on each person's own ChatGPT plan. */
export const APP_PROVIDERS = [...ENABLED_KINDS, "chatgpt"] as const;
export type AppProvider = (typeof APP_PROVIDERS)[number];
export const isAppProvider = (k: string): k is AppProvider => (APP_PROVIDERS as readonly string[]).includes(k);

// ---------------------------------------------------------------------------
// Non-secret configuration (stored in ai_apps.provider_config)
// ---------------------------------------------------------------------------

const AWS_REGION = /^[a-z]{2}(-gov|-iso[a-z]?)?-[a-z]+-\d$/;
const GCP_PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const GCP_LOCATION = /^(global|us|eu|[a-z]+-[a-z]+\d+)$/;

const reasoning = z.boolean().default(false);
const promptCaching = z.boolean().default(true);
const store = z.boolean().default(false);

export const CONFIG_SCHEMAS = {
  "openai-compatible": z.object({}),
  openai: z.object({
    organization: z.string().trim().max(100).optional(),
    project: z.string().trim().max(100).optional(),
    store,
    reasoning,
  }),
  azure: z.object({ store, reasoning }),
  anthropic: z.object({ reasoning, promptCaching }),
  bedrock: z.object({
    region: z.string().trim().regex(AWS_REGION, "Use an AWS region such as us-east-1"),
    api: z.enum(["auto", "anthropic", "converse"]).default("auto"),
    auth: z.enum(["api-key", "access-keys"]).default("api-key"),
    reasoning,
    promptCaching,
  }),
  "vertex-anthropic": z.object({
    project: z.string().trim().regex(GCP_PROJECT, "Use a Google Cloud project id"),
    location: z.string().trim().regex(GCP_LOCATION, "Use a Vertex AI location such as global or us-east5").default("global"),
    reasoning,
    promptCaching,
  }),
  hermes: z.object({
    /** The Hermes profile (served at /p/<profile>/); blank = the server's default profile. */
    profile: z
      .string()
      .trim()
      .max(64)
      .regex(/^([a-z0-9][a-z0-9_-]*)?$/, "Use the profile's name as Hermes shows it (lowercase letters, digits, - and _)")
      .default(""),
    /** Matches the Hermes profile's approvals.timeout: an unanswered approval is denied after this long. */
    approvalTimeoutSec: z.coerce.number().int().min(30).max(86_400).default(300),
    /** Admin-approved /v1/models route aliases, never arbitrary provider credentials or URLs. */
    allowedModels: z.string().trim().max(2000).default(""),
  }),
} satisfies Record<EnabledKind, z.ZodType>;

/** ChatGPT apps have no credentials of their own; only the reasoning effort is configurable. */
export const CHATGPT_REASONING_EFFORTS = ["default", "low", "medium", "high", "xhigh"] as const;
export const CHATGPT_CONFIG = z.object({ reasoningEffort: z.enum(CHATGPT_REASONING_EFFORTS).default("default") });
export type ChatGPTAppConfig = z.output<typeof CHATGPT_CONFIG>;

export function readChatGPTConfig(raw: unknown): ChatGPTAppConfig {
  const r = CHATGPT_CONFIG.safeParse(raw ?? {});
  return r.success ? r.data : { reasoningEffort: "default" };
}

export type ProviderConfigMap = { [K in EnabledKind]: z.output<(typeof CONFIG_SCHEMAS)[K]> };
export type AnyProviderConfig = ProviderConfigMap[EnabledKind];

/** Parses stored config; returns null when it's invalid (the registry turns that into a config error). */
export function readProviderConfig<K extends EnabledKind>(kind: K, raw: unknown): ProviderConfigMap[K] | null {
  const r = CONFIG_SCHEMAS[kind].safeParse(raw ?? {});
  return r.success ? (r.data as ProviderConfigMap[K]) : null;
}

// ---------------------------------------------------------------------------
// Credentials as entered in the admin form (never sent back to the browser)
// ---------------------------------------------------------------------------

export const CredentialsInput = z
  .object({
    apiKey: z.string().max(4000).optional(),
    accessKeyId: z.string().max(200).optional(),
    secretAccessKey: z.string().max(400).optional(),
    sessionToken: z.string().max(4000).optional(),
    serviceAccountJson: z.string().max(10_000).optional(),
  })
  .default({});
export type CredentialsInput = z.infer<typeof CredentialsInput>;

/** Claude.ai OAuth tokens and session keys. Third-party apps may never store or relay these (policy I4). */
export const CLAUDE_AI_TOKEN = /sk-ant-(oat|ort|sid)\d*-/;

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

const EMBEDDING_KINDS: readonly ProviderKind[] = ["openai-compatible", "openai", "azure", "bedrock"];
export const supportsEmbeddings = (kind: string) => (EMBEDDING_KINDS as readonly string[]).includes(kind);

/** Agent servers that run their own tools and keep the conversation themselves (portal tools don't apply). */
export const isAgentServer = (kind: string) => kind === "hermes";

/** Kinds that speak the OpenAI Responses API with company credentials (max_output_tokens must be ≥ 16). */
export const speaksResponses = (kind: string) => kind === "openai" || kind === "azure";

/** Apps that run on the chatting person's own plan rather than company credentials. */
export const usesPersonalPlan = (kind: string) => kind === "chatgpt";

export const isClaudeModelId = (model: string) => /anthropic\.|claude/i.test(model);

/** Anthropic Messages API underneath (prompt caching, thinking, temperature ≤ 1). */
export function isAnthropicFamily(kind: string, config: unknown, model: string): boolean {
  if (kind === "anthropic" || kind === "vertex-anthropic") return true;
  if (kind !== "bedrock") return false;
  const api = (config as { api?: string } | null)?.api ?? "auto";
  return api === "anthropic" || (api === "auto" && isClaudeModelId(model));
}

// ---------------------------------------------------------------------------
// Base URLs
// ---------------------------------------------------------------------------

const AZURE_HOST = /\.(openai\.azure\.com|cognitiveservices\.azure\.com|services\.ai\.azure\.com)$/;
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])$/;

type BaseUrlResult = { ok: true; value: string | null } | { ok: false; error: string };

/**
 * Validates and normalizes the base URL for a provider. Native providers only accept https URLs without
 * credentials, query or fragment (plain http is allowed for localhost, e.g. the dev mock).
 */
export function normalizeBaseUrl(kind: EnabledKind, raw: string | null | undefined): BaseUrlResult {
  const input = raw?.trim() ?? "";
  if (kind === "hermes") return normalizeHermesUrl(input);
  if (kind === "openai-compatible") {
    if (!input) return { ok: false, error: "Base URL is required" };
    try {
      const u = new URL(input);
      if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, error: "Base URL must be http(s)" };
    } catch {
      return { ok: false, error: "Base URL is not a valid URL" };
    }
    return { ok: true, value: input };
  }
  if (kind === "vertex-anthropic") {
    return input ? { ok: false, error: "Vertex AI endpoints are derived from the project and location" } : { ok: true, value: null };
  }
  if (!input) return kind === "azure" ? { ok: false, error: "Enter your Azure OpenAI endpoint" } : { ok: true, value: null };

  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return { ok: false, error: "Base URL is not a valid URL" };
  }
  if (u.username || u.password || u.search || u.hash) return { ok: false, error: "Base URL can't contain credentials, a query or a fragment" };
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOCAL_HOST.test(u.hostname))) {
    return { ok: false, error: "Base URL must use https" };
  }
  let path = u.pathname.replace(/\/+$/, "");
  const host = u.hostname.toLowerCase();

  if (kind === "azure" && AZURE_HOST.test(host)) {
    if (path.startsWith("/api/projects")) return { ok: false, error: "Azure AI Foundry project URLs aren't supported yet; use the resource endpoint" };
    if (path === "" || path === "/openai") path = "/openai/v1";
    if (path.toLowerCase() !== "/openai/v1") return { ok: false, error: "Use https://<resource>.openai.azure.com" };
  }
  if (kind === "anthropic") {
    if (host === "api.anthropic.com" && path === "") path = "/v1";
    // Claude on Microsoft Foundry: https://<resource>.services.ai.azure.com/anthropic/v1
    if (host.endsWith(".services.ai.azure.com") && path === "/anthropic") path = "/anthropic/v1";
  }
  if (kind === "bedrock" && !/\.amazonaws\.com(\.cn)?$/.test(host)) {
    return { ok: false, error: "Bedrock endpoints must be on amazonaws.com (VPC endpoints are fine)" };
  }
  return { ok: true, value: `${u.protocol}//${u.host}${path}` };
}

/**
 * A Hermes API server: its root URL (profiles are addressed as /p/<profile> separately). Plain http is allowed here;
 * the server-side check refuses it for anything outside the private network (src/lib/llm/providers/hermes/client.ts).
 */
function normalizeHermesUrl(input: string): BaseUrlResult {
  if (!input) return { ok: false, error: "Enter the Hermes API server URL, e.g. https://hermes.internal:8642" };
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return { ok: false, error: "Base URL is not a valid URL" };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, error: "Base URL must be http(s)" };
  if (u.username || u.password || u.search || u.hash) return { ok: false, error: "Base URL can't contain credentials, a query or a fragment" };
  // People paste the OpenAI-style URL or a profile URL; keep the server root.
  const path = u.pathname
    .replace(/\/+$/, "")
    .replace(/\/v1$/, "")
    .replace(/\/p\/[^/]+$/, "");
  return { ok: true, value: `${u.protocol}//${u.host}${path}` };
}

/** Short endpoint description for tables (never includes secrets). */
export function endpointLabel(kind: string, baseUrl: string | null, config: unknown): string {
  const c = (config ?? {}) as Record<string, string | undefined>;
  if (kind === "hermes") return `${baseUrl ?? ""} · ${c.profile ? `profile ${c.profile}` : "default profile"}`;
  if (baseUrl) return baseUrl;
  switch (kind) {
    case "openai":
      return "api.openai.com";
    case "anthropic":
      return "api.anthropic.com";
    case "bedrock":
      return `Bedrock · ${c.region ?? "?"}`;
    case "vertex-anthropic":
      return `Vertex AI · ${c.project ?? "?"} · ${c.location ?? "global"}`;
    case "chatgpt":
      return "Each person's ChatGPT plan";
    default:
      return "";
  }
}

// ---------------------------------------------------------------------------
// Admin form input
// ---------------------------------------------------------------------------

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9.:@_/-]*$/;

const common = {
  id: z.string().optional(),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).nullable().optional(),
  icon: z.string().max(16).nullable().optional(),
  baseUrl: z.string().max(500).nullable().optional(),
  model: z.string().trim().min(1).max(200),
  systemPrompt: z.string().max(20000).nullable().optional(),
  temperature: z.number().min(0).max(2).nullable().optional(),
  maxTokens: z.number().int().min(1).max(1_000_000).nullable().optional(),
  supportsVision: z.boolean(),
  supportsTools: z.boolean(),
  embeddingModel: z.string().max(200).nullable().optional(),
  isPublic: z.boolean(),
  enabled: z.boolean(),
  sortOrder: z.number().int().default(0),
  groupIds: z.array(z.string()).default([]),
  credentials: CredentialsInput,
};

export const AppInput = z
  .discriminatedUnion("provider", [
    z.object({ provider: z.literal("openai-compatible"), config: CONFIG_SCHEMAS["openai-compatible"].default({}), ...common }),
    z.object({ provider: z.literal("openai"), config: CONFIG_SCHEMAS.openai.default({ store: false, reasoning: false }), ...common }),
    z.object({ provider: z.literal("azure"), config: CONFIG_SCHEMAS.azure.default({ store: false, reasoning: false }), ...common }),
    z.object({ provider: z.literal("anthropic"), config: CONFIG_SCHEMAS.anthropic.default({ reasoning: false, promptCaching: true }), ...common }),
    z.object({ provider: z.literal("bedrock"), config: CONFIG_SCHEMAS.bedrock, ...common }),
    z.object({ provider: z.literal("vertex-anthropic"), config: CONFIG_SCHEMAS["vertex-anthropic"], ...common }),
    z.object({ provider: z.literal("chatgpt"), config: CHATGPT_CONFIG.default({ reasoningEffort: "default" }), ...common }),
    z.object({ provider: z.literal("hermes"), config: CONFIG_SCHEMAS.hermes.default({ profile: "", approvalTimeoutSec: 300, allowedModels: "" }), ...common }),
  ])
  .superRefine((v, ctx) => {
    if (v.embeddingModel?.trim() && !supportsEmbeddings(v.provider)) {
      ctx.addIssue({ code: "custom", path: ["embeddingModel"], message: `${CATALOG[v.provider].label} doesn't provide embeddings` });
    }
    if (isAnthropicFamily(v.provider, v.config, v.model) && v.temperature != null && v.temperature > 1) {
      ctx.addIssue({ code: "custom", path: ["temperature"], message: "Claude models accept a temperature between 0 and 1" });
    }
    if (speaksResponses(v.provider) && v.maxTokens != null && v.maxTokens < 16) {
      ctx.addIssue({ code: "custom", path: ["maxTokens"], message: "The Responses API needs at least 16 output tokens" });
    }
    if ((v.provider === "bedrock" || v.provider === "vertex-anthropic" || v.provider === "chatgpt" || v.provider === "hermes") && (!MODEL_ID.test(v.model) || v.model.includes(".."))) {
      ctx.addIssue({ code: "custom", path: ["model"], message: "Model id contains characters that aren't allowed" });
    }
  });
export type AppInput = z.input<typeof AppInput>;
export type ParsedAppInput = z.output<typeof AppInput>;

// ---------------------------------------------------------------------------
// Admin form metadata
// ---------------------------------------------------------------------------

export type SecretField = { key: keyof CredentialsInput; label: string; placeholder?: string; multiline?: boolean };
export type ConfigField =
  | { key: string; type: "text"; label: string; placeholder?: string; hint?: string }
  | { key: string; type: "select"; label: string; options: { value: string; label: string }[]; hint?: string }
  | { key: string; type: "switch"; label: string; hint?: string };

export type CatalogEntry = {
  label: string;
  /** "user" = runs on each person's own connection (no credentials in the form). */
  credentials?: "user";
  description: string;
  baseUrl: { mode: "required" | "optional" | "none"; placeholder?: string; hint: string };
  modelLabel: string;
  modelPlaceholder: string;
  /** Credentials shown in the form; `when` limits a field to a config value (e.g. Bedrock auth mode). */
  secrets: (SecretField & { when?: { key: string; value: string } })[];
  config: ConfigField[];
  defaultConfig: Record<string, unknown>;
  /** "list" = Test lists models; "probe" = Test makes one tiny request with the model; "hermes" = checks the Hermes server. */
  test: "list" | "probe" | "hermes";
  /** Pre-filled max output tokens (Claude models otherwise get a small default for unknown ids). */
  defaultMaxTokens?: number;
};

const reasoningField: ConfigField = {
  key: "reasoning",
  type: "switch",
  label: "Reasoning model (don't send temperature)",
  hint: "Turn on when the model or deployment name doesn't reveal that it's a reasoning model",
};
const cachingField: ConfigField = { key: "promptCaching", type: "switch", label: "Prompt caching", hint: "Caches the bot's standing instructions" };
const storeField: ConfigField = {
  key: "store",
  type: "switch",
  label: "Store responses at the provider",
  hint: "Off keeps conversation state only in the portal (recommended, works with zero data retention)",
};

export const CATALOG: Record<AppProvider, CatalogEntry> = {
  "openai-compatible": {
    label: "OpenAI-compatible",
    description: "Any endpoint with /v1/chat/completions: vLLM, LiteLLM, Ollama, your own service…",
    baseUrl: { mode: "required", placeholder: "https://my-app.internal/v1", hint: "OpenAI-compatible, ending in /v1 (vLLM, LiteLLM, Ollama, your own service…)" },
    modelLabel: "Model",
    modelPlaceholder: "gpt-4o / my-model",
    secrets: [{ key: "apiKey", label: "API key", placeholder: "sk-…" }],
    config: [],
    defaultConfig: {},
    test: "list",
  },
  openai: {
    label: "OpenAI",
    description: "OpenAI API (Responses) with a company API key",
    baseUrl: { mode: "optional", placeholder: "https://api.openai.com/v1", hint: "Leave blank for api.openai.com" },
    modelLabel: "Model",
    modelPlaceholder: "gpt-5",
    secrets: [{ key: "apiKey", label: "API key", placeholder: "sk-…" }],
    config: [
      { key: "organization", type: "text", label: "Organization ID", placeholder: "org-… (optional)" },
      { key: "project", type: "text", label: "Project ID", placeholder: "proj_… (optional)" },
      storeField,
      reasoningField,
    ],
    defaultConfig: { store: false, reasoning: false },
    test: "list",
  },
  azure: {
    label: "Azure OpenAI",
    description: "Azure OpenAI deployments (Responses API)",
    baseUrl: { mode: "required", placeholder: "https://my-resource.openai.azure.com", hint: "Your resource endpoint; /openai/v1 is added automatically" },
    modelLabel: "Deployment name",
    modelPlaceholder: "gpt-5-prod",
    secrets: [{ key: "apiKey", label: "API key", placeholder: "Azure OpenAI key" }],
    config: [storeField, reasoningField],
    defaultConfig: { store: false, reasoning: false },
    test: "list",
  },
  anthropic: {
    label: "Anthropic (Claude)",
    description: "Claude through the Anthropic API or Microsoft Foundry, with a company API key",
    baseUrl: {
      mode: "optional",
      placeholder: "https://api.anthropic.com/v1",
      hint: "Leave blank for the Anthropic API. For Claude on Microsoft Foundry use https://<resource>.services.ai.azure.com/anthropic",
    },
    modelLabel: "Model",
    modelPlaceholder: "claude-sonnet-4-5",
    secrets: [{ key: "apiKey", label: "API key", placeholder: "sk-ant-api…" }],
    config: [cachingField, reasoningField],
    defaultConfig: { reasoning: false, promptCaching: true },
    test: "list",
    defaultMaxTokens: 8192,
  },
  bedrock: {
    label: "Amazon Bedrock",
    description: "Claude and other models on AWS Bedrock",
    baseUrl: { mode: "optional", placeholder: "https://bedrock-runtime.us-east-1.amazonaws.com", hint: "Leave blank for the regional endpoint; set it for a VPC endpoint" },
    modelLabel: "Model ID or inference profile",
    modelPlaceholder: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    secrets: [
      { key: "apiKey", label: "Bedrock API key", placeholder: "ABSK…", when: { key: "auth", value: "api-key" } },
      { key: "accessKeyId", label: "Access key ID", placeholder: "AKIA…", when: { key: "auth", value: "access-keys" } },
      { key: "secretAccessKey", label: "Secret access key", when: { key: "auth", value: "access-keys" } },
      { key: "sessionToken", label: "Session token (optional)", when: { key: "auth", value: "access-keys" } },
    ],
    config: [
      { key: "region", type: "text", label: "Region", placeholder: "us-east-1" },
      {
        key: "auth",
        type: "select",
        label: "Authentication",
        options: [
          { value: "api-key", label: "Bedrock API key" },
          { value: "access-keys", label: "IAM access keys" },
        ],
      },
      {
        key: "api",
        type: "select",
        label: "API",
        options: [
          { value: "auto", label: "Automatic (Claude → Anthropic API, others → Converse)" },
          { value: "anthropic", label: "Anthropic Messages (InvokeModel)" },
          { value: "converse", label: "Converse" },
        ],
      },
      cachingField,
      reasoningField,
    ],
    defaultConfig: { region: "us-east-1", auth: "api-key", api: "auto", reasoning: false, promptCaching: true },
    test: "probe",
    defaultMaxTokens: 8192,
  },
  "vertex-anthropic": {
    label: "Google Vertex AI (Claude)",
    description: "Claude on Google Cloud Vertex AI with a service account",
    baseUrl: { mode: "none", hint: "" },
    modelLabel: "Model",
    modelPlaceholder: "claude-sonnet-4-5@20250929",
    secrets: [{ key: "serviceAccountJson", label: "Service account key (JSON)", placeholder: '{"type": "service_account", …}', multiline: true }],
    config: [
      { key: "project", type: "text", label: "Project ID", placeholder: "my-gcp-project" },
      { key: "location", type: "text", label: "Location", placeholder: "global" },
      cachingField,
      reasoningField,
    ],
    defaultConfig: { location: "global", reasoning: false, promptCaching: true },
    test: "probe",
    defaultMaxTokens: 8192,
  },
  hermes: {
    label: "Hermes Agent",
    description:
      "A profile on your Hermes Agent server. Hermes runs its own tools, memory and model (Claude included); approvals come to the portal. Saving a new backend connection also creates a bot for it.",
    baseUrl: {
      mode: "required",
      placeholder: "https://hermes.internal:8642",
      hint: "The Hermes API server (hermes gateway run with API_SERVER_ENABLED). Use https, or http on your private network.",
    },
    modelLabel: "Model id",
    modelPlaceholder: "coder",
    secrets: [{ key: "apiKey", label: "Profile API key (API_SERVER_KEY)", placeholder: "from the profile's .env" }],
    config: [
      { key: "profile", type: "text", label: "Profile", placeholder: "coder", hint: "Blank for the default profile. Test fills in the model id." },
      { key: "allowedModels", type: "text", label: "Allowed model routes", placeholder: "fast, reasoning", hint: "Optional comma-separated aliases from Hermes /v1/models. Users may request these with /model for their chat. Blank disables model changes." },
      {
        key: "approvalTimeoutSec",
        type: "select",
        label: "Approval time limit",
        hint: "Match the profile's approvals.timeout: Hermes denies an unanswered approval after this long",
        options: [
          { value: "120", label: "2 minutes" },
          { value: "300", label: "5 minutes (Hermes default)" },
          { value: "900", label: "15 minutes" },
          { value: "3600", label: "1 hour" },
        ],
      },
    ],
    defaultConfig: { profile: "", approvalTimeoutSec: "300", allowedModels: "" },
    test: "hermes",
  },
  chatgpt: {
    label: "ChatGPT plan (each person's own)",
    credentials: "user",
    description: "Each person's own ChatGPT plan, connected in Settings (unofficial). Turn it on under Admin → Settings first.",
    baseUrl: { mode: "none", hint: "" },
    modelLabel: "Model",
    modelPlaceholder: "gpt-5.1-codex",
    secrets: [],
    config: [
      {
        key: "reasoningEffort",
        type: "select",
        label: "Reasoning effort",
        options: [
          { value: "default", label: "Model default" },
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
          { value: "xhigh", label: "Extra high" },
        ],
      },
    ],
    defaultConfig: { reasoningEffort: "default" },
    test: "list",
  },
};

/** Whether an app can be used for background work (titles, memory, drafts). Company credentials only. */
export function isEligibleUtilityApp(app: { enabled: boolean; kind: string; provider: string; credentialMode: string }): boolean {
  // Agent servers (Hermes) are chat partners, not models: never used for titles, memory or drafts.
  return app.enabled && app.kind === "model" && app.credentialMode === "org" && isEnabledKind(app.provider) && !isAgentServer(app.provider);
}

export function isEligibleEmbeddingApp(app: {
  enabled: boolean;
  kind: string;
  provider: string;
  credentialMode: string;
  embeddingModel: string | null;
}): boolean {
  return isEligibleUtilityApp(app) && supportsEmbeddings(app.provider) && !!app.embeddingModel;
}
