import { and, asc, eq, lte } from "drizzle-orm";
import type { DbOrTx, Tx } from "@/db";
import { agentRuns, delegatedTasks, messages, type Message } from "@/db/schema";
import { HttpError } from "@/lib/authz";
import { insertMessage, setCurrentLeaf } from "@/lib/chat/store";
import { isFinal, type AgentRun } from "@/lib/runs/types";
import type { DelegatedTask } from "./store";

async function turns(q: DbOrTx, conversationId: string, through: number) {
  return q.select({ task: delegatedTasks, run: agentRuns }).from(delegatedTasks)
    .leftJoin(agentRuns, eq(agentRuns.id, delegatedTasks.childRunId))
    .where(and(eq(delegatedTasks.childConversationId, conversationId), lte(delegatedTasks.turn, through)))
    .orderBy(asc(delegatedTasks.turn));
}

/** Queue admission time is not transcript order. A cancelled, unstarted turn may have no reply. */
export async function orderedTaskRows(q: DbOrTx, conversationId: string, through: number, rows: Message[]) {
  const byId = new Map(rows.map(row => [row.id, row]));
  return (await turns(q, conversationId, through)).flatMap(({ run }) =>
    run ? [run.parentMessageId, run.messageId].flatMap(id => id && byId.has(id) ? [byId.get(id)!] : []) : []);
}

/** First claim only, under admission lock. Finished predecessors cannot later rewrite this history. */
export async function bindTaskHistory(tx: Tx, task: DelegatedTask, current: AgentRun) {
  const rows = await tx.select().from(messages).where(eq(messages.conversationId, current.conversationId));
  const byId = new Map(rows.map(row => [row.id, row]));
  let leaf: string | null = null;
  for (const { run } of await turns(tx, current.conversationId, task.turn)) {
    if (!run) throw new HttpError(409, "A prior task turn was removed.");
    const prompt = run.parentMessageId ? byId.get(run.parentMessageId) : undefined;
    if (!prompt || prompt.role !== "user") throw new HttpError(409, "A prior task assignment was removed.");
    // This also connects a cancelled-before-claim prompt. Record its terminal boundary so
    // the model cannot mistake stopped work for an outstanding unanswered instruction.
    if (prompt.parentId !== leaf) await tx.update(messages).set({ parentId: leaf }).where(eq(messages.id, prompt.id));
    if (run.id !== current.id && !byId.has(run.messageId)) {
      if (!isFinal(run.status) || run.status === "succeeded") throw new HttpError(409, "A prior task result is unavailable.");
      const text = `Task turn ${run.status}${run.startedAt ? "; earlier actions may have run" : " before execution"}. This is a saved task status, not a specialist answer. Do not carry out this earlier instruction unless the user explicitly requests a new attempt.`;
      await insertMessage(current.conversationId, { id: run.messageId, role: "assistant", parts: [{ type: "text", text }] }, prompt.id, {}, tx);
      leaf = run.messageId;
    } else leaf = byId.has(run.messageId) ? run.messageId : prompt.id;
  }
  await setCurrentLeaf(current.conversationId, current.parentMessageId!, {}, tx);
}
