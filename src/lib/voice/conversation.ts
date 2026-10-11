import "server-only";
import { db } from "@/db";
import { conversations } from "@/db/schema";
import type { Principal } from "@/lib/auth/groups";
import { getOwnedConversation, HttpError } from "@/lib/authz";
import { loadMessageRows, partsToText, pathTo } from "@/lib/chat/store";
import type { VoiceTarget } from "./session";
import { voiceHistory } from "./history";

export async function prepareVoiceConversation(p: Principal, target: VoiceTarget, chatId: string, existingId?: string) {
  if (existingId && existingId !== chatId) throw new HttpError(400, "Voice target does not match this chat.");
  if (!existingId) {
    await db.insert(conversations).values({ id: chatId, userId: p.user.id, appId: target.bot ? null : target.app.id, botId: target.bot?.id ?? null }).onConflictDoNothing();
  }
  const conv = await getOwnedConversation(p, chatId);
  if (conv.source === "delegation" || conv.isGroup || conv.botId !== (target.bot?.id ?? null) || (!target.bot && conv.appId !== target.app.id))
    throw new HttpError(403, "Voice target does not match this chat.");
  const rows = await loadMessageRows(chatId);
  const history = voiceHistory(pathTo(rows, conv.currentLeafId ?? rows.at(-1)?.id ?? null)
    .map(r => ({ id: r.id, role: r.role, text: partsToText(r.parts) })));
  // Retained for older native clients; current clients use startup input and message IDs.
  return { history, context: history.map(r => `${r.role}: ${r.text}`).join("\n") };
}
