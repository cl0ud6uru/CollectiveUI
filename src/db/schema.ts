import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { newId } from "../lib/ids";
import type { BotPetDefault, CatalogPet, PetManifest, PetPreferences } from "../lib/pets/shared";
import type {
  AppKind,
  BillingSource,
  CredentialMode,
  ModelPurpose,
  ProviderKind,
  UserCredentialProvider,
  UserCredentialStatus,
} from "../lib/llm/kinds";
import type { McpDrift, McpServerInfo, McpServerStatus, McpToolDef, McpToolPolicy, McpTrust } from "../lib/mcp/kinds";

/** pgvector column without a fixed dimension, so any embedding model can be used. */
const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector";
  },
  toDriver(value) {
    return `[${value.join(",")}]`;
  },
  fromDriver(value) {
    return JSON.parse(value) as number[];
  },
});

const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => newId());
const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

// ---------------------------------------------------------------------------
// Identity & access
// ---------------------------------------------------------------------------

export const users = pgTable("users", {
  id: id(),
  upn: text("upn").notNull(), // directory UPN or namespaced local username
  identityRealm: text("identity_realm").$type<"directory" | "local">().notNull().default("directory"),
  sessionVersion: integer("session_version").notNull().default(0),
  authChangedAt: timestamp("auth_changed_at", { withTimezone: true }),
  email: text("email"),
  name: text("name").notNull(),
  authSource: text("auth_source").$type<"entra" | "ldap" | "local">().notNull(),
  isAdmin: boolean("is_admin").notNull().default(false), // manual grant; group-based admin is computed
  disabled: boolean("disabled").notNull().default(false),
  prefs: jsonb("prefs").$type<UserPrefs>().notNull().default({}),
  createdAt: createdAt(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
}, (t) => [uniqueIndex("users_realm_upn_idx").on(t.identityRealm, t.upn),
  check("users_identity_realm_check", sql`(${t.identityRealm} = 'local' and ${t.authSource} = 'local') or (${t.identityRealm} = 'directory' and ${t.authSource} in ('entra', 'ldap'))`)]);

/** Password material is deliberately separate from user records sent to UI components. */
export const localCredentials = pgTable("local_credentials", {
  userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  mustChangePassword: boolean("must_change_password").notNull().default(true),
  temporaryExpiresAt: timestamp("temporary_expires_at", { withTimezone: true }),
  updatedAt: updatedAt(),
});
/** Factor secrets and public credentials are never included in ordinary user projections. */
export const localSecurity = pgTable("local_security", {
  userId: text("user_id").primaryKey().references(() => localCredentials.userId, { onDelete: "cascade" }),
  userHandle: text("user_handle").notNull().unique(),
  totpSecretEnc: text("totp_secret_enc"),
  totpLastStep: bigint("totp_last_step", { mode: "number" }),
});
export const localPasskeys = pgTable("local_passkeys", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => localSecurity.userId, { onDelete: "cascade" }),
  name: text("name").notNull(),
  publicKey: text("public_key").notNull(),
  counter: bigint("counter", { mode: "number" }).notNull(),
  deviceType: text("device_type").notNull(),
  backedUp: boolean("backed_up").notNull(),
  transports: jsonb("transports").$type<NonNullable<import("@collective/webauthn-server").WebAuthnCredential["transports"]>>().notNull(),
  createdAt: createdAt(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
}, t => [index("local_passkeys_user_idx").on(t.userId),
  check("local_passkeys_counter_check", sql`${t.counter} >= 0`),
  check("local_passkeys_device_type_check", sql`${t.deviceType} in ('singleDevice', 'multiDevice')`)]);
export const localRecoveryCodes = pgTable("local_recovery_codes", {
  hash: text("hash").primaryKey(),
  userId: text("user_id").notNull().references(() => localSecurity.userId, { onDelete: "cascade" }),
}, t => [index("local_recovery_user_idx").on(t.userId)]);
export const authFlows = pgTable("auth_flows", {
  hash: text("hash").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  purpose: text("purpose").notNull(),
  bindingHash: text("binding_hash").notNull(),
  userId: text("user_id").references(() => localCredentials.userId, { onDelete: "cascade" }),
  sessionVersion: integer("session_version"),
  data: jsonb("data").$type<Record<string, string>>().notNull().default({}),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, t => [index("auth_flows_expiry_idx").on(t.expiresAt), index("auth_flows_user_idx").on(t.userId)]);
export const localLoginAliases = pgTable("local_login_aliases", {
  login: text("login").primaryKey(),
  userId: text("user_id").notNull().references(() => localCredentials.userId, { onDelete: "cascade" }),
});
export const authThrottle = pgTable("auth_throttle", {
  key: text("key").primaryKey(),
  attempts: integer("attempts").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => [index("auth_throttle_expiry_idx").on(t.expiresAt)]);
export const localAuthBootstrap = pgTable("local_auth_bootstrap", {
  id: integer("id").primaryKey(),
  createdAt: createdAt(),
}, (t) => [check("local_auth_bootstrap_singleton", sql`${t.id} = 1`)]);

export type UserPrefs = {
  /** Personal bot navigation only; inaccessible/deleted IDs are ignored on reads. */
  botOrder?: string[];
  customInstructions?: string;
  memoryEnabled?: boolean;
  /** Where new chats start: at most one of a model or a bot. Unset follows the organization default. */
  defaultAppId?: string;
  defaultBotId?: string;
};

export const userExternalGroups = pgTable(
  "user_external_groups",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    source: text("source").$type<"entra" | "ldap">().notNull(),
    externalId: text("external_id").notNull(), // Entra object id or LDAP DN (lower-cased)
    displayName: text("display_name"),
  },
  (t) => [primaryKey({ columns: [t.userId, t.source, t.externalId] })],
);

/** Delegated OAuth tokens (Entra) used by the Microsoft 365 connector. Encrypted at rest. */
export const userTokens = pgTable("user_tokens", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  provider: text("provider").notNull().default("entra"),
  accessTokenEnc: text("access_token_enc").notNull(),
  refreshTokenEnc: text("refresh_token_enc"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  scope: text("scope"),
  updatedAt: updatedAt(),
});

/**
 * A user's own connection to an outside AI service (today: their ChatGPT plan via "Sign in with ChatGPT").
 * Tokens live only in secret_enc (encrypted JSON bound to the row); the other columns are non-secret account facts
 * read from the sign-in claims. Refresh tokens rotate and are single-use, so refreshes happen under a row lock
 * (src/lib/llm/chatgpt/store.ts).
 */
export const userCredentials = pgTable(
  "user_credentials",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").$type<UserCredentialProvider>().notNull(),
    secretEnc: text("secret_enc").notNull(),
    /** ChatGPT account (workspace or personal) id; sent as ChatGPT-Account-ID. */
    accountId: text("account_id").notNull(),
    planType: text("plan_type"),
    email: text("email"),
    /** The provider's id for the person (chatgpt_user_id), used to stop two portal users sharing one account. */
    externalSubject: text("external_subject"),
    residency: text("residency"),
    isFedramp: boolean("is_fedramp").notNull().default(false),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastRefreshAt: timestamp("last_refresh_at", { withTimezone: true }),
    status: text("status").$type<UserCredentialStatus>().notNull().default("active"),
    statusReason: text("status_reason"),
    /** Last plan usage the provider reported (percentages and reset times, no secrets). */
    rateLimits: jsonb("rate_limits").$type<Record<string, unknown>>(),
    rateLimitsAt: timestamp("rate_limits_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("user_credentials_user_provider_idx").on(t.userId, t.provider),
    uniqueIndex("user_credentials_subject_idx")
      .on(t.provider, t.accountId, t.externalSubject)
      .where(sql`${t.externalSubject} is not null`),
    check("user_credentials_provider_check", sql`${t.provider} in ('chatgpt')`),
    check("user_credentials_status_check", sql`${t.status} in ('active', 'needs_reauth')`),
  ],
);

/**
 * A ChatGPT device-code sign-in in progress (at most one per user, 15 minutes). Server-side only: the browser
 * sees the user code, never the device auth id, and each poll makes at most one upstream request.
 */
export const chatgptDeviceLogins = pgTable("chatgpt_device_logins", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  deviceAuthEnc: text("device_auth_enc").notNull(),
  userCode: text("user_code").notNull(),
  intervalSec: integer("interval_sec").notNull(),
  nextPollAt: timestamp("next_poll_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

export const groups = pgTable("groups", {
  id: id(),
  name: text("name").notNull().unique(),
  description: text("description"),
  isAdmin: boolean("is_admin").notNull().default(false),
  canCreateBots: boolean("can_create_bots").notNull().default(true),
  createdAt: createdAt(),
});

export const groupMappings = pgTable(
  "group_mappings",
  {
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    source: text("source").$type<"entra" | "ldap">().notNull(),
    externalId: text("external_id").notNull(),
    displayName: text("display_name"),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.source, t.externalId] })],
);

// ---------------------------------------------------------------------------
// AI apps (OpenAI-compatible endpoints)
// ---------------------------------------------------------------------------

export const aiApps = pgTable(
  "ai_apps",
  {
    id: id(),
    name: text("name").notNull(),
    description: text("description"),
    icon: text("icon"), // emoji
    kind: text("kind").$type<AppKind>().notNull().default("model"),
    /** Wire protocol / vendor; see src/lib/llm/catalog.ts. Existing apps are OpenAI-compatible endpoints. */
    provider: text("provider")
      .$type<ProviderKind>()
      .notNull()
      .default("openai-compatible"),
    /** Non-secret per-provider settings (region, project, organization, flags), validated by the catalog. */
    providerConfig: jsonb("provider_config")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    credentialMode: text("credential_mode")
      .$type<CredentialMode>()
      .notNull()
      .default("org"),
    /** Required for OpenAI-compatible apps; optional (vendor default) or unused for native providers. */
    baseUrl: text("base_url"),
    /** Encrypted secret: an API key, or JSON for multi-part credentials (AWS keys, service accounts). */
    apiKeyEnc: text("api_key_enc"),
    model: text("model").notNull(),
    systemPrompt: text("system_prompt"),
    temperature: real("temperature"),
    maxTokens: integer("max_tokens"),
    supportsVision: boolean("supports_vision").notNull().default(false),
    supportsTools: boolean("supports_tools").notNull().default(false),
    embeddingModel: text("embedding_model"), // if set, this endpoint can also produce embeddings
    isPublic: boolean("is_public").notNull().default(true),
    enabled: boolean("enabled").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("ai_apps_kind_check", sql`${t.kind} in ('model', 'runtime')`),
    check(
      "ai_apps_provider_check",
      sql`${t.provider} in ('openai-compatible', 'openai', 'azure', 'anthropic', 'bedrock', 'vertex-anthropic', 'chatgpt', 'hermes')`,
    ),
    check(
      "ai_apps_credential_mode_check",
      sql`${t.credentialMode} in ('org', 'user', 'user_or_org')`,
    ),
    // A ChatGPT plan is always the user's own; it can never be a company credential.
    check(
      "ai_apps_chatgpt_user_check",
      sql`${t.provider} <> 'chatgpt' or ${t.credentialMode} = 'user'`,
    ),
    check(
      "ai_apps_base_url_check",
      sql`${t.provider} not in ('openai-compatible', 'hermes') or ${t.baseUrl} is not null`,
    ),
  ],
);

export const appAccess = pgTable(
  "app_access",
  {
    appId: text("app_id")
      .notNull()
      .references(() => aiApps.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.appId, t.groupId] })],
);

// ---------------------------------------------------------------------------
// Chats
// ---------------------------------------------------------------------------

export const folders = pgTable("folders", {
  id: id(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: createdAt(),
});

export const conversations = pgTable(
  "conversations",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    appId: text("app_id").references(() => aiApps.id, { onDelete: "set null" }),
    botId: text("bot_id").references(() => bots.id, { onDelete: "set null" }),
    folderId: text("folder_id").references(() => folders.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull().default("New chat"),
    pinned: boolean("pinned").notNull().default(false),
    archived: boolean("archived").notNull().default(false),
    currentLeafId: text("current_leaf_id"),
    source: text("source")
      .$type<"chat" | "routine" | "delegation">()
      .notNull()
      .default("chat"),
    isGroup: boolean("is_group").notNull().default(false), // group chat with several bots (see conversationBots)
    /** Canonical UI home for this user/bot. Existing conversations remain ordinary chats. */
    isBotHome: boolean("is_bot_home").notNull().default(false),
    /** Durable rollover receipt: retries from a retired home return its original successor. */
    homeSuccessorId: text("home_successor_id"),
    memoryProcessedAt: timestamp("memory_processed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("conversations_user_idx").on(t.userId, t.updatedAt),
    index("conversations_user_bot_idx").on(t.userId, t.botId, t.updatedAt),
    uniqueIndex("conversations_bot_home_idx").on(t.userId, t.botId).where(sql`${t.isBotHome} and ${t.botId} is not null`),
    // botId may become null after bot deletion; the transcript remains readable.
    check("conversations_bot_home_check", sql`not ${t.isBotHome} or (not ${t.isGroup} and not ${t.archived} and ${t.source} = 'chat' and ${t.appId} is null)`),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    parentId: text("parent_id"),
    role: text("role").$type<"user" | "assistant" | "system">().notNull(),
    parts: jsonb("parts").$type<unknown[]>().notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    model: text("model"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    /** Who paid for this reply. NULL = written before the usage ledger existed (see src/lib/usage.ts). */
    billingSource: text("billing_source").$type<BillingSource>(),
    providerKind: text("provider_kind").$type<ProviderKind>(),
    appId: text("app_id"), // no FK: app deletion must not rewrite the messages table
    feedback: smallint("feedback"),
    searchText: text("search_text").notNull().default(""),
    searchTsv: tsvector("search_tsv").generatedAlwaysAs(
      sql`to_tsvector('english', search_text)`,
    ),
    createdAt: createdAt(),
  },
  (t) => [
    index("messages_conversation_idx").on(t.conversationId, t.createdAt),
    index("messages_tsv_idx").using("gin", t.searchTsv),
    index("messages_app_idx").on(t.appId),
  ],
);

export const attachments = pgTable("attachments", {
  id: id(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  filename: text("filename").notNull(),
  mediaType: text("media_type").notNull(),
  size: integer("size").notNull(),
  storageKey: text("storage_key").notNull(),
  extractedText: text("extracted_text"),
  createdAt: createdAt(),
});

export const sharedLinks = pgTable("shared_links", {
  id: text("id").primaryKey(), // the share token
  conversationId: text("conversation_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  cutoffMessageId: text("cutoff_message_id").notNull(),
  createdBy: text("created_by")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: createdAt(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

// ---------------------------------------------------------------------------
// Bots (agents)
// ---------------------------------------------------------------------------

export const bots = pgTable("bots", {
  id: id(),
  ownerId: text("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  avatar: text("avatar"), // "blob:<shape>:<color>" or an emoji
  label: text("label"), // short role tag shown next to the name, e.g. "Chief of Staff"
  description: text("description"), // the bot's job
  instructions: text("instructions"),
  boundaries: text("boundaries"),
  appId: text("app_id").references(() => aiApps.id, { onDelete: "set null" }),
  visibility: text("visibility")
    .$type<"private" | "groups" | "org">()
    .notNull()
    .default("private"),
  maxSteps: integer("max_steps").notNull().default(10),
  starters: jsonb("starters").$type<string[]>().notNull().default([]),
  enabled: boolean("enabled").notNull().default(true),
  /** Service bots are admin-managed, MCP-only and usable only in direct chats after publication. */
  executionMode: text("execution_mode").$type<"caller" | "service">().notNull().default("caller"),
  /** Explicit opt-in to discovery by the installation coordinator; never an audience or tool grant. */
  coordinatorEligible: boolean("coordinator_eligible").notNull().default(false),
  revision: integer("revision").notNull().default(1),
  publishedRevision: integer("published_revision"),
  publishedConfigHash: text("published_config_hash"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const botAccess = pgTable(
  "bot_access",
  {
    botId: text("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.botId, t.groupId] })],
);

/** "smart": run without asking only when a trusted MCP server marks the tool read-only; otherwise ask. */
export type ApprovalMode = "auto" | "ask" | "smart";

/** Per-tool choices for a tool group (MCP servers): which tools the bot gets and per-tool approval overrides. */
export type BotToolConfig = { tools?: string[]; approvals?: Record<string, ApprovalMode> };

export const botTools = pgTable(
  "bot_tools",
  {
    botId: text("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    toolKey: text("tool_key").notNull(), // e.g. "web_search", "mcp:<serverId>", "m365"
    approval: text("approval").$type<ApprovalMode>().notNull().default("auto"),
    config: jsonb("config").$type<BotToolConfig>(),
  },
  (t) => [primaryKey({ columns: [t.botId, t.toolKey] }), check("bot_tools_approval_check", sql`${t.approval} in ('auto', 'ask', 'smart')`)],
);

export const botDelegates = pgTable(
  "bot_delegates",
  {
    botId: text("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    delegateBotId: text("delegate_bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.botId, t.delegateBotId] })],
);

/** Members of a group chat, in order (the first is the lead that answers un-addressed messages). */
export const conversationBots = pgTable(
  "conversation_bots",
  {
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    botId: text("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.botId] })],
);

/** Per-user sidebar preferences for bots (pin / hide). Hiding never pauses a bot or its routines. */
export const userBotPrefs = pgTable(
  "user_bot_prefs",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    botId: text("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    pinned: boolean("pinned").notNull().default(false),
    hidden: boolean("hidden").notNull().default(false),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.botId] })],
);

const petBytes = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

/** Approved shared art has its own lifecycle; private imports are never implicitly published. */
export const petCatalog = pgTable("pet_catalog", {
  id: text("id").primaryKey().$defaultFn(newId),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  manifest: jsonb("manifest").$type<PetManifest>().notNull(),
  sprite: petBytes("sprite").notNull(),
  revision: text("revision").notNull().$defaultFn(newId),
  status: text("status").$type<CatalogPet["status"]>().notNull().default("draft"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [check("pet_catalog_sprite_size", sql`octet_length(${t.sprite}) between 1 and 4194304`),
  check("pet_catalog_status", sql`${t.status} in ('draft', 'published', 'unpublished')`)]);

export const botPetDefaults = pgTable("bot_pet_defaults", {
  botId: text("bot_id").primaryKey().references(() => bots.id, { onDelete: "cascade" }),
  appearance: text("appearance").$type<BotPetDefault["appearance"]>().notNull(),
  catalogId: text("catalog_id").references(() => petCatalog.id, { onDelete: "restrict" }),
  updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [check("bot_pet_default_choice", sql`(${t.appearance} in ('moss', 'ember', 'off') and ${t.catalogId} is null) or (${t.appearance} = 'catalog' and ${t.catalogId} is not null)`)]);

/** Private companion preferences and one bounded, normalized raster per user/bot. */
export const botPets = pgTable("bot_pets", {
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  botId: text("bot_id").notNull().references(() => bots.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(false),
  mode: text("mode").$type<PetPreferences["mode"]>().notNull().default("follow"),
  appearance: text("appearance").$type<PetPreferences["appearance"]>().notNull().default("moss"),
  catalogId: text("catalog_id").references(() => petCatalog.id, { onDelete: "restrict" }),
  motion: text("motion").$type<PetPreferences["motion"]>().notNull().default("auto"),
  custom: jsonb("custom").$type<PetManifest>(),
  sprite: petBytes("sprite"),
  revision: text("revision"),
}, (t) => [primaryKey({ columns: [t.userId, t.botId] }),
  check("bot_pets_sprite_size", sql`${t.sprite} is null or octet_length(${t.sprite}) <= 4194304`),
  check("bot_pets_mode", sql`${t.mode} in ('follow', 'personal', 'off')`),
  check("bot_pets_choice", sql`(${t.appearance} in ('moss', 'ember', 'custom') and ${t.catalogId} is null) or (${t.appearance} = 'catalog' and ${t.catalogId} is not null)`),
]);

export type BotTemplateSnapshot = {
  name: string;
  avatar: string | null;
  label: string | null;
  description: string | null;
  instructions: string | null;
  boundaries: string | null;
  starters: string[];
  maxSteps: number;
  tools: { key: string; approval: ApprovalMode; config?: BotToolConfig | null }[];
  skills: {
    slug: string;
    name: string;
    description: string;
    instructions: string;
    expectedOutput: string | null;
    boundaries: string | null;
  }[];
  routines: {
    name: string;
    prompt: string;
    triggerType: "cron" | "webhook";
    cron: string | null;
    timezone: string;
  }[];
};

/** Shareable template links: a snapshot of a bot's configuration that others can add as their own copy. */
export const botTemplates = pgTable("bot_templates", {
  id: text("id").primaryKey(), // share token
  botId: text("bot_id")
    .notNull()
    .references(() => bots.id, { onDelete: "cascade" }),
  createdBy: text("created_by")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  snapshot: jsonb("snapshot").$type<BotTemplateSnapshot>().notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const knowledgeChunks = pgTable(
  "knowledge_chunks",
  {
    id: id(),
    botId: text("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    attachmentId: text("attachment_id")
      .notNull()
      .references(() => attachments.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    embedding: vector("embedding"),
    tsv: tsvector("tsv").generatedAlwaysAs(
      sql`to_tsvector('english', content)`,
    ),
  },
  (t) => [
    index("knowledge_bot_idx").on(t.botId),
    index("knowledge_tsv_idx").using("gin", t.tsv),
  ],
);

export const memories = pgTable(
  "memories",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    botId: text("bot_id").references(() => bots.id, { onDelete: "cascade" }), // null = shared across bots
    content: text("content").notNull(),
    embedding: vector("embedding"),
    sourceConversationId: text("source_conversation_id").references(
      () => conversations.id,
      {
        onDelete: "set null",
      },
    ),
    pinned: boolean("pinned").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("memories_user_idx").on(t.userId, t.botId)],
);

export const skills = pgTable(
  "skills",
  {
    id: id(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    botId: text("bot_id").references(() => bots.id, { onDelete: "cascade" }), // null = available to all my bots
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    instructions: text("instructions").notNull(),
    expectedOutput: text("expected_output"),
    boundaries: text("boundaries"),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("skills_owner_slug_idx").on(t.ownerId, t.slug)],
);

export const routines = pgTable("routines", {
  id: id(),
  ownerId: text("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  botId: text("bot_id")
    .notNull()
    .references(() => bots.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  prompt: text("prompt").notNull(),
  triggerType: text("trigger_type").$type<"cron" | "webhook">().notNull(),
  cron: text("cron"),
  timezone: text("timezone").notNull().default("UTC"),
  webhookSecret: text("webhook_secret"),
  enabled: boolean("enabled").notNull().default(true),
  notifyEmail: boolean("notify_email").notNull().default(false),
  nextRunAt: timestamp("next_run_at", { withTimezone: true }),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export type RoutineRunStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "succeeded"
  | "failed";

export const routineRuns = pgTable(
  "routine_runs",
  {
    id: id(),
    routineId: text("routine_id")
      .notNull()
      .references(() => routines.id, { onDelete: "cascade" }),
    status: text("status")
      .$type<RoutineRunStatus>()
      .notNull()
      .default("queued"),
    trigger: text("trigger")
      .$type<"schedule" | "webhook" | "manual">()
      .notNull(),
    payload: jsonb("payload"),
    conversationId: text("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    error: text("error"),
    /** Last queue admission attempt; queued rows form a recoverable, fairly retried outbox. */
    lastEnqueueAt: timestamp("last_enqueue_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("routine_runs_routine_idx").on(t.routineId, t.createdAt)],
);

export type ToolCallStatus =
  | "pending_approval"
  | "approved"
  | "denied"
  | "done"
  | "error";

export const toolCalls = pgTable(
  "tool_calls",
  {
    id: text("id").primaryKey(), // Scoped audit id; legacy rows retain their original id.
    runId: text("run_id"),
    providerCallId: text("provider_call_id"),
    conversationId: text("conversation_id").references(() => conversations.id, {
      onDelete: "cascade",
    }),
    messageId: text("message_id"),
    userId: text("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    botId: text("bot_id").references(() => bots.id, { onDelete: "set null" }),
    toolName: text("tool_name").notNull(),
    input: jsonb("input"),
    output: jsonb("output"),
    status: text("status").$type<ToolCallStatus>().notNull(),
    decidedBy: text("decided_by"),
    durationMs: integer("duration_ms"),
    createdAt: createdAt(),
  },
  (t) => [index("tool_calls_created_idx").on(t.createdAt), uniqueIndex("tool_calls_message_call_idx").on(t.messageId, t.providerCallId)],
);

export const toolGrants = pgTable(
  "tool_grants",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    botId: text("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    toolName: text("tool_name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.botId, t.toolName] })],
);

/**
 * Usage ledger: one row per model call (each step of a multi-step turn, delegates, titles, memory extraction,
 * drafts, embeddings). Survives chat deletion. message_id/app_id/bot_id are plain text so rows never block deletes.
 */
export const usageEvents = pgTable(
  "usage_events",
  {
    id: id(),
    createdAt: createdAt(),
    userId: text("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    conversationId: text("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    messageId: text("message_id"),
    toolCallId: text("tool_call_id"),
    runId: text("run_id"),
    botId: text("bot_id"),
    appId: text("app_id"),
    providerKind: text("provider_kind").$type<ProviderKind>().notNull(),
    model: text("model").notNull(),
    purpose: text("purpose").$type<ModelPurpose>().notNull(),
    billingSource: text("billing_source").$type<BillingSource>().notNull(),
    credentialId: text("credential_id"),
    /** Total input tokens, including cached reads and writes. */
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheWriteTokens: integer("cache_write_tokens"),
    reasoningTokens: integer("reasoning_tokens"),
    costMicros: bigint("cost_micros", { mode: "number" }),
  },
  (t) => [
    index("usage_events_created_idx").on(t.createdAt),
    index("usage_events_user_idx").on(t.userId, t.createdAt),
    index("usage_events_conversation_idx").on(t.conversationId),
    index("usage_events_message_idx").on(t.messageId),
    index("usage_events_app_idx").on(t.appId),
    index("usage_events_bot_idx").on(t.botId),
  ],
);

export const mcpServers = pgTable(
  "mcp_servers",
  {
    id: id(),
    name: text("name").notNull(),
    description: text("description"),
    url: text("url").notNull(),
    transport: text("transport")
      .$type<"http" | "sse">()
      .notNull()
      .default("http"),
    headersEnc: text("headers_enc"), // encrypted JSON of extra headers (e.g. Authorization)
    isPublic: boolean("is_public").notNull().default(true),
    status: text("status").$type<McpServerStatus>().notNull().default("draft"),
    trust: text("trust").$type<McpTrust>().notNull().default("untrusted"),
    /** Header carrying the signed per-user identity (src/lib/mcp/identity.ts); null = not sent. */
    identityHeader: text("identity_header"),
    identitySecretEnc: text("identity_secret_enc"), // row-bound AAD "mcp_servers.identity_secret_enc|<id>"
    /** The accepted tool list (from Test or the refresh job); bots only see these tools. */
    toolsSnapshot: jsonb("tools_snapshot").$type<McpToolDef[]>(),
    toolsHash: text("tools_hash"),
    toolsDrift: jsonb("tools_drift").$type<McpDrift>(),
    serverInfo: jsonb("server_info").$type<McpServerInfo>(),
    toolPolicy: jsonb("tool_policy").$type<McpToolPolicy>().notNull().default({}),
    policyRevision: integer("policy_revision").notNull().default(1),
    resultBudgetKb: integer("result_budget_kb").notNull().default(64),
    timeoutMs: integer("timeout_ms").notNull().default(60_000),
    lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: createdAt(),
  },
  (t) => [
    check("mcp_servers_status_check", sql`${t.status} in ('draft', 'enabled', 'disabled', 'needs_review')`),
    check("mcp_servers_trust_check", sql`${t.trust} in ('untrusted', 'trusted')`),
    check("mcp_servers_budget_check", sql`${t.resultBudgetKb} between 1 and 1024`),
    check("mcp_servers_timeout_check", sql`${t.timeoutMs} between 1000 and 600000`),
  ],
);

/**
 * Each person's workspace sandbox (P5). The container itself lives in Docker (sandboxd is the source of truth for
 * its state); this row maps the person to an unguessable ref and tracks retention. No credential columns.
 */
export const sandboxes = pgTable("sandboxes", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  ref: text("ref").notNull().unique(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  /** Set when the person is disabled: the workspace is destroyed after this time (cleared on re-enable). */
  deleteAfter: timestamp("delete_after", { withTimezone: true }),
  createdAt: createdAt(),
});

export const mcpServerAccess = pgTable(
  "mcp_server_access",
  {
    serverId: text("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.serverId, t.groupId] })],
);

/** Non-transferable admin authorization for one exact tool on one published bot revision. */
export const botMcpGrants = pgTable("bot_mcp_grants", {
  id: id(),
  botId: text("bot_id").notNull().references(() => bots.id, { onDelete: "cascade" }),
  botRevision: integer("bot_revision").notNull(),
  serverId: text("server_id").notNull().references(() => mcpServers.id, { onDelete: "cascade" }),
  serverRevision: integer("server_revision").notNull(),
  toolName: text("tool_name").notNull(),
  toolHash: text("tool_hash").notNull(),
  effect: text("effect").$type<"read" | "write">().notNull().default("write"),
  requireApproval: boolean("require_approval").notNull().default(true),
  constraints: jsonb("constraints").$type<import("@/lib/bots/service-policy").ArgumentConstraint[]>().notNull(),
  grantedBy: text("granted_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (t) => [
  index("bot_mcp_grants_bot_idx").on(t.botId, t.botRevision),
  index("bot_mcp_grants_server_idx").on(t.serverId),
  uniqueIndex("bot_mcp_grants_active_idx").on(t.botId, t.serverId, t.toolName).where(sql`${t.revokedAt} is null`),
  check("bot_mcp_grants_effect_check", sql`${t.effect} in ('read', 'write')`),
  check("bot_mcp_grants_write_approval_check", sql`${t.effect} <> 'write' or ${t.requireApproval}`),
]);

export const inboxItems = pgTable(
  "inbox_items",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind")
      .$type<"approval" | "routine_result" | "routine_error" | "task_result" | "task_error">()
      .notNull(),
    title: text("title").notNull(),
    body: text("body"),
    conversationId: text("conversation_id").references(() => conversations.id, {
      onDelete: "cascade",
    }),
    routineRunId: text("routine_run_id").references(() => routineRuns.id, {
      onDelete: "cascade",
    }),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("inbox_user_idx").on(t.userId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Durable runs (src/lib/runs): every direct-chat and routine turn runs in the worker
// ---------------------------------------------------------------------------

export type AgentRunStatus = "queued" | "running" | "waiting" | "waiting_tasks" | "succeeded" | "failed" | "cancelled" | "interrupted";

/** One row per assistant message; an approval pauses it (`waiting`) and the answer requeues its next segment. */
export const agentRuns = pgTable(
  "agent_runs",
  {
    id: id(),
    /** The acting principal: credentials, sandbox and tools belong to this user. */
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    /** The assistant message this run writes (no FK: the row appears when the first segment is saved). */
    messageId: text("message_id").notNull(),
    /** The user message being answered. */
    parentMessageId: text("parent_message_id"),
    appId: text("app_id"), // snapshots for audit; the executor re-checks access every segment
    botId: text("bot_id"),
    routineRunId: text("routine_run_id").references(() => routineRuns.id, { onDelete: "set null" }),
    /** Started by a schedule or webhook (nobody watching the first segment). */
    background: boolean("background").notNull().default(false),
    /** Inline delegates are owned by their parent invocation, never by the job queue. */
    executionMode: text("execution_mode").$type<"worker" | "inline_delegate" | "async_delegate">().notNull().default("worker"),
    /** Created for an approval that was pending before durable runs existed: continues, but has no events to replay. */
    legacy: boolean("legacy").notNull().default(false),
    status: text("status").$type<AgentRunStatus>().notNull().default("queued"),
    segment: integer("segment").notNull().default(0),
    /** Last event seq before the current segment; a continuation's live tail starts after it. */
    boundarySeq: integer("boundary_seq").notNull().default(0),
    lastSeq: integer("last_seq").notNull().default(0),
    /** Worker instance executing the current segment; every executor write is fenced on it. */
    holder: text("holder"),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    /** Provider state needed to continue after a pause without the live stream (e.g. Hermes run, event cursor). */
    resumeState: jsonb("resume_state").$type<Record<string, unknown>>(),
    billingSource: text("billing_source").$type<BillingSource>(),
    /** User-facing, redacted. */
    error: text("error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("agent_runs_message_idx").on(t.messageId),
    uniqueIndex("agent_runs_active_conversation_idx")
      .on(t.conversationId)
      .where(sql`${t.status} in ('running', 'waiting_tasks') or (${t.status} = 'queued' and ${t.executionMode} <> 'async_delegate')`),
    index("agent_runs_user_active_idx")
      .on(t.userId)
      .where(sql`${t.status} in ('queued', 'running')`),
    index("agent_runs_conversation_idx").on(t.conversationId, t.updatedAt),
    index("agent_runs_user_bot_activity_idx").on(t.userId, t.botId, t.updatedAt),
    index("agent_runs_open_idx")
      .on(t.status, t.heartbeatAt)
      .where(sql`${t.status} in ('queued', 'running', 'waiting', 'waiting_tasks')`),
    index("agent_runs_finished_idx").on(t.finishedAt),
    index("agent_runs_routine_idx").on(t.routineRunId),
    check(
      "agent_runs_status_check",
      sql`${t.status} in ('queued', 'running', 'waiting', 'waiting_tasks', 'succeeded', 'failed', 'cancelled', 'interrupted')`,
    ),
    check("agent_runs_seq_check", sql`${t.boundarySeq} <= ${t.lastSeq}`),
    check("agent_runs_execution_mode_check", sql`${t.executionMode} in ('worker', 'inline_delegate', 'async_delegate')`),
    check("agent_runs_inline_check", sql`${t.executionMode} <> 'inline_delegate' or (${t.status} not in ('queued', 'waiting', 'waiting_tasks') and ${t.routineRunId} is null and ${t.segment} = 0)`),
    check("agent_runs_async_check", sql`${t.executionMode} <> 'async_delegate' or (${t.routineRunId} is null and ${t.background} and ${t.status} <> 'waiting')`),
  ],
);

/** Preferences never change the shared Hermes profile. Admission snapshots them under the user's run lock. */
export const hermesChatSettings = pgTable("hermes_chat_settings", {
  conversationId: text("conversation_id").primaryKey().references(() => conversations.id, { onDelete: "cascade" }),
  targetKey: text("target_key").notNull(),
  model: text("model"),
  revision: integer("revision").notNull().default(0),
});

/** Durable upstream identity, retained after agent_runs.resume_state is cleared on completion. No credentials. */
export const hermesRunContexts = pgTable("hermes_run_contexts", {
  runId: text("run_id").primaryKey().references(() => agentRuns.id, { onDelete: "cascade" }),
  targetKey: text("target_key").notNull(),
  model: text("model"),
  upstreamRunId: text("upstream_run_id"),
  stopState: text("stop_state").$type<"pending" | "confirmed">(),
  provisionId: text("provision_id"),
});

/** Operator-registered isolation boundary, one per user. Deletion is intentionally restricted. */
export const hermesConnections = pgTable("hermes_connections", {
  id: id(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  boundaryId: text("boundary_id").notNull(),
  dashboardUrl: text("dashboard_url").notNull(),
  runsUrl: text("runs_url").notNull(),
  protocol: text("protocol").notNull(),
  expectedVersion: text("expected_version").notNull(),
  expectedDisplayVersion: text("expected_display_version").notNull(),
  provider: text("provider").notNull(),
  credentialsEnc: text("secret_enc").notNull(),
  quota: integer("quota").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("hermes_connections_user_idx").on(t.userId),
  uniqueIndex("hermes_connections_boundary_idx").on(t.boundaryId),
  uniqueIndex("hermes_connections_dashboard_idx").on(t.dashboardUrl),
  uniqueIndex("hermes_connections_runs_idx").on(t.runsUrl),
  check("hermes_connections_quota_check", sql`${t.quota} between 1 and 100`),
]);

/** Durable reservation survives remote failure and conversation deletion. Never garbage-collect profile memory. */
export const hermesProvisions = pgTable("hermes_provisions", {
  id: id(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  botId: text("bot_id").notNull(), // retained tombstone after a bot is removed
  appId: text("app_id").notNull(),
  connectionId: text("connection_id").notNull().references(() => hermesConnections.id, { onDelete: "restrict" }),
  profile: text("profile").notNull(),
  keySlot: integer("key_slot").notNull(),
  specHash: text("spec_hash").notNull(),
  status: text("status").$type<"pending" | "provisioning" | "ready" | "failed">().notNull().default("pending"),
  createAttempted: boolean("create_attempted").notNull().default(false),
  lease: text("lease"),
  retryAfter: timestamp("retry_after", { withTimezone: true }),
  attempts: integer("attempts").notNull().default(0),
  error: text("error"), // controlled public messages only; never upstream bodies
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex("hermes_provisions_user_bot_idx").on(t.userId, t.botId),
  uniqueIndex("hermes_provisions_slot_idx").on(t.connectionId, t.keySlot),
  uniqueIndex("hermes_provisions_profile_idx").on(t.connectionId, t.profile),
  check("hermes_provisions_status_check", sql`${t.status} in ('pending', 'provisioning', 'ready', 'failed')`),
]);

/** A run's UI message stream, in order; the browser tails it live and a reload replays it. */
export const runEvents = pgTable(
  "run_events",
  {
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    segment: integer("segment").notNull(),
    kind: text("kind").$type<"chunk" | "segment-end">().notNull().default("chunk"),
    chunk: jsonb("chunk").$type<Record<string, unknown>>(),
    /** Live-only chunks (title, notices): relayed to the tail, never replayed. */
    transient: boolean("transient").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.seq] }),
    check("run_events_kind_check", sql`${t.kind} in ('chunk', 'segment-end')`),
  ],
);

/** An immutable assignment. Nullable navigation refs preserve receipts after a conversation is deleted. */
export const delegatedTasks = pgTable("delegated_tasks", {
  id: id(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  originConversationId: text("origin_conversation_id").references(() => conversations.id, { onDelete: "set null" }),
  /** Server-allocated turn id, retained for idempotency even before/after the origin message exists. */
  originMessageId: text("origin_message_id").notNull(),
  originToolCallId: text("origin_tool_call_id").notNull(),
  parentRunId: text("parent_run_id").references(() => agentRuns.id, { onDelete: "set null" }),
  parentTaskId: text("parent_task_id"),
  rootTaskId: text("root_task_id").notNull(),
  rootMessageId: text("root_message_id").notNull(),
  assignerBotId: text("assigner_bot_id").notNull(),
  receiverBotId: text("receiver_bot_id").notNull(),
  assignerName: text("assigner_name").notNull(),
  receiverName: text("receiver_name").notNull(),
  childConversationId: text("child_conversation_id").references(() => conversations.id, { onDelete: "set null" }),
  childRunId: text("child_run_id").references(() => agentRuns.id, { onDelete: "set null" }),
  /** Conversation order, independent of invocation ancestry and provider call IDs. */
  turn: integer("turn").notNull().default(1),
  continuedFromTaskId: text("continued_from_task_id"),
  inputHash: text("input_hash").notNull(),
  mode: text("mode").$type<"sync" | "async">().notNull().default("sync"),
  parentSegment: integer("parent_segment").notNull().default(0),
  depth: integer("depth").notNull(),
  ancestry: jsonb("ancestry").$type<{ from: string; to: string; mode?: "manual" | "coordinator" }[]>().notNull(),
  sessionVersion: integer("session_version").notNull(),
  deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
  returnedAt: timestamp("returned_at", { withTimezone: true }),
  parentResultSeq: integer("parent_result_seq"),
  notifiedAt: timestamp("notified_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("delegated_tasks_origin_idx").on(t.userId, t.originMessageId, t.originToolCallId),
  uniqueIndex("delegated_tasks_conversation_turn_idx").on(t.childConversationId, t.turn),
  uniqueIndex("delegated_tasks_run_idx").on(t.childRunId),
  index("delegated_tasks_receiver_idx").on(t.userId, t.receiverBotId, t.createdAt),
  index("delegated_tasks_root_idx").on(t.userId, t.rootMessageId),
  index("delegated_tasks_parent_idx").on(t.parentRunId),
  index("delegated_tasks_async_pending_idx").on(t.parentRunId, t.parentSegment).where(sql`${t.mode} = 'async' and ${t.returnedAt} is null`),
  check("delegated_tasks_mode_check", sql`${t.mode} in ('sync', 'async')`),
  check("delegated_tasks_segment_check", sql`${t.parentSegment} >= 0`),
  check("delegated_tasks_turn_check", sql`${t.turn} >= 1`),
  check("delegated_tasks_depth_check", sql`${t.depth} between 1 and 2`),
]);

// ---------------------------------------------------------------------------
// Settings & audit
// ---------------------------------------------------------------------------

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: updatedAt(),
});

export const auditLog = pgTable(
  "audit_log",
  {
    id: id(),
    actorId: text("actor_id").references(() => users.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    target: text("target"),
    details: jsonb("details"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_created_idx").on(t.createdAt)],
);

export type User = typeof users.$inferSelect;
export type AiApp = typeof aiApps.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type Bot = typeof bots.$inferSelect;
export type Skill = typeof skills.$inferSelect;
export type Routine = typeof routines.$inferSelect;
export type McpServer = typeof mcpServers.$inferSelect;
export type SandboxRow = typeof sandboxes.$inferSelect;
export type UsageEvent = typeof usageEvents.$inferInsert;
export type UserCredential = typeof userCredentials.$inferSelect;
export type Attachment = typeof attachments.$inferSelect;
export type AgentRun = typeof agentRuns.$inferSelect;
export type RunEvent = typeof runEvents.$inferSelect;
