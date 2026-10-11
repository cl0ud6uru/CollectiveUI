import { getOwnedConversation, HttpError } from "@/lib/authz";
import { resolveTurnTarget } from "@/lib/agent/target";
import type { VoiceTarget } from "./session";
import type { requirePrincipal } from "@/lib/session";

export async function targetFor(p: Awaited<ReturnType<typeof requirePrincipal>>, input: { appId?: string; botId?: string; conversationId?: string }): Promise<VoiceTarget> {
  let ref: { id?: string; appId: string | null; botId: string | null };
  if (input.conversationId) {
    const conversation = await getOwnedConversation(p, input.conversationId);
    if (conversation.source === "delegation") throw new HttpError(403, "Delegated conversations are read-only.");
    if (conversation.isGroup) throw new HttpError(400, "Voice sessions are not available in group chats.");
    if ((input.appId && input.appId !== conversation.appId) || (input.botId && input.botId !== conversation.botId))
      throw new HttpError(400, "Voice target does not match this conversation.");
    ref = { id: conversation.id, appId: conversation.appId, botId: conversation.botId };
  } else {
    ref = { appId: input.appId ?? null, botId: input.botId ?? null };
  }
  return resolveTurnTarget(p, ref);
}
