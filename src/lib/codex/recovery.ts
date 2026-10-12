// Shared by the Next server and plain Node worker; this builtin rejects browser bundles.
import 'node:net';
import { and, eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db';
import { codexRuns } from '@/db/schema';
import { CodexClient } from './client';
import { callerRuntime, runtimeBinding } from './runtime';
import { pendingCodexStops } from './store';

const threadRead = z.object({ thread: z.object({ turns: z.array(z.object({ id: z.string(), status: z.string() })) }) });
/** A new transport may only read/interrupt the exact recorded thread. It never starts or resumes inference. */
export async function stopCodexRun(runId: string): Promise<boolean> {
  let [row] = await db.select().from(codexRuns).where(eq(codexRuns.runId, runId));
  if (!row) return false;
  if (row.phase === 'terminal') return true;
  if (row.phase === 'reserved' || row.phase === 'ready') {
    // Competes atomically with the fenced dispatch checkpoint. If dispatch wins, it is uncertain
    // and must take the remote recovery path; an old pre-dispatch read cannot mark it terminal.
    const stopped = await db.update(codexRuns).set({ phase: 'terminal', updatedAt: new Date() })
      .where(and(eq(codexRuns.runId, runId), eq(codexRuns.phase, row.phase))).returning();
    if (stopped.length) return true;
    [row] = await db.select().from(codexRuns).where(eq(codexRuns.runId, runId));
    if (!row || row.phase === 'terminal') return true;
  }
  let client: CodexClient | undefined;
  let confirmed = false;
  try {
    if (!confirmed && row.threadId) {
      const runtime = await callerRuntime(row.userId, row.funding);
      if (runtime.id !== row.runtimeId || runtimeBinding(runtime) !== row.binding) throw new Error('Runtime binding changed');
      client = await CodexClient.connect(runtime);
      // A startup interrupt acknowledges submission, not termination. Always verify persisted turn state after it.
      await client.request('turn/interrupt', { threadId: row.threadId, turnId: row.turnId ?? '' }, 8000).catch(() => {});
      const state = threadRead.parse(await client.request('thread/read', { threadId: row.threadId, includeTurns: true }));
      const turn = row.turnId ? state.thread.turns.find(t => t.id === row.turnId) : state.thread.turns.at(-1);
      confirmed = !!turn && turn.id !== row.baselineTurnId && ['completed', 'failed', 'interrupted'].includes(turn.status);
    }
  } catch { confirmed = false; }
  finally { client?.close(); }
  await db.update(codexRuns).set({ phase: confirmed ? 'terminal' : 'stop_unconfirmed', updatedAt: new Date() })
    .where(and(eq(codexRuns.runId, runId), ne(codexRuns.phase, 'terminal')));
  return true;
}
export async function reconcileCodexStops() {
  for (const { execution } of await pendingCodexStops()) await stopCodexRun(execution.runId);
}
