import 'server-only';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, gt, ne } from 'drizzle-orm';
import { db } from '@/db';
import { agentRuns, codexApprovals, codexRuns, conversations } from '@/db/schema';
import { HttpError, getUsableBot } from '@/lib/authz';
import { loadPrincipal } from '@/lib/auth/groups';
import { codexPolicy } from '@/lib/codex/store';
import { codexRuntimeApp } from '@/lib/codex/target';
import { getSetting } from '@/lib/settings';
import { userMayUseChatGPT } from '@/lib/llm/chatgpt/policy';
import { managedRuntimeForAccount, runtimeBinding, type CodexRuntime } from '@/lib/codex/runtime';
import { lockPersonalOwner, personalAccount } from './accounts';

export async function waitForApproval(runId: string, runtime: CodexRuntime, threadId: string, turnId: string,
  signal: AbortSignal, show: (id: string) => void) {
  const id = randomUUID(), expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await db.insert(codexApprovals).values({ id, runId, userId: runtime.ownerId, binding: runtimeBinding(runtime), threadId, turnId, expiresAt });
  show(id);
  try {
    while (!signal.aborted && Date.now() < expiresAt.getTime()) {
      const [row] = await db.select().from(codexApprovals).where(eq(codexApprovals.id, id));
      if (row?.decision) return row.decision;
      await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
        const timer = setTimeout(finish, 500); signal.addEventListener('abort', finish, { once: true });
      });
    }
    return 'cancel' as const;
  } finally {
    await db.update(codexApprovals).set({ decision: 'cancel' }).where(and(eq(codexApprovals.id, id), isNull(codexApprovals.decision)));
  }
}
/** Only the still-authorized caller may decline/cancel this exact pending native callback. */
export async function decideApproval(owner: string, sessionVersion: number, id: string, decision: 'decline' | 'cancel') {
  await db.transaction(async tx => {
    const user = await lockPersonalOwner(owner, tx);
    if (user.disabled || user.sessionVersion !== sessionVersion) throw new HttpError(403, 'Sign in again.');
    const [row] = await tx.select().from(codexApprovals).where(and(eq(codexApprovals.id, id), eq(codexApprovals.userId, owner), isNull(codexApprovals.decision), gt(codexApprovals.expiresAt, new Date())));
    const [run] = row ? await tx.select().from(agentRuns).where(and(eq(agentRuns.id, row.runId), eq(agentRuns.userId, owner), eq(agentRuns.status, 'running'), isNull(agentRuns.cancelRequestedAt))) : [];
    const [attempt] = row ? await tx.select().from(codexRuns).where(and(eq(codexRuns.runId, row.runId), ne(codexRuns.phase, 'terminal'))) : [];
    if (!row || !run || !attempt || attempt.threadId !== row.threadId || attempt.turnId !== row.turnId || attempt.binding !== row.binding) throw new HttpError(409, 'This Codex approval is no longer pending.');
    const p = await loadPrincipal(owner, tx);
    if (!p) throw new HttpError(403, 'Your account is unavailable.');
    const [conversation] = run.conversationId ? await tx.select().from(conversations).where(and(eq(conversations.id, run.conversationId), eq(conversations.userId, owner))) : [];
    const bot = conversation?.botId ? await getUsableBot(p, conversation.botId, tx) : null;
    const policy = bot ? await codexPolicy(bot.id, tx) : null;
    const account = await personalAccount(owner, tx);
    if (!conversation || !bot || !policy || policy.funding !== 'chatgpt_subscription' || !account ||
      !userMayUseChatGPT(p, await getSetting('chatgpt', tx)) || codexRuntimeApp(bot, policy).id !== run.appId ||
      runtimeBinding(await managedRuntimeForAccount(owner, account)) !== row.binding)
      throw new HttpError(409, 'Your Codex target or account changed. Stop the request.');
    await tx.update(codexApprovals).set({ decision }).where(and(eq(codexApprovals.id, id), isNull(codexApprovals.decision)));
  });
}
