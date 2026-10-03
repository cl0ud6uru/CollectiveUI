import { taskView } from "@/lib/delegation/view";
import { orderedTaskRows } from "@/lib/delegation/history";
import type { Principal } from "@/lib/auth/groups";
import { db } from "@/db";
import { getOwnedConversation } from "@/lib/authz";
import { activeRunOf } from "@/lib/runs/state";
import { loadMessageRows, rowToUIMessage } from "./store";
import { resolveTargetOption } from "./targets";

/** One authorized, current view of a saved conversation, including its resumable reply. */
export async function conversationSnapshot(p: Principal, id: string) {
  // The leaf, messages and run must come from one database snapshot: a worker can finish between reads.
  const { conv, rows, activeRun, task } = await db.transaction(async (tx) => {
    const conv = await getOwnedConversation(p, id, tx);
    const rows = await loadMessageRows(conv.id, tx);
    const activeRun = conv.isGroup ? null : await activeRunOf(conv.id, tx);
    const task = conv.source === "delegation" ? await taskView(p, conv.id, tx) : null;
    return { conv, rows: task ? await orderedTaskRows(tx, conv.id, task.turn, rows) : rows, activeRun, task };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
  const { target, skills, unavailableReason } = await resolveTargetOption(p, {
    appId: conv.appId,
    botId: conv.botId,
    allowDefault: false,
    group: conv.isGroup ? { id: conv.id, title: conv.title } : undefined,
  });
  const leaf = activeRun
    ? rows.some((r) => r.id === activeRun.messageId) ? activeRun.messageId : activeRun.parentMessageId
    : (conv.currentLeafId ?? rows.at(-1)?.id ?? null);
  return {
    summary: {
      id: conv.id, title: conv.title, botId: conv.botId, appId: conv.appId,
      isBotHome: conv.isBotHome, isGroup: conv.isGroup, source: conv.source,
      pinned: conv.pinned, folderId: conv.folderId, archived: conv.archived, updatedAt: conv.updatedAt.toISOString(),
    },
    task,
    run: activeRun ? { id: activeRun.id, status: activeRun.status, segment: activeRun.segment } : null,
    conversationId: conv.id,
    isBotHome: conv.isBotHome,
    unavailable: !target,
    unavailableReason,
    target,
    initialRows: rows.map((r) => ({
      id: r.id,
      parentId: r.parentId,
      createdAt: r.createdAt.getTime(),
      feedback: (r.feedback as 1 | -1 | null) ?? null,
      message: rowToUIMessage(r),
    })),
    initialLeafId: leaf,
    skills,
    resume: !!activeRun && !activeRun.legacy && !task?.executionUnavailable,
  };
}

export type ConversationSnapshot = Awaited<ReturnType<typeof conversationSnapshot>>;
