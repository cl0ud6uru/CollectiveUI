import { createHash, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { and, eq, inArray, lte } from 'drizzle-orm';
import { z } from 'zod';
import { db, type DbOrTx } from '@/db';
import { auditLog, chatgptCompanionAttempts, personalCodexAccounts, userCredentials } from '@/db/schema';
import { resolvePrincipal, type Principal } from '@/lib/auth/groups';
import { HttpError } from '@/lib/authz';
import { decrypt, encrypt } from '@/lib/crypto';
import { getSetting } from '@/lib/settings';
import { assertNoCodexWork, lockPersonalOwner } from '@/personal-codex/accounts';
import { AckSchema, CompanionHostIdSchema, CustodySchema, EnvelopeSchema, SnapshotSchema, TicketSchema, credentialDigest,
  openCompanionPayload, signTranscript, signedSchema, transcriptDigest, verifyTranscript, type CompanionTicket } from '@/lib/hermes-team/official-plan-companion-protocol';
import { applySIWCProfileLocked, changeUnifiedAccount } from './account';
import { requireCompanionConfiguration, COMPANION_PROTOCOL } from './companion-config';
import { cancelCompanionAttemptsLocked, openCompanionStates } from './companion-state';
import { clearPersonalCodexAuthenticationLocked } from './invalidation';
import { accountSetupEligibility, prepareAccountRuntime, runtimeConsent } from './onboarding';
import { openCredentialSecret, revokeCredentialSecret } from './store';
import { SIWCCredentialSchema, validateSIWCCredential } from './siwc';

const id = z.string().uuid(), capability = z.string().regex(/^[A-Za-z0-9_-]{43}$/), pem = z.string().min(1).max(8000), digest = z.string().regex(/^[a-f0-9]{64}$/);
const sourceSchema = z.object({ sourceHostId: CompanionHostIdSchema, sourceSigningPublicKey: pem, returnToken: capability }).strict();
const grantScopes = ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'];
const payloadSchema = z.object({ signingPrivateKey: pem, encryptionPrivateKey: pem, expectedBinding: digest.nullable(),
  registration: z.object({ clientId: z.string().min(1).max(256), subject: z.string().min(1).max(256) }).strict().optional(),
  source: sourceSchema.optional(), ticket: signedSchema(TicketSchema).optional() }).strict();
type Attempt = typeof chatgptCompanionAttempts.$inferSelect;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('base64url');
const failure = () => new HttpError(409, 'The local sign-in was not confirmed. Check its status before retrying.');
const aad = (attempt: Attempt) => `chatgpt_companion_attempts.payload_enc|${attempt.id}|${attempt.userId}`;
const unpack = (attempt: Attempt) => payloadSchema.parse(JSON.parse(decrypt(attempt.payloadEnc, aad(attempt))));
const pack = (attempt: Pick<Attempt, 'id' | 'userId'>, payload: z.infer<typeof payloadSchema>) => encrypt(JSON.stringify(payloadSchema.parse(payload)), `chatgpt_companion_attempts.payload_enc|${attempt.id}|${attempt.userId}`);
const matches = (value: string, expected: string) => timingSafeEqual(Buffer.from(hash(value)), Buffer.from(expected));
const publicKey = (privateKey: string) => createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();

async function credentialBinding(owner: string, tx: DbOrTx) {
  const [row] = await tx.select().from(userCredentials).where(and(eq(userCredentials.userId, owner), eq(userCredentials.provider, 'chatgpt'))).for('update');
  return { row, binding: row ? transcriptDigest({ id: row.id, accountId: row.accountId, subject: row.externalSubject, status: row.status, ciphertext: row.secretEnc }) : null };
}
async function browserActor(p: Principal, tx: DbOrTx, checkPolicy = true) {
  const person = await lockPersonalOwner(p.user.id, tx);
  if (person.disabled || person.sessionVersion !== p.user.sessionVersion) throw new HttpError(403, 'Sign in to CollectiveUI again.');
  const principal = await resolvePrincipal(person, tx);
  if (checkPolicy) {
    const eligibility = accountSetupEligibility(principal, await getSetting('chatgpt', tx), process.env.CHATGPT_SIWC_HOST_ID);
    if (!eligibility.allowed) throw new HttpError(403, eligibility.reason!);
  }
  return principal;
}
async function availableStart(p: Principal, tx: DbOrTx) {
  const principal = await browserActor(p, tx);
  await assertNoCodexWork(p.user.id, tx);
  await tx.update(chatgptCompanionAttempts).set({ state: 'expired', updatedAt: new Date() }).where(and(eq(chatgptCompanionAttempts.userId, p.user.id),
    inArray(chatgptCompanionAttempts.state, [...openCompanionStates]), lte(chatgptCompanionAttempts.expiresAt, new Date())));
  const [pending] = await tx.select().from(chatgptCompanionAttempts).where(and(eq(chatgptCompanionAttempts.userId, p.user.id), inArray(chatgptCompanionAttempts.state, [...openCompanionStates])));
  if (pending) throw new HttpError(409, 'A sign-in is already in progress. Finish or cancel it before starting again.');
  return principal;
}
export async function beginCompanionSignIn(p: Principal, input: { accepted: true; consentVersion: 1; enableCodex: boolean }) {
  runtimeConsent.parse({ accepted: input.accepted, consentVersion: input.consentVersion });
  const configuration = requireCompanionConfiguration();
  await db.transaction(tx => availableStart(p, tx));
  if (input.enableCodex) await prepareAccountRuntime(p, { accepted: true, consentVersion: 1 });
  return db.transaction(async tx => {
    await availableStart(p, tx);
    const hostId = SIWCCredentialSchema.shape.hostId.parse(process.env.CHATGPT_SIWC_HOST_ID?.trim()), attemptId = randomUUID(), launchToken = random();
    const signing = generateKeyPairSync('ed25519'), encryption = generateKeyPairSync('x25519'), current = await credentialBinding(p.user.id, tx);
    let registration: z.infer<typeof payloadSchema>['registration'];
    if (current.row?.externalSubject) {
      try { const secret = openCredentialSecret(current.row); if (secret.siwc) registration = { clientId: secret.siwc.clientId, subject: current.row.externalSubject }; } catch { /* explicit credential migration */ }
    }
    const createdAt = new Date(), expiresAt = new Date(createdAt.getTime() + 10 * 60_000), recoveryUntil = new Date(createdAt.getTime() + 24 * 60 * 60_000);
    const owner = { id: attemptId, userId: p.user.id };
    await tx.insert(chatgptCompanionAttempts).values({ ...owner, sessionVersion: p.user.sessionVersion, origin: configuration.origin, hostId,
      launchHash: hash(launchToken), enableCodex: input.enableCodex, createdAt, expiresAt, recoveryUntil,
      payloadEnc: pack(owner, { signingPrivateKey: signing.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        encryptionPrivateKey: encryption.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), expectedBinding: current.binding, ...(registration ? { registration } : {}) }) });
    await tx.insert(auditLog).values({ actorId: p.user.id, action: 'chatgpt.companion.start', target: p.user.id, details: { consentVersion: 1, enableCodex: input.enableCodex } });
    const launch = new URL('collectiveui-chatgpt://connect');
    launch.searchParams.set('origin', configuration.origin); launch.searchParams.set('attempt', attemptId); launch.searchParams.set('ticket', launchToken);
    return { launchUrl: launch.href, expiresAt: expiresAt.toISOString() };
  });
}
export async function cancelCompanionSignIn(p: Principal) {
  return db.transaction(async tx => {
    await browserActor(p, tx, false); await cancelCompanionAttemptsLocked(p.user.id, tx);
    return { cancelled: true };
  });
}
async function lookup(attemptId: string) {
  const [row] = await db.select().from(chatgptCompanionAttempts).where(eq(chatgptCompanionAttempts.id, id.parse(attemptId)));
  if (!row) throw failure(); return row;
}
async function nativeLocked<T>(attemptId: string, authorization: string | null, operation: (attempt: Attempt, payload: z.infer<typeof payloadSchema>, principal: Principal, tx: DbOrTx) => Promise<T>, mutate = true) {
  const preliminary = await lookup(attemptId);
  return db.transaction(async tx => {
    const principal = await browserActor({ user: { id: preliminary.userId, sessionVersion: preliminary.sessionVersion } } as Principal, tx, mutate);
    const [attempt] = await tx.select().from(chatgptCompanionAttempts).where(and(eq(chatgptCompanionAttempts.id, preliminary.id), eq(chatgptCompanionAttempts.userId, principal.user.id))).for('update');
    if (!attempt || attempt.sessionVersion !== principal.user.sessionVersion || attempt.hostId !== process.env.CHATGPT_SIWC_HOST_ID?.trim()
      || attempt.origin !== new URL(process.env.AUTH_URL || '').origin || attempt.recoveryUntil.getTime() <= Date.now()) throw failure();
    const token = authorization?.match(/^Companion ([A-Za-z0-9_-]{43})$/)?.[1];
    if (!token || !attempt.returnHash || !matches(token, attempt.returnHash)) throw failure();
    if (mutate) {
      requireCompanionConfiguration();
      if (attempt.expiresAt.getTime() <= Date.now() || !['paired', 'receiving'].includes(attempt.state)) throw failure();
      await assertNoCodexWork(principal.user.id, tx);
      if ((await credentialBinding(principal.user.id, tx)).binding !== unpack(attempt).expectedBinding) throw failure();
    }
    return operation(attempt, unpack(attempt), principal, tx);
  });
}
const redeemSchema = z.object({ action: z.literal('redeem'), attemptId: id, launchToken: capability, sourceHostId: CompanionHostIdSchema,
  sourceSigningPublicKey: pem, signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) }).strict();
export async function redeemCompanion(raw: unknown) {
  const request = redeemSchema.parse(raw), preliminary = await lookup(request.attemptId), configuration = requireCompanionConfiguration();
  return db.transaction(async tx => {
    const principal = await browserActor({ user: { id: preliminary.userId, sessionVersion: preliminary.sessionVersion } } as Principal, tx);
    const [attempt] = await tx.select().from(chatgptCompanionAttempts).where(eq(chatgptCompanionAttempts.id, preliminary.id)).for('update');
    if (!attempt || !['created', 'paired'].includes(attempt.state) || attempt.expiresAt.getTime() <= Date.now() || attempt.origin !== configuration.origin
      || attempt.hostId !== process.env.CHATGPT_SIWC_HOST_ID?.trim() || request.sourceHostId === attempt.hostId || !matches(request.launchToken, attempt.launchHash)) throw failure();
    const proof = { attemptId: request.attemptId, launchToken: request.launchToken, sourceHostId: request.sourceHostId, sourceSigningPublicKey: request.sourceSigningPublicKey };
    verifyTranscript({ body: proof, signature: request.signature }, request.sourceSigningPublicKey);
    const payload = unpack(attempt);
    if ((await credentialBinding(principal.user.id, tx)).binding !== payload.expectedBinding) throw failure();
    await assertNoCodexWork(principal.user.id, tx);
    if (payload.source && (payload.source.sourceHostId !== request.sourceHostId || payload.source.sourceSigningPublicKey !== request.sourceSigningPublicKey)) throw failure();
    const source = payload.source ?? { sourceHostId: request.sourceHostId, sourceSigningPublicKey: request.sourceSigningPublicKey, returnToken: random() };
    await tx.update(chatgptCompanionAttempts).set({ state: 'paired', returnHash: hash(source.returnToken), payloadEnc: pack(attempt, { ...payload, source }), updatedAt: new Date() }).where(eq(chatgptCompanionAttempts.id, attempt.id));
    const email = [principal.user.email, principal.user.upn].find(value => z.email().safeParse(value).success)!;
    return { returnToken: source.returnToken, origin: attempt.origin, ownerId: principal.user.id, email,
      pairing: { version: 1, pairingId: attempt.id, appOwnerId: principal.user.id, sourceHostId: source.sourceHostId,
        sourceSigningPublicKey: source.sourceSigningPublicKey, receiverHostId: attempt.hostId, receiverSigningPublicKey: publicKey(payload.signingPrivateKey),
        receiverEncryptionPublicKey: publicKey(payload.encryptionPrivateKey), approvedUntil: attempt.recoveryUntil.getTime() },
      ...(payload.registration ? { registration: payload.registration } : {}), expiresAt: attempt.expiresAt.getTime() };
  });
}
function pair(attempt: Attempt, payload: z.infer<typeof payloadSchema>) {
  if (!payload.source) throw failure();
  return { pairingId: attempt.id, ownerId: attempt.userId, sourceHostId: payload.source.sourceHostId,
    sourceSigningPublicKey: payload.source.sourceSigningPublicKey, approvedUntil: attempt.recoveryUntil.getTime() };
}
export async function challengeCompanion(attemptId: string, authorization: string | null, raw: unknown) {
  return nativeLocked(attemptId, authorization, async (attempt, payload, _principal, tx) => {
    if (attempt.state !== 'paired' || !payload.source) throw failure();
    const snapshot = signedSchema(SnapshotSchema).parse(raw), body = verifyTranscript(snapshot, payload.source.sourceSigningPublicKey);
    if (body.pairingId !== attempt.id || body.sourceHostId !== payload.source.sourceHostId || body.validation !== 'authorization_code'
      || body.clientId === 'dynamic_agent_client' || body.scopes.length !== grantScopes.length || grantScopes.some(scope => !body.scopes.includes(scope))
      || body.expiresAt <= Date.now() || body.receivedAt > Date.now() + 60_000 || body.receivedAt < attempt.createdAt.getTime() - 60_000
      || (payload.registration && (body.clientId !== payload.registration.clientId || body.subject !== payload.registration.subject))) throw failure();
    if (payload.ticket) {
      if (payload.ticket.body.snapshotDigest !== transcriptDigest(snapshot)) throw failure(); return payload.ticket;
    }
    const ticket = signTranscript<CompanionTicket>({ version: 1, pairingId: attempt.id, transferId: attempt.id, ownerId: attempt.userId,
      sessionVersion: attempt.sessionVersion, sourceHostId: payload.source.sourceHostId, destinationHostId: attempt.hostId, transportId: COMPANION_PROTOCOL,
      clientId: body.clientId, subject: body.subject, snapshotDigest: transcriptDigest(snapshot), credentialDigest: body.credentialDigest,
      pairingDigest: transcriptDigest(pair(attempt, payload)), createdAt: Date.now(), expiresAt: attempt.expiresAt.getTime() }, payload.signingPrivateKey);
    await tx.update(chatgptCompanionAttempts).set({ payloadEnc: pack(attempt, { ...payload, ticket }), updatedAt: new Date() }).where(eq(chatgptCompanionAttempts.id, attempt.id));
    return ticket;
  });
}
function acknowledgment(attempt: Attempt, payload: z.infer<typeof payloadSchema>, state: z.infer<typeof AckSchema>['state']) {
  if (!payload.ticket || !attempt.custodyHash) throw failure();
  return signTranscript({ version: 1 as const, ticketDigest: transcriptDigest(payload.ticket.body), custodyDigest: attempt.custodyHash, state, at: Date.now() }, payload.signingPrivateKey);
}
export async function receiveCompanion(attemptId: string, authorization: string | null, raw: unknown) {
  const claimed = await nativeLocked(attemptId, authorization, async (attempt, payload, principal, tx) => {
    if (attempt.state !== 'paired' || !payload.source || !payload.ticket || attempt.custodyHash) throw failure();
    const envelope = EnvelopeSchema.parse(raw), ticket = payload.ticket.body;
    if (envelope.pairingId !== attempt.id || envelope.transferId !== attempt.id || envelope.ticketDigest !== transcriptDigest(ticket)) throw failure();
    const received = openCompanionPayload(envelope, payload.encryptionPrivateKey, payload.source.sourceSigningPublicKey);
    const snapshot = verifyTranscript(received.snapshot, payload.source.sourceSigningPublicKey), custody = verifyTranscript(received.custody, payload.source.sourceSigningPublicKey);
    CustodySchema.parse(custody);
    if (credentialDigest(received.file) !== ticket.credentialDigest || transcriptDigest(received.snapshot) !== ticket.snapshotDigest
      || snapshot.credentialDigest !== ticket.credentialDigest || snapshot.expiresAt <= Date.now() || snapshot.sourceHostId !== ticket.sourceHostId
      || received.file.source_host_id !== ticket.sourceHostId || received.file.client_id !== ticket.clientId || received.file.subject !== ticket.subject
      || custody.ticketDigest !== envelope.ticketDigest || custody.snapshotDigest !== ticket.snapshotDigest || custody.credentialDigest !== ticket.credentialDigest
      || custody.suspendedAt < ticket.createdAt - 60_000 || custody.suspendedAt > Date.now() + 60_000 || custody.suspendedAt >= ticket.expiresAt) throw failure();
    const custodyHash = transcriptDigest(received.custody);
    await tx.update(chatgptCompanionAttempts).set({ state: 'receiving', custodyHash, updatedAt: new Date() }).where(eq(chatgptCompanionAttempts.id, attempt.id));
    return { attempt: { ...attempt, state: 'receiving' as const, custodyHash }, payload, principal, received };
  });
  try {
    const profile = SIWCCredentialSchema.parse({ version: 1, kind: 'siwc', clientId: claimed.received.file.client_id, accessToken: claimed.received.file.access_token,
      refreshToken: claimed.received.file.refresh_token, idToken: claimed.received.file.id_token, scope: claimed.received.snapshot.body.scopes.join(' '),
      hostId: claimed.received.file.source_host_id, createdAt: new Date(claimed.received.snapshot.body.receivedAt).toISOString() });
    const identity = await validateSIWCCredential(profile, { hostId: profile.hostId, subject: claimed.received.snapshot.body.subject });
    const committed = await nativeLocked(attemptId, authorization, async (attempt, payload, principal, tx) => {
      if (attempt.state !== 'receiving' || attempt.custodyHash !== claimed.attempt.custodyHash) throw failure();
      const current = await credentialBinding(principal.user.id, tx);
      const [retained] = await tx.select().from(personalCodexAccounts).where(eq(personalCodexAccounts.userId, principal.user.id));
      if (current.row || retained) await clearPersonalCodexAuthenticationLocked(principal.user.id, tx);
      const result = await applySIWCProfileLocked(principal, profile, identity, tx);
      await tx.update(chatgptCompanionAttempts).set({ state: 'complete', updatedAt: new Date() }).where(eq(chatgptCompanionAttempts.id, attempt.id));
      await tx.insert(auditLog).values({ actorId: principal.user.id, action: 'chatgpt.companion.complete', target: principal.user.id, details: { enableCodex: attempt.enableCodex } });
      return { ...result, principal, enableCodex: attempt.enableCodex, ack: acknowledgment(attempt, payload, 'complete') };
    });
    if (committed.previous && committed.previous.refresh !== profile.refreshToken) await revokeCredentialSecret(committed.previous);
    if (committed.enableCodex) {
      try { await changeUnifiedAccount(committed.principal, 'sync-token'); }
      catch { await db.insert(auditLog).values({ actorId: committed.principal.user.id, action: 'chatgpt.companion.codex_sync_failed', target: committed.principal.user.id, details: { accountActivated: true } }).catch(() => {}); }
    }
    return committed.ack;
  } catch {
    await db.transaction(async tx => {
      await lockPersonalOwner(claimed.attempt.userId, tx);
      await tx.update(chatgptCompanionAttempts).set({ state: 'needs_attention', updatedAt: new Date() })
        .where(and(eq(chatgptCompanionAttempts.id, attemptId), eq(chatgptCompanionAttempts.state, 'receiving')));
    }).catch(() => {});
    throw failure();
  }
}
const recoverySchema = signedSchema(z.object({ ticket: signedSchema(TicketSchema), custodyDigest: digest }).strict());
export async function recoverCompanion(attemptId: string, authorization: string | null, raw: unknown) {
  return nativeLocked(attemptId, authorization, async (attempt, payload, _principal, tx) => {
    if (!payload.source || !payload.ticket) throw failure();
    const request = recoverySchema.parse(raw); verifyTranscript(request, payload.source.sourceSigningPublicKey);
    if (transcriptDigest(request.body.ticket) !== transcriptDigest(payload.ticket) || (attempt.custodyHash && attempt.custodyHash !== request.body.custodyDigest)) throw failure();
    const state = attempt.state === 'complete' ? 'complete' : attempt.state === 'cancelled' || attempt.state === 'expired' ? 'cancelled'
      : attempt.state === 'paired' && !attempt.custodyHash && attempt.expiresAt.getTime() > Date.now() ? 'pending' : 'needs_attention';
    // A negative acknowledgement relinquishes local custody permanently. Fence a
    // delayed receive before signing it so that receive cannot activate afterward.
    if (state === 'needs_attention' && openCompanionStates.includes(attempt.state as typeof openCompanionStates[number])) {
      await tx.update(chatgptCompanionAttempts).set({ state: 'needs_attention', updatedAt: new Date() }).where(eq(chatgptCompanionAttempts.id, attempt.id));
    }
    return acknowledgment({ ...attempt, custodyHash: attempt.custodyHash ?? request.body.custodyDigest }, payload, state);
  }, false);
}
export async function cancelNativeCompanion(attemptId: string, authorization: string | null) {
  return nativeLocked(attemptId, authorization, async (attempt, _payload, _principal, tx) => {
    if (attempt.state === 'cancelled' && !attempt.custodyHash) return { cancelled: true };
    if (attempt.state !== 'paired' || attempt.custodyHash) throw failure();
    await tx.update(chatgptCompanionAttempts).set({ state: 'cancelled', updatedAt: new Date() }).where(eq(chatgptCompanionAttempts.id, attempt.id));
    return { cancelled: true };
  }, false);
}
export async function companionNativeStatus(attemptId: string, authorization: string | null) {
  return nativeLocked(attemptId, authorization, async attempt => ({ state: [...openCompanionStates].includes(attempt.state as typeof openCompanionStates[number]) && attempt.expiresAt.getTime() <= Date.now() ? 'expired' : attempt.state }), false);
}
