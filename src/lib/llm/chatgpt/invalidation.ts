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

/** Stable server-verified facts captured while the exact dispatch token is still current. Contains no tokens. */
export type SIWCDispatchIdentity = Readonly<{
  owner: string; sessionVersion: number; binding: string; credentialId: string;
  accountId: string; subject: string | null; email: string | null;
  clientId: string; hostId: string; scope: string;
}>;

type ConnectionVerification = { kind: 'dispatch'; fingerprint: string; identity?: SIWCDispatchIdentity }
  | { kind: 'retained'; identity: SIWCDispatchIdentity };

async function validateSIWCConnection(owner: string, binding: string, verification: ConnectionVerification): Promise<SIWCDispatchIdentity> {
  return db.transaction(async tx => {
    const person = await lockPersonalOwner(owner, tx);
    const [personal] = await tx.select().from(personalCodexAccounts).where(eq(personalCodexAccounts.userId, owner));
    const [credential] = await tx.select().from(userCredentials).where(and(eq(userCredentials.userId, owner), eq(userCredentials.provider, 'chatgpt')));
    if (person.disabled || !personal?.connected || personal.credentialBinding !== binding || !credential ||
      credential.status !== 'active' || (verification.kind === 'dispatch' && (!credential.expiresAt || credential.expiresAt.getTime() <= Date.now())))
      throw new HttpError(409, 'Your ChatGPT connection is no longer available. Reconnect before using Codex.');
    const secret = openCredentialSecret(credential);
    assertSIWCCredential(secret);
    const identity: SIWCDispatchIdentity = Object.freeze({ owner, sessionVersion: person.sessionVersion, binding,
      credentialId: credential.id, accountId: credential.accountId, subject: credential.externalSubject, email: credential.email,
      clientId: secret.siwc.clientId, hostId: secret.siwc.hostId, scope: secret.siwc.scope });
    if (personal.workspaceId !== credential.accountId || personal.email !== credential.email ||
      (verification.kind === 'dispatch' && tokenFingerprint(secret.access) !== verification.fingerprint) ||
      (verification.identity && (Object.keys(identity) as (keyof SIWCDispatchIdentity)[]).some(key => identity[key] !== verification.identity![key])))
      throw new HttpError(409, 'Your ChatGPT connection changed. Synchronize the current account before using Codex.');
    return identity;
  });
}

/** Before dispatch, the broker's token must still be the exact active credential in the portal. */
export function captureCurrentSIWCConnection(owner: string, binding: string, fingerprint: string, identity?: SIWCDispatchIdentity) {
  return validateSIWCConnection(owner, binding, { kind: 'dispatch', fingerprint, identity });
}

export async function assertCurrentSIWCConnection(owner: string, binding: string, fingerprint: string) {
  await captureCurrentSIWCConnection(owner, binding, fingerprint);
}

/** An in-flight turn may survive token refresh only when every captured owner/account/registration fact remains bound. */
export async function assertRetainedSIWCConnection(identity: SIWCDispatchIdentity) {
  await validateSIWCConnection(identity.owner, identity.binding, { kind: 'retained', identity });
}
