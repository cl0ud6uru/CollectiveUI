import "server-only";
import { auth } from "@/auth";
import { loadPrincipal, type Principal } from "@/lib/auth/groups";
import { activeWebSession, webSessionRegistryEnabled } from "@/lib/auth/web-sessions";
import { getOwnedConversation, HttpError } from "@/lib/authz";
import { resolveTurnTarget } from "@/lib/agent/target";
import { codexPolicy } from "@/lib/codex/store";
import { callerRuntime, assertRuntimeOwner, runtimeBinding } from "@/lib/codex/runtime";
import { personalAccount } from "@/personal-codex/accounts";

export type AuthorizedComputerView = {
  ownerUserId: string;
  conversationId: string;
  sessionId: string;
  botId: string;
  targetAppId: string;
  runtimeBinding: string;
  credentialBinding: string;
  socketPath: string;
  authorize: () => Promise<void>;
};

function unavailable() { throw new HttpError(503, "Computer view is unavailable."); }

/** Resolve a single account-owned managed personal Codex computer; conversationId is only its authorized selector. */
export async function computerViewForConversation(principal: Principal, conversationId: string): Promise<AuthorizedComputerView> {
  if (process.env.COMPUTER_VIEW_ENABLED !== "1" || !webSessionRegistryEnabled()) unavailable();
  const session = await auth();
  if (!session?.user?.id || session.user.id !== principal.user.id || session.user.mustChangePassword ||
      session.user.sessionVersion !== principal.user.sessionVersion || !session.user.sessionId ||
      !await activeWebSession({ userId: session.user.id, sessionId: session.user.sessionId, sessionVersion: session.user.sessionVersion }))
    throw new HttpError(401, "Unauthorized");

  const fresh = await loadPrincipal(principal.user.id);
  if (!fresh || fresh.user.sessionVersion !== principal.user.sessionVersion) throw new HttpError(401, "Unauthorized");
  const conversation = await getOwnedConversation(fresh, conversationId);
  if (conversation.source !== "chat" || conversation.isGroup || !conversation.botId) throw new HttpError(404, "Conversation not found.");
  const target = await resolveTurnTarget(fresh, conversation);
  const bot = target.bot;
  if (!bot || bot.id !== conversation.botId || bot.executionMode !== "caller" || bot.hermesTeam || target.app.providerConfig?.codexHarness !== true) unavailable();

  const policy = await codexPolicy(bot!.id);
  if (!policy) throw new HttpError(503, "Computer view is unavailable.");
  const runtime = await callerRuntime(fresh.user.id, policy.funding);
  assertRuntimeOwner(runtime, fresh.user);
  const socketPath = runtime.socketPath;
  if (!runtime.managed || runtime.ownerId !== fresh.user.id || !socketPath) throw new HttpError(503, "Computer view is unavailable.");
  const account = await personalAccount(fresh.user.id);
  if (!account || account.credentialBinding !== runtime.credentialBinding) unavailable();

  const result: AuthorizedComputerView = {
    ownerUserId: fresh.user.id,
    conversationId,
    sessionId: session.user.sessionId,
    botId: bot!.id,
    targetAppId: target.app.id,
    runtimeBinding: runtimeBinding(runtime),
    credentialBinding: account.credentialBinding,
    socketPath,
    authorize: async () => reauthorizeComputerView(fresh, conversationId, session.user.sessionId, {
      botId: bot!.id, targetAppId: target.app.id, runtimeBinding: runtimeBinding(runtime),
      credentialBinding: account.credentialBinding, socketPath,
    }),
  };
  return result;
}

/** Long polls and streams re-read Auth.js, the revocation registry, the principal, bot/app, and credential binding. */
export async function reauthorizeComputerView(original: Principal, conversationId: string, sessionId: string,
  expected: Pick<AuthorizedComputerView, "botId" | "targetAppId" | "runtimeBinding" | "credentialBinding" | "socketPath">): Promise<void> {
  if (process.env.COMPUTER_VIEW_ENABLED !== "1" || !webSessionRegistryEnabled()) throw new HttpError(401, "Unauthorized");
  const session = await auth();
  if (!session?.user?.id || session.user.id !== original.user.id || session.user.sessionId !== sessionId ||
      session.user.mustChangePassword || session.user.sessionVersion !== original.user.sessionVersion ||
      !await activeWebSession({ userId: session.user.id, sessionId, sessionVersion: session.user.sessionVersion }))
    throw new HttpError(401, "Unauthorized");
  const fresh = await loadPrincipal(original.user.id);
  if (!fresh || fresh.user.sessionVersion !== original.user.sessionVersion) throw new HttpError(401, "Unauthorized");
  const conversation = await getOwnedConversation(fresh, conversationId);
  if (conversation.source !== "chat" || conversation.isGroup || !conversation.botId) throw new HttpError(404, "Conversation not found.");
  const target = await resolveTurnTarget(fresh, conversation);
  if (!target.bot || target.bot.id !== conversation.botId || target.bot.id !== expected.botId || target.bot.executionMode !== "caller" ||
      target.bot.hermesTeam || target.app.id !== expected.targetAppId || target.app.providerConfig?.codexHarness !== true)
    throw new HttpError(404, "Computer not found.");
  const policy = await codexPolicy(target.bot.id);
  if (!policy) throw new HttpError(404, "Computer not found.");
  const runtime = await callerRuntime(fresh.user.id, policy.funding);
  assertRuntimeOwner(runtime, fresh.user);
  const account = runtime.managed ? await personalAccount(fresh.user.id) : null;
  if (!runtime.managed || !runtime.socketPath || runtime.ownerId !== fresh.user.id || !account ||
      account.credentialBinding !== runtime.credentialBinding || account.credentialBinding !== expected.credentialBinding ||
      runtimeBinding(runtime) !== expected.runtimeBinding || runtime.socketPath !== expected.socketPath)
    throw new HttpError(404, "Computer not found.");
}
