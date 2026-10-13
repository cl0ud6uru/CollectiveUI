import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, type DbOrTx } from '@/db';
import { personalCodexAccounts, userCredentials } from '@/db/schema';
import { HttpError } from '@/lib/authz';
import { assertNoCodexWork, lockPersonalOwner } from '@/personal-codex/accounts';
import { personalControl, PersonalControlError } from '@/personal-codex/control';
import { tokenFingerprint } from '@/personal-codex/contracts';
import { assertSIWCCredential, openCredentialSecret, removeChatGPTConnection } from './store';

/** Caller holds the owner's user row lock on this connection. Remote revocation runs after commit/lock release. */
export async function invalidateChatGPTConnectionLocked(owner: string, tx: DbOrTx, f?: typeof fetch) {
  // Reservations take the same owner row lock. An unconfirmed stop must never be treated as a disconnect.
  await assertNoCodexWork(owner, tx);
  const [personal] = await tx.select().from(personalCodexAccounts).where(eq(personalCodexAccounts.userId, owner));
  if (process.env.PERSONAL_CODEX_SOCKET) {
    try {
      // Also clear orphaned broker tokens when the portal binding is missing.
      await personalControl(owner, 'disconnect');
    } catch (error) {
      // An unenrolled owner with no retained binding cannot have a managed runtime.
      if (!(error instanceof PersonalControlError && error.code === 'not_enrolled' && !personal)) throw error;
    }
  } else if (personal) {
    throw new HttpError(503, 'Restore the Personal Codex broker before disconnecting this retained account.');
  }
  await tx.update(personalCodexAccounts).set({ connected: false, credentialBinding: randomUUID(), updatedAt: new Date() })
    .where(eq(personalCodexAccounts.userId, owner));
  return removeChatGPTConnection(owner, tx, f);
}

export async function invalidateChatGPTConnection(owner: string, database: DbOrTx = db, f?: typeof fetch) {
  return database.transaction(async tx => {
    await lockPersonalOwner(owner, tx);
    return invalidateChatGPTConnectionLocked(owner, tx, f);
  });
}

/** Broker readiness alone cannot authorize a removed credential, disabled owner, or invalidated portal binding. */
export async function assertCurrentSIWCConnection(owner: string, binding: string, fingerprint: string) {
  await db.transaction(async tx => {
    const person = await lockPersonalOwner(owner, tx);
    const [personal] = await tx.select().from(personalCodexAccounts).where(eq(personalCodexAccounts.userId, owner));
    const [credential] = await tx.select().from(userCredentials).where(and(eq(userCredentials.userId, owner), eq(userCredentials.provider, 'chatgpt')));
    if (person.disabled || !personal?.connected || personal.credentialBinding !== binding || !credential ||
      credential.status !== 'active' || !credential.expiresAt || credential.expiresAt.getTime() <= Date.now())
      throw new HttpError(409, 'Your ChatGPT connection is no longer available. Reconnect before using Codex.');
    const secret = openCredentialSecret(credential);
    assertSIWCCredential(secret);
    if (tokenFingerprint(secret.access) !== fingerprint || personal.workspaceId !== credential.accountId || personal.email !== credential.email)
      throw new HttpError(409, 'Your ChatGPT connection changed. Synchronize the current account before using Codex.');
  });
}
