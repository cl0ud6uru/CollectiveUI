import type { Message } from "@/db/schema";
import { HttpError } from "@/lib/http-error";
import { loadMessageRows, pathTo, rowToUIMessage } from "./store";
import { replyContext, type ReplyReference } from "./reply";

/** The route has already authorized the conversation; constrain the reference to its selected branch. */
export function resolveReplyReference(rows: Message[], conversationId: string, parentId: string | null, reference: ReplyReference, assistantName: string, allowedSpeakerIds?: Set<string>) {
  const row = pathTo(rows.filter(row => row.conversationId === conversationId), parentId).find(row => row.id === reference.messageId);
  if (!row) throw new HttpError(400, "Reply target is not in this conversation branch. Choose a message again.");
  const reply = replyContext(rowToUIMessage(row), reference.speakerIndex, assistantName);
  if (!reply || (reply.botId && allowedSpeakerIds && !allowedSpeakerIds.has(reply.botId)))
    throw new HttpError(400, "This reply target is unavailable. Choose a message again.");
  return reply;
}

/** Parent resolution may have waited for a stopped reply to persist; validate against fresh stored rows. */
export async function resolveStoredReplyReference(conversationId: string, parentId: string | null, reference: ReplyReference, assistantName: string) {
  return resolveReplyReference(await loadMessageRows(conversationId), conversationId, parentId, reference, assistantName);
}
