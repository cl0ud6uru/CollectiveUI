import type { UIMessage } from "ai";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db, type DbOrTx, type Tx } from "@/db";
import { jsonbSafe } from "@/lib/jsonb";
import { conversations, messages, type Message } from "@/db/schema";

export type MessageMeta = {
  assignment?: { botId: string; name: string };
  createdAt?: number;
  model?: string;
  botId?: string;
  /** The app and provider that produced an assistant message (see src/lib/agent/replay.ts). */
  appId?: string;
  providerKind?: string;
  /** Which account's sealed reasoning this reply carries (ChatGPT plans), see ResolvedModel.replayKey. */
  replayKey?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** When the reply started and finished streaming (ms); shown as "Worked for 35s". createdAt is the row's own time. */
  startedAt?: number;
  finishedAt?: number;
};

export type PortalUIMessage = UIMessage<MessageMeta>;

export function rowToUIMessage(row: Message): PortalUIMessage {
  return {
    id: row.id,
    role: row.role,
    parts: row.parts as PortalUIMessage["parts"],
    metadata: { ...(row.metadata as MessageMeta | null), createdAt: row.createdAt.getTime() },
  };
}

export async function loadMessageRows(conversationId: string, q: DbOrTx = db): Promise<Message[]> {
  return q
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt));
}

/** Messages from the root down to `leafId` (inclusive). */
export function pathTo<T extends { id: string; parentId: string | null }>(rows: T[], leafId: string | null): T[] {
  if (!leafId) return [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const path: T[] = [];
  let cur = byId.get(leafId);
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    path.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return path;
}

/** Follow the most recent child from `fromId` down to a leaf. */
export function latestLeaf<T extends { id: string; parentId: string | null; createdAt: Date | number }>(
  rows: T[],
  fromId: string,
): string {
  const children = new Map<string, T[]>();
  for (const r of rows) {
    if (!r.parentId) continue;
    const list = children.get(r.parentId) ?? [];
    list.push(r);
    children.set(r.parentId, list);
  }
  let cur = fromId;
  for (;;) {
    const kids = children.get(cur);
    if (!kids?.length) return cur;
    kids.sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt));
    cur = kids[kids.length - 1].id;
  }
}

/** Plain text used for full-text search and titles. */
export function partsToText(parts: unknown[]): string {
  return parts
    .map((p) => {
      const part = p as { type: string; text?: string; filename?: string };
      if (part.type === "text") return part.text ?? "";
      if (part.type === "file") return part.filename ? `[${part.filename}]` : "";
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .slice(0, 100_000);
}

export async function insertMessage(
  conversationId: string,
  msg: PortalUIMessage,
  parentId: string | null,
  extra: Partial<typeof messages.$inferInsert> = {},
  q: DbOrTx = db,
) {
  const { createdAt: _drop, ...meta } = msg.metadata ?? {};
  void _drop;
  const parts = jsonbSafe(msg.parts);
  await q.insert(messages).values({
    id: msg.id,
    conversationId,
    parentId,
    role: msg.role,
    parts,
    metadata: jsonbSafe(meta),
    searchText: partsToText(parts),
    ...extra,
  });
}

/**
 * Inserts an assistant message, or updates it when it already exists in the same conversation (a run segment saved
 * twice, e.g. by the sweeper after its worker died). A row with that id in another conversation is left alone.
 */
export async function upsertMessage(
  conversationId: string,
  msg: PortalUIMessage,
  parentId: string | null,
  extra: Partial<typeof messages.$inferInsert> = {},
  q: DbOrTx = db,
) {
  const { createdAt: _drop, ...meta } = msg.metadata ?? {};
  void _drop;
  const parts = jsonbSafe(msg.parts);
  const metadata = jsonbSafe(meta);
  const searchText = partsToText(parts);
  await q
    .insert(messages)
    .values({ id: msg.id, conversationId, parentId, role: msg.role, parts, metadata, searchText, ...extra })
    .onConflictDoUpdate({
      target: messages.id,
      set: { parts, metadata, searchText, ...extra },
      setWhere: eq(messages.conversationId, conversationId),
    });
}

export async function updateMessageParts(
  conversationId: string,
  msg: PortalUIMessage,
  extra: Partial<typeof messages.$inferInsert> = {},
  q: DbOrTx = db,
) {
  const { createdAt: _drop, ...meta } = msg.metadata ?? {};
  void _drop;
  const parts = jsonbSafe(msg.parts);
  await q
    .update(messages)
    .set({ parts, metadata: jsonbSafe(meta), searchText: partsToText(parts), ...extra })
    .where(and(eq(messages.id, msg.id), eq(messages.conversationId, conversationId)));
}

/**
 * Changes a stored message's parts under a row lock. `apply` sees the current row and returns new parts, or null to
 * leave it alone. Concurrent callers queue on the lock and see each other's result, which is what makes an approval
 * usable once: a double click or a second tab finds it already answered, so the approved tool can't run twice.
 */
export async function updatePartsLocked(
  conversationId: string,
  messageId: string,
  apply: (row: Message) => unknown[] | null,
): Promise<{ row: Message; parts: unknown[] | null } | null> {
  return db.transaction((tx) => updatePartsLockedTx(tx, conversationId, messageId, apply));
}

/** `updatePartsLocked` inside the caller's transaction (the lock is held until it commits). */
export async function updatePartsLockedTx(
  tx: Tx,
  conversationId: string,
  messageId: string,
  apply: (row: Message) => unknown[] | null,
): Promise<{ row: Message; parts: unknown[] | null } | null> {
  const [row] = await tx
    .select()
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.conversationId, conversationId)))
    .for("update");
  if (!row) return null;
  const applied = apply(row);
  const parts = applied && jsonbSafe(applied);
  if (parts) await tx.update(messages).set({ parts, searchText: partsToText(parts) }).where(eq(messages.id, messageId));
  return { row, parts };
}

/**
 * Moves the branch leaf. With `onlyFrom`, only when the leaf is still one of those ids (or unset): a reply that
 * finishes in the background doesn't yank someone who has since switched to another branch.
 */
export async function setCurrentLeaf(conversationId: string, leafId: string, opts: { onlyFrom?: string[] } = {}, q: DbOrTx = db) {
  const from = opts.onlyFrom?.filter(Boolean) ?? [];
  await q
    .update(conversations)
    .set({ currentLeafId: leafId, updatedAt: sql`now()` })
    .where(
      from.length
        ? and(eq(conversations.id, conversationId), or(isNull(conversations.currentLeafId), inArray(conversations.currentLeafId, from)))
        : eq(conversations.id, conversationId),
    );
}
