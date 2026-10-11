import "server-only";
import { createHash } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { conversations, messages } from "@/db/schema";
import type { Principal } from "@/lib/auth/groups";
import { getOwnedConversation, HttpError } from "@/lib/authz";
import { insertMessage, setCurrentLeaf } from "@/lib/chat/store";
import { lockUserRuns } from "@/lib/runs/lock";
import { activeRunOf, runOfMessage, RunBusyError } from "@/lib/runs/state";
import { startRun } from "@/lib/runs/store";
import { targetFor } from "./target";
import { orderedFragments, type VoiceFragment } from "./policy";
import { parseHermesInput } from "@/lib/chat/hermes-commands";

export type VoiceBatch = { conversationId: string; batchId: string; sessionId: string; fragments: VoiceFragment[]; delegate: boolean };
const identity = (...parts: string[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);

export async function commitVoiceBatch(p: Principal, input: VoiceBatch) {
  const conv = await getOwnedConversation(p, input.conversationId);
  const target = await targetFor(p, { conversationId: conv.id });
  const replyId = identity(p.user.id, conv.id, input.batchId, "reply");
  const existing = await runOfMessage(replyId);
  if (existing) return { messageId: existing.messageId, status: existing.status };
  const fragments = orderedFragments(input.fragments);
  if (input.delegate && !fragments.some(f => f.role === "user" && f.text.trim())) throw new HttpError(400, "No spoken request is ready yet.");
  const lines: { role: "user" | "assistant"; text: string }[] = [];
  for (const f of fragments) {
    // Full-duplex acknowledgments can interrupt the user's fragments. Keep the complete
    // utterance together: Hermes consumes the newest user message, not every fragment.
    const speaker = lines.find(line => line.role === f.role);
    if (speaker) speaker.text += f.text;
    else lines.push({ role: f.role, text: f.text });
  }
  if (!lines.length) return { messageId: null, status: "saved" };
  if (input.delegate && target.app.provider === "hermes" && lines.some(line => line.role === "user" && parseHermesInput(line.text).kind === "command"))
    throw new HttpError(400, "Use the chat command menu for Hermes slash controls. No bot request was started.");
  const ids = lines.map((_, i) => identity(p.user.id, conv.id, input.batchId, String(i)));
  const fingerprint = identity(JSON.stringify({ ...input, delegate: undefined }));
  await db.transaction(async tx => {
    await lockUserRuns(tx, p.user.id);
    const stored = await tx.select().from(messages).where(inArray(messages.id, ids));
    if (stored.length) {
      if (stored.length !== ids.length || stored.some(m => m.conversationId !== conv.id || (m.metadata as { voiceFingerprint?: string })?.voiceFingerprint !== fingerprint))
        throw new HttpError(409, "Voice batch changed. Reopen the chat before retrying.");
      return; // A lost HTTP response must not duplicate transcript messages.
    }
    if (await activeRunOf(conv.id, tx)) throw new RunBusyError();
    const current = await getOwnedConversation(p, conv.id, tx);
    let parent = current.currentLeafId;
    for (let i = 0; i < lines.length; i++) {
      await insertMessage(conv.id, { id: ids[i], role: lines[i].role, parts: [{ type: "text", text: lines[i].text }],
        metadata: { voiceSessionId: input.sessionId, voiceFingerprint: fingerprint } }, parent, {}, tx);
      parent = ids[i];
    }
    await setCurrentLeaf(conv.id, parent!, {}, tx);
  });
  if (!input.delegate) return { messageId: null, status: "saved" };
  const parentId = ids.at(-1)!;
  const [current] = await db.select().from(conversations).where(eq(conversations.id, conv.id));
  if (current.currentLeafId !== parentId) {
    const run = await runOfMessage(replyId);
    if (run) return { messageId: run.messageId, status: run.status };
    throw new HttpError(409, "The chat changed before this voice request could start. Your speech was saved; send the request again.");
  }
  try {
    const run = await startRun({ principal: p, conversation: current, ...target, parentId, replyId });
    return { messageId: run.messageId, status: run.status };
  } catch (error) {
    const run = await runOfMessage(replyId);
    if (run) return { messageId: run.messageId, status: run.status };
    throw error;
  }
}
