// Shared server code uses Node builtins, not the React Server Component marker.
import { randomUUID } from 'node:crypto';
import { and, eq, ne } from 'drizzle-orm';
import { db, type DbOrTx } from '@/db';
import { users, personalCodexAccounts, codexRuns } from '@/db/schema';
import { HttpError } from '@/lib/authz';
import { resolvePrincipal, type Principal } from '@/lib/auth/groups';
import { accountRejection, userMayUseChatGPT } from '@/lib/llm/chatgpt/policy';
import { getSetting } from '@/lib/settings';
import { personalControl } from './control';
import { nativeAccount, type ConnectionView, type BrokerStatus } from './contracts';

export async function personalAccount(owner: string, q: DbOrTx = db) {
  const [row] = await q.select().from(personalCodexAccounts).where(and(eq(personalCodexAccounts.userId, owner), eq(personalCodexAccounts.connected, true)));
  return row;
}
export async function lockPersonalOwner(owner: string, q: DbOrTx) {
  const [row] = await q.select().from(users).where(eq(users.id, owner)).for('update');
  if (!row) throw new HttpError(403, 'Your CollectiveUI account is unavailable.');
  return row;
}
async function allowed(p: Principal, q: DbOrTx = db) {
  if (!userMayUseChatGPT(p, await getSetting('chatgpt', q))) throw new HttpError(403, 'Personal ChatGPT access is not enabled for you.');
}
export async function assertNoCodexWork(owner: string, q: DbOrTx = db) {
  const [run] = await q.select().from(codexRuns).where(and(eq(codexRuns.userId, owner), ne(codexRuns.phase, 'terminal'))).limit(1);
  if (run) throw new HttpError(409, 'Stop and confirm recovery of your active Codex work before changing the connection.');
}
function view(s: BrokerStatus, row: Awaited<ReturnType<typeof personalAccount>> | undefined): ConnectionView {
  if (s.state !== 'running') return { state: s.state, ...(row ? { email: row.email, workspaceId: row.workspaceId, planType: row.planType } : {}) };
  if (s.loginUncertain) return { state: 'uncertain' };
  if (s.login) return { state: 'pending', login: { verificationUrl: s.login.verificationUrl, userCode: s.login.userCode, expiresAt: s.login.expiresAt } };
  if (s.loginOutcome) return { state: s.loginOutcome, reason: s.loginOutcome === 'expired' ? 'Your device code expired. Start sign-in again.' : 'ChatGPT sign-in did not complete. Start sign-in again.' };
  const facts = s.account && nativeAccount.parse(s.account);
  if (!facts?.account || !facts.workspaceRouting) return { state: 'signed_out', ...(row ? { email: row.email, workspaceId: row.workspaceId, planType: row.planType } : {}) };
  const { email, planType } = facts.account, workspaceId = facts.workspaceRouting.chatgptAccountId;
  return { state: row ? row.email.toLowerCase() === email.toLowerCase() && row.workspaceId === workspaceId ? 'connected' : 'changed' : 'confirm', email, workspaceId, planType };
}
export async function connectionView(p: Principal): Promise<ConnectionView> {
  const canConnect = userMayUseChatGPT(p, await getSetting('chatgpt'));
  if (!process.env.PERSONAL_CODEX_SOCKET) return { state: 'unavailable' };
  return { ...view(await personalControl(p.user.id, 'status'), await personalAccount(p.user.id)), ...(!canConnect ? { canConnect: false } : {}) };
}
/** Locks compete with run reservation so account changes cannot race native dispatch/recovery. */
export async function changeConnection(p: Principal, action: 'connect' | 'confirm' | 'cancel' | 'disconnect' | 'start' | 'refresh', expected?: { email: string; workspaceId: string }): Promise<ConnectionView> {
  return db.transaction(async tx => {
    const fresh = await lockPersonalOwner(p.user.id, tx);
    if (fresh.sessionVersion !== p.user.sessionVersion || fresh.disabled) throw new HttpError(403, 'Sign in to CollectiveUI again.');
    if (!['cancel', 'disconnect', 'start'].includes(action)) await allowed(await resolvePrincipal(fresh, tx), tx);
    if (action !== 'start') await assertNoCodexWork(p.user.id, tx);
    const row = await personalAccount(p.user.id, tx);
    if (action === 'connect' && row) throw new HttpError(409, 'Disconnect your existing Codex account before changing accounts. Retained workspaces stay in place.');
    if (action === 'confirm') {
      const s = await personalControl(p.user.id, 'status');
      if (s.state !== 'running' || s.login || s.loginUncertain) throw new HttpError(409, 'Complete your native ChatGPT sign-in first.');
      const facts = nativeAccount.parse(s.account);
      if (!facts.account || !facts.workspaceRouting)
        throw new HttpError(403, 'Complete ChatGPT sign-in with a verified account and workspace before confirming.');
      // The browser confirms only the identity it was shown; all binding facts come from Codex.
      if (!expected || expected.email.toLowerCase() !== facts.account.email.toLowerCase() || expected.workspaceId !== facts.workspaceRouting.chatgptAccountId)
        throw new HttpError(409, 'The signed-in ChatGPT account changed. Review its current identity before confirming.');
      const reason = accountRejection({ accountId: facts.workspaceRouting.chatgptAccountId, planType: facts.account.planType }, await getSetting('chatgpt', tx));
      if (reason) throw new HttpError(403, reason);
      if (row && (row.email.toLowerCase() !== facts.account.email.toLowerCase() || row.workspaceId !== facts.workspaceRouting.chatgptAccountId))
        throw new HttpError(409, 'The native account changed. Disconnect before binding a different account.');
      const same = row?.email.toLowerCase() === facts.account.email.toLowerCase() && row.workspaceId === facts.workspaceRouting.chatgptAccountId;
      const values = { credentialBinding: same ? row!.credentialBinding : randomUUID(), email: facts.account.email.toLowerCase(),
        workspaceId: facts.workspaceRouting.chatgptAccountId, planType: facts.account.planType, connected: true, updatedAt: new Date() };
      try { await tx.insert(personalCodexAccounts).values({ userId: p.user.id, ...values }).onConflictDoUpdate({ target: personalCodexAccounts.userId, set: values }); }
      catch { throw new HttpError(409, 'This ChatGPT account is already connected to another caller. Accounts cannot be pooled.'); }
      return view(s, { userId: p.user.id, ...values });
    }
    const s = await personalControl(p.user.id, action);
    if (action === 'disconnect' || action === 'cancel' && row) await tx.update(personalCodexAccounts).set({ connected: false, credentialBinding: randomUUID(), updatedAt: new Date() }).where(eq(personalCodexAccounts.userId, p.user.id));
    return view(s, action === 'disconnect' || action === 'cancel' ? undefined : row);
  });
}
