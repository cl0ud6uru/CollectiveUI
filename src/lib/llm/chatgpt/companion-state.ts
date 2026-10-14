import { and, desc, eq, inArray } from 'drizzle-orm';
import { db, type DbOrTx } from '@/db';
import { chatgptCompanionAttempts } from '@/db/schema';
import type { Principal } from '@/lib/auth/groups';
import type { CompanionSignInView } from '@/personal-codex/contracts';

export const openCompanionStates = ['created', 'paired', 'receiving'] as const;
export async function cancelCompanionAttemptsLocked(owner: string, tx: DbOrTx) {
  await tx.update(chatgptCompanionAttempts).set({ state: 'cancelled', updatedAt: new Date() })
    .where(and(eq(chatgptCompanionAttempts.userId, owner), inArray(chatgptCompanionAttempts.state, [...openCompanionStates])));
}
export async function companionSignInView(p: Principal): Promise<CompanionSignInView | null> {
  const [attempt] = await db.select().from(chatgptCompanionAttempts).where(and(eq(chatgptCompanionAttempts.userId, p.user.id),
    eq(chatgptCompanionAttempts.sessionVersion, p.user.sessionVersion))).orderBy(desc(chatgptCompanionAttempts.createdAt)).limit(1);
  if (!attempt) return null;
  const state = openCompanionStates.includes(attempt.state as typeof openCompanionStates[number]) && attempt.expiresAt.getTime() <= Date.now() ? 'expired' : attempt.state;
  const reason = state === 'needs_attention' ? 'Sign-in was not confirmed. Your existing account was kept. Cancel and retry with the local app.'
    : state === 'expired' ? 'This sign-in attempt expired. Start a new sign-in.' : undefined;
  return { state, expiresAt: attempt.expiresAt.toISOString(), ...(reason ? { reason } : {}) };
}
