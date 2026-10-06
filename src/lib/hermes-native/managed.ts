import { and, desc, eq } from 'drizzle-orm';
import { db, type DbOrTx } from '@/db';
import { agentRuns, hermesRunContexts } from '@/db/schema';
import type { Principal } from '@/lib/auth/groups';
import { getOwnedConversation, HttpError } from '@/lib/authz';
import { resolveTurnTarget } from '@/lib/agent/target';
import { isLocalHermes } from '@/lib/local-hermes/config';
import { isDockerHermes, assertDockerCreate } from '@/lib/docker-hermes/policy';
import { withDockerAccess } from '@/lib/docker-hermes/store';
import { getSetting } from '@/lib/settings';
import { dockerControl } from '@/lib/docker-hermes/client';
import { hermesTargetFor } from '@/lib/llm/resolve';
import { hermesTargetKey } from '@/lib/llm/providers/hermes/scope';
import { managedRunView, controlManagedRun } from '@/lib/llm/providers/hermes/client';
import { managedControl } from '@/local-hermes/interactions';

async function binding(p: Principal, conversationId: string, q: DbOrTx = db) {
  const conversation = await getOwnedConversation(p, conversationId, q);
  const { app, bot } = await resolveTurnTarget(p, conversation);
  if (!isLocalHermes(app)) return null;
  if (!bot || conversation.isGroup || bot.ownerId !== p.user.id) throw new HttpError(403, 'Native controls require your private bot conversation.');
  const [owned] = await q.select({ run: agentRuns, context: hermesRunContexts }).from(agentRuns)
    .innerJoin(hermesRunContexts, eq(hermesRunContexts.runId, agentRuns.id))
    .where(and(eq(agentRuns.conversationId, conversationId), eq(agentRuns.userId, p.user.id), eq(agentRuns.botId, bot.id), eq(agentRuns.appId, app.id)))
    .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id)).limit(1);
  if (!owned?.context.upstreamRunId) return { app, bot, run: null, context: null };
  if (owned.context.targetKey !== hermesTargetKey(app)) throw new HttpError(409, 'The recorded Hermes connection changed. Restore it before controlling this turn.');
  return { app, bot, ...owned };
}
export async function viewManagedNative(p: Principal, conversationId: string) {
  const b = await binding(p, conversationId);
  if (!b) return { available: false as const };
  if (!b.run || !b.context?.upstreamRunId) return { available: true as const, view: null };
  const { target } = await hermesTargetFor(b.app, { userId: p.user.id, botId: b.bot.id, verify: true });
  return { available: true as const, view: await managedRunView(target, b.context.upstreamRunId) };
}
export async function mutateManagedNative(p: Principal, conversationId: string, raw: unknown) {
  const input = managedControl.parse(raw), b = await binding(p, conversationId);
  if (!b) throw new HttpError(400, 'This conversation does not use a private native controller.');
  const dispatch = async (fresh: Principal, q: DbOrTx = db) => {
    const current = await binding(fresh, conversationId, q);
    if (!current?.run || !current.context?.upstreamRunId || !['running', 'waiting'].includes(current.run.status) || current.run.cancelRequestedAt)
      throw new HttpError(409, 'This native turn has already ended or cancellation was requested.');
    const { target } = await hermesTargetFor(current.app, { userId: fresh.user.id, botId: current.bot.id, verify: true });
    return controlManagedRun(target, current.context.upstreamRunId, input);
  };
  if (isDockerHermes(b.app)) return withDockerAccess(p, false, async (fresh, tx) => {
    let canCreate = true;
    try { await assertDockerCreate(fresh, await getSetting('tools', tx), tx); }
    catch (e) { if (!(e instanceof HttpError) || e.status !== 403) throw e; canCreate = false; }
    if (input.operation !== 'answer' && !canCreate) throw new HttpError(403, 'New native work is disabled. Pending prompts can still be answered.');
    await dockerControl(fresh.user.id, '/control/lease', { canCreate }, 3000);
    return dispatch(fresh, tx);
  });
  return dispatch(p);
}
