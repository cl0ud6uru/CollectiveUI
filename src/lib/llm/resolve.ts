import { nativeSearchMiddleware, type NativeSearchOptions } from "./native-search";
import { db, type DbOrTx } from '@/db';
import { nativeSearchCapability } from "@/lib/native-search-policy";
import { isDockerHermes } from "@/lib/docker-hermes/policy";
import { freshDocker } from "@/lib/docker-hermes/store";
import { dockerFetch, dockerControl } from "@/lib/docker-hermes/client";
import { bindingSchema, type DockerStatus } from "@/docker-hermes/types";
import { loadPrincipal } from "@/lib/auth/groups";
import { HERMES_BOT_ONLY_MESSAGE } from "./model-policy";
import { createHash } from "node:crypto";
import { wrapLanguageModel } from "ai";
import type { AiApp } from "@/db/schema";
import type { Principal } from "@/lib/auth/groups";
import type { RunHandle } from "@/lib/runs/types";
import { getSetting } from "@/lib/settings";
import { isAnthropicFamily, isEnabledKind, readChatGPTConfig, readProviderConfig, speaksResponses, supportsEmbeddings, type EnabledKind } from "./catalog";
import { chatgptBackendUrl } from "./chatgpt/constants";
import { chatgptFetch } from "./chatgpt/fetch";
import { chatgptMiddleware } from "./chatgpt/middleware";
import { accountRejection, userMayUseChatGPT } from "./chatgpt/policy";
import { getChatGPTAuth, saveRateLimits } from "./chatgpt/store";
import { ProviderConfigError, ProviderUnavailableError } from "./errors";
import type { BillingSource, ModelPurpose, ProviderKind } from "./kinds";
import { defaultsMiddleware, usageMiddleware } from "./middleware";
import { chatgpt, PROVIDERS, type ChatModel, type EmbedModel, type ProviderContext } from "./providers";
import { checkHermesUrl, HermesLanguageModel, hermesTarget, stopRun as stopHermesRunOn, type HermesTarget } from "./providers/hermes";
import { activeProviderConnection, connectionConfig, openProviderCredential } from "./provider-connections";
import { decodeSecret, openAppSecret, SecretError, type AppSecret } from "./secrets";
import { allowedHermesModels, hermesTargetKey } from "./providers/hermes/scope";
import type { UsageContext, UsageScope } from "./usage";
import { isManagedHermes } from "@/lib/hermes-provisioning/config";
import { assertManagedConversation, managedTarget } from "@/lib/hermes-provisioning/store";
import { isLocalHermes, localBinding } from "@/lib/local-hermes/config";
import { LOCAL_ORIGIN, localControl, localSocketPath, socketFetch } from "@/lib/local-hermes/client";

export type ResolveModelOptions = {
  /** Company utility admission can hold a transaction; reuse it for saved-provider reads. */
  q?: DbOrTx;
  nativeSearch?: NativeSearchOptions;
  purpose: ModelPurpose;
  /** The acting user (chatting user or routine owner). */
  principal?: Principal;
  /** For background work without a principal (memory extraction runs as the conversation owner). */
  userId?: string | null;
  conversationId?: string | null;
  botId?: string | null;
  toolCallId?: string | null;
  usage?: UsageScope;
  /**
   * Nobody is watching live (a routine's first segment, and delegates it starts). Personal plans refuse these unless
   * an admin allows it. Says nothing about pausing at approvals: that's `interactive`.
   */
  background?: boolean;
  /**
   * The turn runs in the run executor, which can pause at an approval and continue once someone answers (chat, and
   * routines through the Inbox). Only honoured for purpose "chat"; delegates and group chats can't pause.
   */
  interactive?: boolean;
  /** The durable run executing this turn (providers that keep state across an approval pause save it here). */
  run?: RunHandle;
};

/** How instructions should be shaped for this model (see src/lib/agent/instructions.ts). */
export type InstructionStyle = "legacy" | "stable-first" | "anthropic-cache";

export type ModelCapabilities = { instructionStyle: InstructionStyle; embeddings: boolean; responses: boolean };

export type ResolvedModel = {
  model: ChatModel;
  billing: { source: BillingSource; appId: string; providerKind: ProviderKind; modelId: string; credentialId: string | null };
  capabilities: ModelCapabilities;
  /**
   * Opaque id of the account whose sealed reasoning this model may replay (ChatGPT plans: the person's connection
   * and ChatGPT account). Null for company credentials. See src/lib/agent/replay.ts.
   */
  replayKey: string | null;
};

type AppRow = Pick<AiApp, "id" | "name" | "provider" | "providerConfig" | "baseUrl" | "apiKeyEnc" | "credentialMode" | "model" | "embeddingModel"> & { providerConnectionId?: string | null };

function enabledKindOf(app: AppRow): EnabledKind {
  if (!isEnabledKind(app.provider)) throw new ProviderUnavailableError(`${app.name} isn't available with company credentials.`);
  // Company-credential kinds only; personal plans (ChatGPT) are resolved per person in resolveChatGPT.
  if (app.credentialMode !== "org") throw new ProviderUnavailableError(`${app.name} needs a personal connection, which isn't available for this provider.`);
  return app.provider;
}

/** Builds the provider context from an app row: parsed config and decoded credentials, never the environment. */
export async function providerContextFor(app: AppRow, extra: Pick<ProviderContext, "fetch" | "generateAuthToken"> = {}, q: DbOrTx = db): Promise<ProviderContext> {
  const kind = enabledKindOf(app);
  const connection = app.providerConnectionId ? await activeProviderConnection(app.providerConnectionId, q) : undefined;
  if (connection && kind !== connection.provider) throw new ProviderConfigError(app.name, "saved provider connection kind mismatch");
  const config = connection ? connectionConfig(connection, app.providerConfig) : readProviderConfig(kind, app.providerConfig);
  if (!config) throw new ProviderConfigError(app.name, `${kind}: invalid provider_config`);
  let secret: AppSecret | undefined;
  let plaintext: string | undefined;
  try {
    plaintext = connection ? openProviderCredential(connection) : openAppSecret(app);
  } catch {
    throw new ProviderConfigError(app.name, `${kind}: stored credentials can't be decrypted (check ENCRYPTION_KEYS)`);
  }
  if (plaintext) {
    try {
      secret = decodeSecret(kind, config, plaintext);
    } catch (err) {
      throw new ProviderConfigError(app.name, err instanceof SecretError ? err.message : "invalid stored credentials");
    }
  } else if (kind !== "openai-compatible") {
    throw new ProviderConfigError(app.name, `${kind}: no credentials stored`);
  }
  return { appId: app.id, appName: app.name, kind, baseUrl: connection ? connection.baseUrl : app.baseUrl, config, secret, ...extra };
}

export function capabilitiesFor(app: AppRow): ModelCapabilities {
  const kind = app.provider;
  if (kind === "chatgpt") return { instructionStyle: "stable-first", embeddings: false, responses: true };
  if (kind === "hermes") return { instructionStyle: "legacy", embeddings: false, responses: false };
  const config = readProviderConfig(enabledKindOf(app), app.providerConfig) as { promptCaching?: boolean } | null;
  const instructionStyle: InstructionStyle =
    kind === "openai-compatible" ? "legacy" : isAnthropicFamily(kind, config, app.model) && config?.promptCaching !== false ? "anthropic-cache" : "stable-first";
  return { instructionStyle, embeddings: supportsEmbeddings(kind), responses: speaksResponses(kind) };
}

function usageContext(
  app: AppRow,
  opts: ResolveModelOptions,
  model: string,
  billing: { source: BillingSource; credentialId: string | null } = { source: "org", credentialId: null },
): UsageContext {
  return {
    purpose: opts.purpose,
    billingSource: billing.source,
    credentialId: billing.credentialId,
    providerKind: app.provider,
    model,
    appId: app.id,
    userId: opts.userId ?? opts.principal?.user.id ?? null,
    conversationId: opts.conversationId ?? null,
    botId: opts.botId ?? null,
    toolCallId: opts.toolCallId ?? null,
    scope: opts.usage,
  };
}

/**
 * The single place that turns an app into a language model. Credentials are passed explicitly (never read from
 * the environment), provider defaults are applied for native providers, and every call is recorded in the usage
 * ledger. OpenAI-compatible apps send exactly the same requests as before the registry existed.
 */
export async function resolveModel(app: AiApp, opts: ResolveModelOptions): Promise<ResolvedModel> {
  if (opts.run?.hermes && app.provider !== "hermes") throw new ProviderUnavailableError("This run's backend changed. Start a new chat with the updated bot.");
  if (app.provider === "chatgpt") return resolveChatGPT(app, opts);
  if (app.provider === "hermes") return resolveHermes(app, opts);
  const ctx = await providerContextFor(app, {}, opts.q);
  if (opts.nativeSearch) {
    const reason = nativeSearchCapability(app, ctx.baseUrl);
    if (reason) throw new ProviderUnavailableError(reason);
  }
  const instance = await PROVIDERS[ctx.kind].create(ctx);
  const middleware = [usageMiddleware(usageContext(app, opts, app.model))];
  if (opts.nativeSearch) middleware.unshift(nativeSearchMiddleware(usageContext(app, opts, app.model), opts.nativeSearch));
  if (ctx.kind !== "openai-compatible") middleware.unshift(defaultsMiddleware(ctx.kind, ctx.config, app.model, opts.purpose));
  return {
    model: wrapLanguageModel({ model: instance.chat(app.model), middleware }),
    billing: { source: "org", appId: app.id, providerKind: app.provider, modelId: app.model, credentialId: null },
    capabilities: capabilitiesFor(app),
    replayKey: null,
  };
}

/** Embedding model for an app that has one configured. Usage is recorded by the caller (src/lib/llm/embeddings.ts). */
export async function resolveEmbeddingModel(app: AiApp, q: DbOrTx = db): Promise<EmbedModel> {
  const ctx = await providerContextFor(app, {}, q);
  if (!app.embeddingModel || !supportsEmbeddings(ctx.kind)) throw new ProviderUnavailableError(`${app.name} doesn't provide embeddings.`);
  const instance = await PROVIDERS[ctx.kind].create(ctx);
  if (!instance.embedding) throw new ProviderUnavailableError(`${app.name} doesn't provide embeddings.`);
  return instance.embedding(app.embeddingModel);
}

/** Purposes a Hermes profile serves: conversations, never background work (titles, memory, drafts, embeddings). */
const HERMES_PURPOSES: readonly ModelPurpose[] = ["chat", "group", "delegate"];

/** Where a Hermes app's requests go, with its sealed key opened; refused when the URL isn't safe for the key. */
export async function hermesTargetFor(app: AiApp, scope?: { userId: string; botId: string; provisionId?: string | null; verify?: boolean }): Promise<{ target: HermesTarget; approvalTimeoutSec: number }> {
  if (isDockerHermes(app)) {
    const b = bindingSchema.parse(app.providerConfig.docker);
    if (!scope || scope.userId !== b.ownerId || scope.botId !== b.botId) throw new ProviderUnavailableError("Personal Hermes requires its paired owner and bot.");
    const p = await loadPrincipal(scope.userId);
    if (!p) throw new ProviderUnavailableError("Your runtime access was revoked.");
    await freshDocker(p);
    const status = await dockerControl<DockerStatus>(p.user.id, "/control/status");
    if (status.phase !== "ready" || !status.bindings.some(x => JSON.stringify(bindingSchema.parse(x)) === JSON.stringify(b)))
      throw new ProviderUnavailableError("Your native runtime is stopped or its binding changed. Check Personal Hermes in Settings.");
    return { target: { baseUrl: LOCAL_ORIGIN, profile: b.bindingId, apiKey: "", fetch: dockerFetch(p.user.id), local: true }, approvalTimeoutSec: 300 };
  }
  if (isLocalHermes(app)) {
    const binding = localBinding(app);
    if (!scope || scope.userId !== binding.ownerId || scope.botId !== binding.botId)
      throw new ProviderUnavailableError("Local Hermes requires its paired owner and bot.");
    const status = await localControl("status");
    if (status.runtimeId !== binding.runtimeId || status.binding?.bindingId !== binding.bindingId ||
        status.binding.botId !== binding.botId || status.binding.ownerId !== binding.ownerId ||
        status.binding.model !== binding.model || status.binding.provider !== binding.provider)
      throw new ProviderUnavailableError("The local engine binding changed. Restore the original controller and profile; no fallback engine was selected.");
    return { target: { baseUrl: LOCAL_ORIGIN, profile: binding.bindingId, apiKey: "", fetch: socketFetch(localSocketPath()), local: true }, approvalTimeoutSec: 300 };
  }
  if (isManagedHermes(app)) {
    if (!scope) throw new ProviderUnavailableError("Choose a bot to use an automatic Hermes profile. An owned user and bot binding is required.");
    return managedTarget(scope.userId, scope.botId, app.id, scope.provisionId, scope.verify);
  }
  const ctx = await providerContextFor(app);
  const target = hermesTarget(ctx);
  const problem = await checkHermesUrl(target.baseUrl);
  if (problem) throw new ProviderUnavailableError(`${app.name} can't be reached safely: ${problem}.`);
  return { target, approvalTimeoutSec: (ctx.config as { approvalTimeoutSec: number }).approvalTimeoutSec };
}

/**
 * A Hermes profile: an agent server that runs its own tools and model and keeps the conversation (one Hermes session
 * per portal conversation and bot). Built per turn: only a chat turn in the run executor (`interactive`, routines
 * included) can pause at Hermes' approvals; delegates and group chats deny them. Usage is recorded from what Hermes
 * reports for each finished run.
 */
async function resolveHermes(app: AiApp, opts: ResolveModelOptions): Promise<ResolvedModel> {
  if (!HERMES_PURPOSES.includes(opts.purpose)) throw new ProviderUnavailableError(`${app.name} is a Hermes bot, so it can't be used for background work.`);
  if (!opts.botId) throw new ProviderUnavailableError(HERMES_BOT_ONLY_MESSAGE);
  const snapshot = opts.run?.hermes;
  if (snapshot && (snapshot.targetKey !== hermesTargetKey(app) || (snapshot.model && !allowedHermesModels(app).includes(snapshot.model))))
    throw new ProviderUnavailableError("This run's Hermes connection or model permission changed. Start a new chat after the admin restores access.");
  const userId = opts.userId ?? opts.principal?.user.id ?? null;
  const conversationId = opts.conversationId ?? null;
  if (isLocalHermes(app) && (opts.purpose !== "chat" || opts.background || !opts.interactive || (!isDockerHermes(app) && !opts.principal?.isAdmin) || !opts.principal ||
      opts.principal.user.id !== localBinding(app).ownerId || !conversationId || !snapshot || snapshot.model))
    throw new ProviderUnavailableError("Local Hermes supports its paired administrator's direct text chat only. Group, delegated, background and conversation model overrides are not supported.");
  if (isManagedHermes(app)) {
    if (opts.purpose !== "chat" || opts.background || !opts.interactive || !userId || !opts.botId || !conversationId || !snapshot?.provisionId)
      throw new ProviderUnavailableError("Automatic Hermes profiles support direct bot chats only. Group, delegated and background execution are not enabled.");
    await assertManagedConversation(userId, opts.botId, conversationId);
  }
  const { target, approvalTimeoutSec } = await hermesTargetFor(app, userId && opts.botId ? { userId, botId: opts.botId, provisionId: snapshot?.provisionId, verify: true } : undefined);
  const model = new HermesLanguageModel(app.model, {
    target,
    sessionId: conversationId ? `portal-${conversationId}${opts.botId ? `-${opts.botId}` : ""}` : null,
    // Session hint only, never a tenant boundary. Managed profiles use operator-isolated runtimes per user.
    sessionKey: userId ? `portal-${createHash("sha256").update(`${app.id}:${userId}${isManagedHermes(app) ? `:${opts.botId}` : ""}`).digest("hex").slice(0, 24)}` : null,
    interactive: opts.purpose === "chat" && opts.interactive === true,
    approvalTimeoutSec,
    run: opts.run,
    requestedModel: snapshot?.model,
  });
  const billing = { source: "hermes" as const, credentialId: null };
  return {
    model: wrapLanguageModel({ model, middleware: [usageMiddleware(usageContext(app, opts, app.model, billing), { skipUnknown: true })] }),
    billing: { ...billing, appId: app.id, providerKind: "hermes", modelId: app.model },
    capabilities: capabilitiesFor(app),
    replayKey: null,
  };
}

/**
 * Asks a Hermes app to stop one of its runs (a waiting run that was superseded or cancelled). Best effort: never
 * throws, and gives up after 10 s.
 */
export async function stopHermesRun(app: AiApp, hermesRunId: string): Promise<void> {
  try {
    if (app.provider !== "hermes") return;
    const { target } = await hermesTargetFor(app);
    await stopHermesRunOn(target, hermesRunId); // 10 s timeout
  } catch (err) {
    console.warn(`[hermes] couldn't stop run ${hermesRunId} on ${app.name}:`, err instanceof Error ? err.message : String(err));
  }
}

/** Interactive purposes a personal plan may be used for. Titles, memory, drafts and embeddings never are. */
const PERSONAL_PLAN_PURPOSES: readonly ModelPurpose[] = ["chat", "group", "delegate"];

/**
 * A ChatGPT app runs on the acting person's own ChatGPT plan: only for interactive chat (not background work), only
 * when the admin has the feature on and allows this person and their account, and only with their own connection.
 * A fresh provider and fetch are built per turn (the fetch carries the turn-state header for that turn only).
 */
async function resolveChatGPT(app: AiApp, opts: ResolveModelOptions): Promise<ResolvedModel> {
  const principal = opts.principal;
  if (!principal || !PERSONAL_PLAN_PURPOSES.includes(opts.purpose)) {
    throw new ProviderUnavailableError(`${app.name} runs on each person's own ChatGPT plan, so it can't be used for background work.`);
  }
  const settings = await getSetting("chatgpt");
  if (!settings.enabled) throw new ProviderUnavailableError(`${app.name} is unavailable: Sign in with ChatGPT is turned off. Pick another model.`);
  if (!userMayUseChatGPT(principal, settings)) throw new ProviderUnavailableError(`You haven't been given access to ${app.name}. Pick another model.`);
  if (opts.background && !settings.allowBackground) {
    throw new ProviderUnavailableError(`${app.name} uses the owner's own ChatGPT plan, which routines can't use. Pick a company model for this bot.`);
  }

  const userId = principal.user.id;
  // Fails fast (before any streaming) when the person hasn't connected or must reconnect.
  const auth = await getChatGPTAuth(userId);
  // Admin rules can tighten after someone connected (e.g. personal plans switched off).
  const rejection = accountRejection(auth, settings);
  if (rejection) throw new ProviderUnavailableError(rejection);

  const conversationId = opts.conversationId ?? null;
  let first: typeof auth | undefined = auth;
  const fetch = chatgptFetch({
    conversationId,
    getAuth: async ({ rejectedToken }) => {
      // Reuse the token fetched above for the first request; later steps re-check (and refresh) as needed.
      if (first && !rejectedToken) {
        const a = first;
        first = undefined;
        return a;
      }
      return getChatGPTAuth(userId, { rejectedToken });
    },
    onRateLimits: throttledRateLimitWriter(),
  });
  const provider = await chatgpt.create({ baseURL: `${chatgptBackendUrl()}/codex`, fetch });
  const { reasoningEffort } = readChatGPTConfig(app.providerConfig);
  const billing = { source: "chatgpt_plan" as const, credentialId: auth.credentialId };
  return {
    model: wrapLanguageModel({
      model: provider.chat(app.model),
      middleware: [
        chatgptMiddleware({ conversationId, reasoningEffort: reasoningEffort === "default" ? undefined : reasoningEffort }),
        usageMiddleware(usageContext(app, opts, app.model, billing)),
      ],
    }),
    billing: { ...billing, appId: app.id, providerKind: "chatgpt", modelId: app.model },
    capabilities: capabilitiesFor(app),
    replayKey: chatgptReplayKey(auth.credentialId, auth.accountId),
  };
}

/** Stored on each ChatGPT reply; not reversible to the account id (message metadata reaches browsers and shares). */
export function chatgptReplayKey(credentialId: string, accountId: string): string {
  return createHash("sha256").update(`${credentialId}:${accountId}`).digest("hex").slice(0, 16);
}

/** Saves the plan usage the backend reports at most every 30 s per connection (fire and forget). */
function throttledRateLimitWriter() {
  let last = 0;
  return (credentialId: string, limits: Record<string, unknown>) => {
    if (Date.now() - last < 30_000) return;
    last = Date.now();
    void saveRateLimits(credentialId, limits).catch(() => {});
  };
}
