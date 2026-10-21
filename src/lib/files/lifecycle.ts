import { and, eq, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { attachments, conversations, knowledgeChunks, messages } from "@/db/schema";
import { storage, type StorageAdapter } from "./storage";

/** Unsent drafts and interrupted uploads get a full day before the hourly orphan sweep may retire them. */
export const ATTACHMENT_DRAFT_GRACE_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 100;

// All branches count, not just currentLeafId. Knowledge files must survive deleting the chat they came from.
const unreferenced = sql`not exists (select 1 from ${messages}
  where ${messages.parts} @> jsonb_build_array(jsonb_build_object('type', 'file', 'url', '/api/files/' || ${attachments.id})))
  and not exists (select 1 from ${knowledgeChunks} where ${knowledgeChunks.attachmentId} = ${attachments.id})`;

/** Capture only the actor's uploads before message cascades remove the references. No storage I/O here. */
export async function conversationAttachmentIds(tx: Tx, userId: string, conversationId?: string) {
  const rows = await tx.selectDistinct({ id: attachments.id }).from(attachments)
    .innerJoin(messages, sql`${messages.parts} @> jsonb_build_array(jsonb_build_object('type', 'file', 'url', '/api/files/' || ${attachments.id}))`)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(and(eq(attachments.userId, userId), eq(conversations.userId, userId),
      conversationId ? eq(conversations.id, conversationId) : undefined));
  return rows.map(row => row.id);
}

/**
 * Reference writers take FOR SHARE in the database trigger; retirement takes FOR UPDATE and rechecks references
 * in a second statement (a fresh READ COMMITTED snapshot). The tombstone commits before slow storage I/O.
 * Physical deletion failures keep the key for a retry; a successfully deleted/missing blob permits metadata removal.
 */
export async function retireAttachments(options: { userId?: string; ids?: string[]; orphanBefore?: Date } = {}, adapter: StorageAdapter = storage()) {
  if (options.ids && !options.ids.length) return { deleted: 0, failed: 0 };
  if (options.ids && options.ids.length > BATCH_SIZE) {
    const total = { deleted: 0, failed: 0 };
    for (let offset = 0; offset < options.ids.length; offset += BATCH_SIZE) {
      const result = await retireAttachments({ ...options, ids: options.ids.slice(offset, offset + BATCH_SIZE) }, adapter);
      total.deleted += result.deleted; total.failed += result.failed;
    }
    return total;
  }
  const candidates = await db.transaction(async tx => {
    const rows = await tx.select({ id: attachments.id, storageKey: attachments.storageKey }).from(attachments)
      .where(and(options.userId ? eq(attachments.userId, options.userId) : undefined,
        options.ids ? inArray(attachments.id, options.ids) : undefined,
        options.orphanBefore ? or(isNotNull(attachments.deletedAt), lt(attachments.createdAt, options.orphanBefore)) : undefined,
        unreferenced))
      // Rotate failed tombstones behind older, unattempted orphans so one bad blob cannot starve the sweep.
      .orderBy(sql`coalesce(${attachments.deletedAt}, ${attachments.createdAt})`, attachments.id).limit(BATCH_SIZE).for("update", { skipLocked: true });
    if (!rows.length) return [];
    // A message insertion can commit while the first statement is waiting for a row lock. Never use its old snapshot.
    const retired = await tx.update(attachments).set({ deletedAt: new Date(), extractedText: null })
      .where(and(inArray(attachments.id, rows.map(row => row.id)), unreferenced))
      .returning({ id: attachments.id, storageKey: attachments.storageKey });
    return retired;
  });
  let deleted = 0, failed = 0;
  for (const attachment of candidates) {
    try {
      await adapter.delete(attachment.storageKey);
      await db.delete(attachments).where(and(eq(attachments.id, attachment.id), isNotNull(attachments.deletedAt)));
      deleted++;
    } catch (error) {
      failed++;
      console.error("[attachments] deletion deferred", attachment.id, error);
    }
  }
  return { deleted, failed };
}

/** Bounded per run, resumable across worker restarts and safe across replicas. Never scans/deletes arbitrary disk files. */
export async function sweepAttachments(now = new Date(), adapter: StorageAdapter = storage()) {
  return retireAttachments({ orphanBefore: new Date(now.getTime() - ATTACHMENT_DRAFT_GRACE_MS) }, adapter);
}

