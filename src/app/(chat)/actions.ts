"use server";

import { isDockerHermes } from "@/lib/docker-hermes/policy";
import { resolveTurnTarget } from "@/lib/agent/target";
import { isPersonalHermesConversation } from "@/lib/docker-hermes/store";

import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import {
  conversationBots,
  conversations,
  folders,
  inboxItems,
  memories,
  messages,
  sharedLinks,
  toolGrants,
  users,
  type UserPrefs,
} from "@/db/schema";
import { cancelTasksForConversationTx } from "@/lib/delegation/cancel";
import { stripTaskLinks } from "@/lib/delegation/receipts";
import { TASK_READ_ONLY } from "@/lib/delegation/policy";
import { lockUserRuns } from "@/lib/runs/lock";
import { stopRuns } from "@/lib/runs/store";
import { withoutOpenAIMetadata } from "@/lib/agent/replay";
import { isGrantable } from "@/lib/agent/tool-names";
import { getAccessibleBot, getAccessibleModel, getOwnedConversation, listAccessibleBots, HttpError } from "@/lib/authz";
import { CLIENT_ID_RE } from "@/lib/ids";
import { openSideChat } from "@/lib/chat/side";
import { assertDefaultBot } from "@/lib/chat/targets";
import { latestLeaf, loadMessageRows, pathTo, type PortalUIMessage } from "@/lib/chat/store";
import { newId, newToken } from "@/lib/ids";
import { stopRunsBeforeDelete } from "@/lib/runs/provider-stop";
import { closeOpenParts } from "@/lib/runs/replay";
import { requirePrincipal } from "@/lib/session";

const idSchema = z.string().min(1).max(64);

/** A saved URL before composing makes side chats safe to revisit through browser history. */
export async function createSideChat(botId: string, conversationId: string) {
  const p = await requirePrincipal();
  const id = z.string().regex(CLIENT_ID_RE).parse(conversationId);
  const conv = await openSideChat(p, idSchema.parse(botId), id);
  revalidatePath("/", "layout");
  return { id: conv.id };
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export async function renameConversation(id: string, title: string) {
  const p = await requirePrincipal();
  await getOwnedConversation(p, idSchema.parse(id));
  await db
    .update(conversations)
    .set({ title: z.string().trim().min(1).max(120).parse(title) })
    .where(eq(conversations.id, id));
  revalidatePath("/", "layout");
}

export async function setConversationPinned(id: string, pinned: boolean) {
  const p = await requirePrincipal();
  await getOwnedConversation(p, idSchema.parse(id));
  await db.update(conversations).set({ pinned }).where(eq(conversations.id, id));
  revalidatePath("/", "layout");
}

export async function archiveConversation(id: string, archived = true) {
  const p = await requirePrincipal();
  await getOwnedConversation(p, idSchema.parse(id));
  // Retire the home explicitly; unarchiving never steals the identity from a newer home.
  await db.update(conversations).set({ archived, ...(archived ? { isBotHome: false } : {}) }).where(eq(conversations.id, id));
  revalidatePath("/", "layout");
}

export async function deleteConversation(id: string) {
  const p = await requirePrincipal();
  await getOwnedConversation(p, idSchema.parse(id));
  await stopRuns(p, id);
  await stopRunsBeforeDelete({ conversationId: id });
  await db.transaction(async tx => {
    await lockUserRuns(tx, p.user.id);
    await cancelTasksForConversationTx(tx, p.user.id, id);
    await tx.delete(conversations).where(and(eq(conversations.id, id), eq(conversations.userId, p.user.id)));
  });
  revalidatePath("/", "layout");
}

export async function deleteAllConversations() {
  const p = await requirePrincipal();
  await stopRunsBeforeDelete({ userId: p.user.id });
  await db.transaction(async tx => {
    await lockUserRuns(tx, p.user.id);
    await cancelTasksForConversationTx(tx, p.user.id);
    await tx.delete(conversations).where(eq(conversations.userId, p.user.id));
  });
  revalidatePath("/", "layout");
}

export async function moveConversationToFolder(id: string, folderId: string | null) {
  const p = await requirePrincipal();
  await getOwnedConversation(p, idSchema.parse(id));
  if (folderId) {
    const [f] = await db
      .select()
      .from(folders)
      .where(and(eq(folders.id, folderId), eq(folders.userId, p.user.id)));
    if (!f) throw new Error("Folder not found");
  }
  await db.update(conversations).set({ folderId }).where(eq(conversations.id, id));
  revalidatePath("/", "layout");
}

/** Switch the visible branch (edit / regenerate history). */
export async function setConversationLeaf(id: string, leafId: string) {
  const p = await requirePrincipal();
  const conv = await getOwnedConversation(p, idSchema.parse(id));
  if (conv.source === "delegation") throw new HttpError(409, TASK_READ_ONLY);
  const rows = await loadMessageRows(id);
  if (!rows.some((r) => r.id === leafId)) throw new Error("Unknown message");
  await db
    .update(conversations)
    .set({ currentLeafId: latestLeaf(rows, leafId) })
    .where(eq(conversations.id, id));
}

export async function setMessageFeedback(conversationId: string, messageId: string, feedback: 1 | -1 | null) {
  const p = await requirePrincipal();
  await getOwnedConversation(p, idSchema.parse(conversationId));
  await db
    .update(messages)
    .set({ feedback })
    .where(and(eq(messages.id, messageId), eq(messages.conversationId, conversationId)));
}

// ---------------------------------------------------------------------------
// Folders ("Projects")
// ---------------------------------------------------------------------------

export async function createFolder(name: string) {
  const p = await requirePrincipal();
  const [f] = await db
    .insert(folders)
    .values({ userId: p.user.id, name: z.string().trim().min(1).max(80).parse(name) })
    .returning();
  revalidatePath("/", "layout");
  return { id: f.id, name: f.name };
}

export async function renameFolder(id: string, name: string) {
  const p = await requirePrincipal();
  await db
    .update(folders)
    .set({ name: z.string().trim().min(1).max(80).parse(name) })
    .where(and(eq(folders.id, id), eq(folders.userId, p.user.id)));
  revalidatePath("/", "layout");
}

export async function deleteFolder(id: string) {
  const p = await requirePrincipal();
  await db.delete(folders).where(and(eq(folders.id, id), eq(folders.userId, p.user.id)));
  revalidatePath("/", "layout");
}

// ---------------------------------------------------------------------------
// Sharing (org-internal snapshot links)
// ---------------------------------------------------------------------------

export async function createShareLink(conversationId: string) {
  const p = await requirePrincipal();
  const conv = await getOwnedConversation(p, idSchema.parse(conversationId));
  if (conv.source === "delegation") throw new HttpError(409, TASK_READ_ONLY);
  if (await isPersonalHermesConversation(conv)) throw new HttpError(403, "Personal Hermes chats remain private and cannot be shared.");
  if (!conv.currentLeafId) throw new Error("Nothing to share yet");
  const token = newToken();
  await db.insert(sharedLinks).values({
    id: token,
    conversationId: conv.id,
    cutoffMessageId: conv.currentLeafId,
    createdBy: p.user.id,
  });
  return { token };
}

export async function revokeShareLinks(conversationId: string) {
  const p = await requirePrincipal();
  await getOwnedConversation(p, idSchema.parse(conversationId));
  await db
    .update(sharedLinks)
    .set({ revokedAt: new Date() })
    .where(and(eq(sharedLinks.conversationId, conversationId), isNull(sharedLinks.revokedAt)));
}

/** "Continue this conversation": copy a shared snapshot into the viewer's own history. */
export async function continueSharedConversation(token: string): Promise<string> {
  const p = await requirePrincipal();
  const [link] = await db
    .select()
    .from(sharedLinks)
    .where(and(eq(sharedLinks.id, idSchema.parse(token)), isNull(sharedLinks.revokedAt)));
  if (!link) throw new Error("Link not found");
  const [src] = await db.select().from(conversations).where(eq(conversations.id, link.conversationId));
  if (!src || src.source === "delegation" || await isPersonalHermesConversation(src)) throw new Error("Link not found");
  const path = pathTo(await loadMessageRows(src.id), link.cutoffMessageId);

  if (!src.botId && src.appId) await getAccessibleModel(p, src.appId);
  if (src.botId) await getAccessibleBot(p, src.botId).catch(() => null);
  const newConvId = newId();
  const idMap = new Map<string, string>();
  await db.transaction(async (tx) => {
    await tx.insert(conversations).values({
      id: newConvId,
      userId: p.user.id,
      appId: src.appId,
      botId: src.botId,
      isGroup: src.isGroup,
      title: src.title,
    });
    if (src.isGroup) {
      const members = await tx.select().from(conversationBots).where(eq(conversationBots.conversationId, src.id));
      if (members.length)
        await tx.insert(conversationBots).values(members.map((m) => ({ conversationId: newConvId, botId: m.botId, position: m.position })));
    }
    let parent: string | null = null;
    for (const m of path) {
      const nid = newId();
      idMap.set(m.id, nid);
      await tx.insert(messages).values({
        id: nid,
        conversationId: newConvId,
        parentId: parent,
        role: m.role,
        // Attachments stay private to their owner, so drop file parts from the copy. OpenAI item ids and sealed
        // reasoning belong to the sharer's account, so they are dropped too (see src/lib/agent/replay.ts). Approvals
        // still pending belong to the sharer's turn (a Hermes one names the sharer's live run): closed in the copy.
        parts: stripTaskLinks(closedForCopy(m.role, (m.parts as { type: string }[]).filter((x) => x.type !== "file").map((x) => withoutOpenAIMetadata(x)))),
        metadata: withoutReplayKey(m.metadata),
        model: m.model,
        searchText: m.searchText,
      });
      parent = nid;
    }
    await tx.update(conversations).set({ currentLeafId: parent }).where(eq(conversations.id, newConvId));
  });
  revalidatePath("/", "layout");
  return newConvId;
}

/** A copied assistant message's unanswered (or answered but unrun) approvals, closed: nothing in a copy can be continued. */
function closedForCopy(role: string, parts: { type: string }[]): unknown[] {
  if (role !== "assistant") return parts;
  const msg = { id: "copy", role: "assistant", parts } as unknown as PortalUIMessage;
  return closeOpenParts(msg, "cancelled", { deniedReason: "Not answered in the shared chat.", stoppedText: "Not run in the shared chat." }).message.parts;
}

function withoutReplayKey(meta: Record<string, unknown> | null) {
  if (!meta || !("replayKey" in meta)) return meta;
  const { replayKey: _drop, ...rest } = meta;
  void _drop;
  return rest;
}

// ---------------------------------------------------------------------------
// Preferences & memory
// ---------------------------------------------------------------------------

/** For start defaults, `null` clears and a missing key leaves them unchanged. New chats start with at most one: setting a model clears the bot and vice versa. */
export async function updatePrefs(prefs: Omit<UserPrefs, "defaultAppId" | "defaultBotId"> & { defaultAppId?: string | null; defaultBotId?: string | null }) {
  const p = await requirePrincipal();
  const clean = z
    .object({
      customInstructions: z.string().max(4000).optional(),
      memoryEnabled: z.boolean().optional(),
      defaultAppId: z.string().max(100).nullable().optional(),
      defaultBotId: z.string().max(100).nullable().optional(),
    })
    .refine((v) => !(v.defaultAppId && v.defaultBotId), "Choose either a model or a bot to start new chats with.")
    .parse(prefs);
  if (clean.defaultAppId) await getAccessibleModel(p, clean.defaultAppId);
  if (clean.defaultBotId) await assertDefaultBot(p, clean.defaultBotId);
  const { defaultAppId, defaultBotId, ...rest } = clean;
  await db.transaction(async tx => {
    const [current] = await tx.select().from(users).where(eq(users.id, p.user.id)).for("update");
    if (!current || current.disabled || current.sessionVersion !== p.user.sessionVersion) throw new HttpError(403, "Your account or session changed. Sign in again.");
    const next: UserPrefs = { ...current.prefs, ...rest };
    if (defaultAppId !== undefined || defaultBotId !== undefined) {
      delete next.defaultAppId;
      delete next.defaultBotId;
      if (defaultAppId) next.defaultAppId = defaultAppId;
      if (defaultBotId) next.defaultBotId = defaultBotId;
    }
    await tx.update(users).set({ prefs: next }).where(eq(users.id, p.user.id));
  });
  revalidatePath("/settings");
}

export async function saveMemory(input: { id?: string; content: string; botId?: string | null; pinned?: boolean }) {
  const p = await requirePrincipal();
  const content = z.string().trim().min(1).max(1000).parse(input.content);
  if (input.botId) {
    await getAccessibleBot(p, input.botId);
    if (isDockerHermes((await resolveTurnTarget(p, { botId: input.botId, appId: null })).app))
      throw new HttpError(400, "Native Hermes memory is read-only here; manage it in Hermes.");
  }
  if (input.id) {
    await db
      .update(memories)
      .set({ content, pinned: input.pinned ?? false, embedding: null, updatedAt: new Date() })
      .where(and(eq(memories.id, input.id), eq(memories.userId, p.user.id)));
  } else {
    const { addMemory } = await import("@/lib/agent/memory");
    await addMemory(p.user.id, input.botId ?? null, content);
  }
  revalidatePath("/settings");
}

export async function setMemoryPinned(id: string, pinned: boolean) {
  const p = await requirePrincipal();
  await db
    .update(memories)
    .set({ pinned })
    .where(and(eq(memories.id, id), eq(memories.userId, p.user.id)));
  revalidatePath("/settings");
}

export async function deleteMemory(id: string) {
  const p = await requirePrincipal();
  await db.delete(memories).where(and(eq(memories.id, id), eq(memories.userId, p.user.id)));
  revalidatePath("/settings");
}

export async function clearMemories() {
  const p = await requirePrincipal();
  await db.delete(memories).where(eq(memories.userId, p.user.id));
  revalidatePath("/settings");
}

// ---------------------------------------------------------------------------
// Tool approvals
// ---------------------------------------------------------------------------

/** "Always allow" a tool for a bot (cannot override admin-enforced approvals). */
export async function grantToolForBot(botId: string, toolName: string) {
  const p = await requirePrincipal();
  // The name comes from the browser: tools that always ask (workspace commands) can't be granted.
  if (!isGrantable(toolName)) throw new HttpError(400, "This action always asks for approval.");
  const bot = await getAccessibleBot(p, botId);
  if (bot.executionMode === "service") throw new HttpError(403, "Service-bot approvals are controlled by an admin.");
  await db
    .insert(toolGrants)
    .values({ userId: p.user.id, botId, toolName: z.string().max(64).parse(toolName) })
    .onConflictDoNothing();
}

export async function revokeToolGrant(botId: string, toolName: string) {
  const p = await requirePrincipal();
  await db
    .delete(toolGrants)
    .where(and(eq(toolGrants.userId, p.user.id), eq(toolGrants.botId, botId), eq(toolGrants.toolName, toolName)));
  revalidatePath("/settings");
}

export async function markInboxRead(id?: string) {
  const p = await requirePrincipal();
  await db
    .update(inboxItems)
    .set({ readAt: new Date() })
    .where(
      id
        ? and(eq(inboxItems.id, id), eq(inboxItems.userId, p.user.id))
        : and(eq(inboxItems.userId, p.user.id), isNull(inboxItems.readAt)),
    );
  revalidatePath("/", "layout");
}

/** Owner-scoped current work, including receiving bots whose home chat is not open. */
export async function refreshBotStatuses() {
  const p = await requirePrincipal();
  const { loadBotRoster } = await import("@/lib/chat/roster");
  const [bots, roster] = await Promise.all([listAccessibleBots(p), loadBotRoster(p.user.id, [])]);
  return Object.fromEntries(bots.map(bot => [bot.id, roster.get(bot.id)?.status ?? null]));
}
