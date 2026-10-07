import { eq } from "drizzle-orm";
import { db, type DbOrTx } from "@/db";
import { settings } from "@/db/schema";
import { AAD, decryptOptional } from "@/lib/crypto";
import { DECISIONS_DEFAULTS } from "@/lib/decisions-policy";

export type BrandingSettings = {
  appName: string;
  welcomeText: string;
  logoEmoji: string;
  loginHeadline?: string;
  loginDescription?: string;
  /** Where new chats start for people without their own default: at most one of a model or a shared bot. */
  defaultAppId?: string;
  defaultBotId?: string;
};

export type CoordinatorSettings = {
  enabled: boolean;
  defaultBotId: string | null;
  /** Durable creation receipt. Retained when disabled, switched, or deleted. */
  starterBotId: string | null;
};

/** Sign-in page companion. A catalog pet is pinned to the revision an admin confirmed for public display. */
export type LoginPetSettings = {
  appearance: "off" | "moss" | "ember" | "catalog";
  catalogId: string | null;
  revision: string | null;
};

export type LimitsSettings = {
  uploadMaxMb: number;
  maxAttachmentsPerMessage: number;
};

/** Personal remote dashboard credentials are separate from shared and managed Hermes backends. */
export type RemoteHermesSettings = {
  enabled: boolean;
  /** Default off. Owners may confirm session-only YOLO changes on verified native runtimes. */
  allowSessionYolo?: boolean;
  /** Exact dashboard bases approved for connections to private/LAN/tailnet addresses. */
  privateGateways: string[];
};

export type ToolSettings = {
  /** built-in tool keys that are disabled org-wide */
  disabledTools: string[];
  /** tool names that always require approval regardless of bot/user config */
  enforcedApproval: string[];
  fetchAllowlist: string[]; // domains; empty = allow all public hosts
  webSearch: { provider: "none" | "searxng" | "brave" | "bing"; url?: string; apiKeyEnc?: string };
  nativeSearch?: import("./native-search-policy").NativeSearchSettings;
  maxStepsCap: number;
  botCreation: "everyone" | "groups" | "admins";
  /** app used for background tasks (titles, memory extraction) and embeddings */
  utilityAppId?: string;
  embeddingAppId?: string;
  /** Automatic private/shared procedure learning for native caller bots. */
  learningEnabled?: boolean;
  learningRequireApproval?: boolean;
  learningMaintenanceEnabled?: boolean;
  learningConsolidationEnabled?: boolean;
};

/**
 * "Sign in with ChatGPT": people connect their own ChatGPT plan and chat on it through the portal's agent loop.
 * Unofficial (it uses OpenAI's Codex sign-in and backend), so it's off until an admin turns it on and says who may
 * connect. API keys stay admin-only; this is the only personal credential people can add.
 */
export type ChatGPTSettings = {
  enabled: boolean;
  /** Who turned it on after reading the notice (audit trail shown in the admin form). */
  acknowledgedBy?: string;
  acknowledgedAt?: string;
  /** "everyone", or only members of allowedGroupIds and people listed in allowedUpns. */
  access: "everyone" | "selected";
  allowedGroupIds: string[];
  allowedUpns: string[];
  /** ChatGPT workspace (account) ids people may connect; empty = any. */
  allowedWorkspaceIds: string[];
  /** Allow personal plans (Free, Plus, Pro) as well as Business / Enterprise / Edu workspaces. */
  allowPersonalPlans: boolean;
  /** Let routines (background runs) use their owner's ChatGPT plan. */
  allowBackground: boolean;
};

/**
 * Workspaces (P5): each person's own sandboxed container that bots can run commands and edit files in. Off until an
 * admin turns it on and says who may use it. Capacity limits (memory, CPU, how many run at once) are set on sandboxd,
 * not here, so the portal can't raise them.
 */
export type SandboxSettings = {
  enabled: boolean;
  access: "everyone" | "selected";
  allowedGroupIds: string[];
  allowedUpns: string[];
  /** Run on plain runc when gVisor isn't available (weaker isolation); needs an acknowledgement. */
  allowRunc: boolean;
  runcAcknowledgedBy?: string;
  runcAcknowledgedAt?: string;
  /** Default and maximum time a command may run (sandboxd caps it further). */
  commandTimeoutSec: number;
  /** Output kept per command, for the model and the stored chat (head and tail). */
  outputKb: number;
  /** Days a disabled person's workspace is kept before it is destroyed. */
  deleteAfterDays: number;
};

const defaults = {
  officeBot: { botId: null } as { botId: string | null },
  decisions: DECISIONS_DEFAULTS,
  remoteHermes: { enabled: false, allowSessionYolo: false, privateGateways: [] } as RemoteHermesSettings,
  coordinator: { enabled: false, defaultBotId: null, starterBotId: null } as CoordinatorSettings,
  branding: { appName: "AI Portal", welcomeText: "What can I help with?", logoEmoji: "" } as BrandingSettings,
  // Separate from editable text so stale admin forms cannot resurrect a removed logo.
  brandingLogo: { id: null } as { id: string | null },
  loginPet: { appearance: "off", catalogId: null, revision: null } as LoginPetSettings,
  limits: { uploadMaxMb: 20, maxAttachmentsPerMessage: 10 } as LimitsSettings,
  tools: {
    disabledTools: [],
    enforcedApproval: [],
    fetchAllowlist: [],
    webSearch: { provider: "none" },
    nativeSearch: { enabled: false, maxCalls: 2, allowedDomains: [] },
    maxStepsCap: 25,
    botCreation: "everyone",
  } as ToolSettings,
  chatgpt: {
    enabled: false,
    access: "selected",
    allowedGroupIds: [],
    allowedUpns: [],
    allowedWorkspaceIds: [],
    allowPersonalPlans: false,
    allowBackground: false,
  } as ChatGPTSettings,
  sandbox: {
    enabled: false,
    access: "selected",
    allowedGroupIds: [],
    allowedUpns: [],
    allowRunc: false,
    commandTimeoutSec: 120,
    outputKb: 32,
    deleteAfterDays: 30,
  } as SandboxSettings,
};

type SettingsMap = typeof defaults;

export async function getSetting<K extends keyof SettingsMap>(key: K, q: DbOrTx = db): Promise<SettingsMap[K]> {
  const [row] = await q.select().from(settings).where(eq(settings.key, key));
  return { ...defaults[key], ...((row?.value as object) ?? {}) } as SettingsMap[K];
}

export async function setSetting<K extends keyof SettingsMap>(key: K, value: SettingsMap[K]) {
  await db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
}

export function webSearchApiKey(t: ToolSettings) {
  return decryptOptional(t.webSearch.apiKeyEnc, AAD.webSearchKey);
}
