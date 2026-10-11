import "server-only";
import { db } from "@/db";
import { conversations } from "@/db/schema";
import type { Principal } from "@/lib/auth/groups";
import { getOwnedConversation, HttpError } from "@/lib/authz";
import { loadMessageRows, partsToText, pathTo } from "@/lib/chat/store";
import type { VoiceTarget } from "./session";

export async function prepareVoiceConversation(p: Principal, target: VoiceTarget, chatId: string, existingId?: string) {
  if (existingId && existingId !== chatId) throw new HttpError(400, "Voice target does not match this chat.");
  if (!existingId) {
    await db.insert(conversations).values({ id: chatId, userId: p.user.id, appId: target.bot ? null : target.app.id, botId: target.bot?.id ?? null }).onConflictDoNothing();
  }
  const conv = await getOwnedConversation(p, chatId);
  if (conv.source === "delegation" || conv.isGroup || conv.botId !== (target.bot?.id ?? null) || (!target.bot && conv.appId !== target.app.id))
    throw new HttpError(403, "Voice target does not match this chat.");
  const rows = await loadMessageRows(chatId);
  const context = pathTo(rows, conv.currentLeafId ?? rows.at(-1)?.id ?? null).slice(-20).map(r => `${r.role}: ${partsToText(r.parts)}`).join("\n").slice(-12000);
  return { context };
}
