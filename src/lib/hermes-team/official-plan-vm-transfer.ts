import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db, type Tx } from '@/db';
import { officialPlanTransfers, officialPlanAuthAttempts, officialPlanAuthOperations } from '@/db/schema';
import { type Principal } from '@/lib/auth/groups';
import { sha256Hex } from '@/lib/crypto';
import { HttpError } from '@/lib/authz';
import { officialAuthServices, ownerLock as owner, retireExpiredAuthAttempts, retireExpiredTransfers, selected as currentSelection, type OfficialAuthServices } from './official-plan-auth';
import { prepareOfficialPlanGrant, persistOfficialPlanGrant } from './official-plan';
import { OfficialPlanProvenanceSchema, type OfficialPlanProvenance } from './official-plan-provenance';
import { CompanionCredentialSchema, credentialDigest } from './official-plan-companion-protocol';
import { CompanionPrivateStore } from './official-plan-companion-storage';

const identity = z.string().min(1).max(256);
const selection = z.object({ clientId: identity, subject: identity, workspaceId: identity.optional() }).strict();
export type OfficialPlanTransfer = typeof officialPlanTransfers.$inferSelect;
export type OfficialPlanTransferTransport = {
  id: string;
  /** Persisted destination identity. Never copied from the transferred laptop credential file. */
  hostId: string;
  read(p: Principal, ticket: OfficialPlanTransfer, signal?: AbortSignal): Promise<unknown>;
  /**
   * Verify an authenticated same-tool receipt for this exact file/ticket and selected registration,
   * and surrender of refresh ownership by the source. Authenticate the entire token set as one locally
   * validated OAuth exchange; a valid ID token cannot bless independently supplied access/refresh tokens.
   * A declaration in the file is insufficient.
   * Optional workspace allowlists additionally require evidence that is not in public SIWC token claims.
   * The issued client itself is bound by OpenAI to the person's selected workspace. No production adapter exists.
   */
  verifyHandoff(p: Principal, ticket: OfficialPlanTransfer, fileHash: string, signal?: AbortSignal): Promise<OfficialPlanProvenance>;
  /** Installation/pairing authority must still approve this handoff after provider I/O. */
  assertHandoffCurrent?(p: Principal, ticket: OfficialPlanTransfer, signal: AbortSignal, tx: Tx): Promise<void>;
};
export const VERIFIED_OFFICIAL_VM_TRANSFERS: readonly OfficialPlanTransferTransport[] = Object.freeze([]);
export type OfficialPlanTransferServices = Pick<OfficialAuthServices, 'fetch' | 'verifier'> & { transports: readonly OfficialPlanTransferTransport[] };
const defaults = (): OfficialPlanTransferServices => ({ ...officialAuthServices(), transports: VERIFIED_OFFICIAL_VM_TRANSFERS });
const unavailable = () => new HttpError(409, 'A supported protected VM transfer with verified per-user registration custody is unavailable in this build.');
const failure = () => new HttpError(409, 'The protected credential transfer was not confirmed. Start a new approved transfer.');
async function bounded<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation(controller.signal), new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(failure()); }, 8000); })]); }
  finally { clearTimeout(timer); controller.abort(); }
}

/** Server-authenticated actor only. This internal candidate is deliberately not a browser import endpoint. */
export async function startOfficialPlanTransfer(p: Principal, raw: z.infer<typeof selection>, services = defaults()) {
  const selected = selection.parse(raw), transport = services.transports[0];
  if (!transport) throw unavailable();
  identity.parse(transport.id); identity.parse(transport.hostId);
  return db.transaction(async tx => {
    await owner(tx, p);
    await retireExpiredTransfers(p, tx); await retireExpiredAuthAttempts(p, tx);
    const active = await tx.select({ id: officialPlanTransfers.id }).from(officialPlanTransfers).where(and(eq(officialPlanTransfers.userId, p.user.id), inArray(officialPlanTransfers.state, ['pending', 'importing'])));
    const auth = await tx.select({ id: officialPlanAuthAttempts.id }).from(officialPlanAuthAttempts).where(and(eq(officialPlanAuthAttempts.userId, p.user.id), inArray(officialPlanAuthAttempts.state, ['pending', 'exchanging'])));
    const rotation = await tx.select({ id: officialPlanAuthOperations.id }).from(officialPlanAuthOperations).where(and(eq(officialPlanAuthOperations.userId, p.user.id), eq(officialPlanAuthOperations.state, 'running')));
    if (active.length || auth.length || rotation.length) throw new HttpError(409, 'Complete or cancel the current account operation first.');
    const prior = await currentSelection(p, tx);
    const now = new Date();
    const [ticket] = await tx.insert(officialPlanTransfers).values({ id: randomUUID(), userId: p.user.id, sessionVersion: p.user.sessionVersion,
      transportId: transport.id, hostId: transport.hostId, ...selected, expectedConnectionId: prior?.id ?? null, expectedRevision: prior?.revision ?? null,
      createdAt: now, updatedAt: now, expiresAt: new Date(now.getTime() + 600000) }).returning();
    return { transferId: ticket.id };
  });
}

/** Cancellation fences a delayed completion, including after a process restart. */
export async function cancelOfficialPlanTransfer(p: Principal, transferId: string) {
  return db.transaction(async tx => {
    await owner(tx, p);
    const [ticket] = await tx.select().from(officialPlanTransfers).where(and(eq(officialPlanTransfers.id, transferId), eq(officialPlanTransfers.userId, p.user.id))).for('update');
    if (!ticket) throw new HttpError(404, 'Credential transfer not found.');
    if (['pending', 'importing', 'needs_attention'].includes(ticket.state)) await tx.update(officialPlanTransfers).set({ state: 'cancelled', updatedAt: new Date() }).where(eq(officialPlanTransfers.id, ticket.id));
    return { cancelled: true };
  });
}

export async function completeOfficialPlanTransfer(p: Principal, transferId: string, services = defaults()) {
  if (!services.transports.length) throw unavailable();
  const ticket = await db.transaction(async tx => {
    await owner(tx, p);
    const [row] = await tx.select().from(officialPlanTransfers).where(and(eq(officialPlanTransfers.id, transferId), eq(officialPlanTransfers.userId, p.user.id))).for('update');
    if (!row) throw new HttpError(404, 'Credential transfer not found.');
    if (row.state !== 'pending' || row.sessionVersion !== p.user.sessionVersion || row.expiresAt.getTime() <= Date.now()) throw failure();
    const transport = services.transports.find(item => item.id === row.transportId && item.hostId === row.hostId);
    if (!transport) throw unavailable();
    const prior = await currentSelection(p, tx);
    if ((prior?.id ?? null) !== row.expectedConnectionId || (prior?.revision ?? null) !== row.expectedRevision) throw failure();
    await tx.update(officialPlanTransfers).set({ state: 'importing', updatedAt: new Date() }).where(eq(officialPlanTransfers.id, row.id));
    return row;
  });
  try {
    const transport = services.transports.find(item => item.id === ticket.transportId && item.hostId === ticket.hostId)!;
    const file = CompanionCredentialSchema.parse(await bounded(signal => transport.read(p, ticket, signal)));
    if (file.client_id !== ticket.clientId || file.subject !== ticket.subject || file.source_host_id === ticket.hostId) throw failure();
    const provenance = OfficialPlanProvenanceSchema.parse(await bounded(signal => transport.verifyHandoff(p, ticket, credentialDigest(file), signal)));
    if (provenance.ownerId !== p.user.id || provenance.clientId !== ticket.clientId || provenance.subject !== ticket.subject
      || provenance.workspaceId !== (ticket.workspaceId ?? undefined) || provenance.destinationHostId !== ticket.hostId || provenance.sourceHostId !== file.source_host_id
      || provenance.transportId !== ticket.transportId || provenance.handoffId !== ticket.id) throw failure();
    // Claim custody before provider I/O. Duplicate copies cannot become another owner's refresh source.
    await db.transaction(async tx => {
      await owner(tx, p);
      const [current] = await tx.select().from(officialPlanTransfers).where(eq(officialPlanTransfers.id, ticket.id)).for('update');
      if (current?.state !== 'importing' || current.expiresAt.getTime() <= Date.now()) throw failure();
      await tx.update(officialPlanTransfers).set({ refreshHash: sha256Hex(file.refresh_token), updatedAt: new Date() }).where(eq(officialPlanTransfers.id, ticket.id));
    });
    await bounded(() => services.verifier.verifyIdToken(file.id_token, { clientId: ticket.clientId, subject: ticket.subject }));
    const prepared = await bounded(signal => prepareOfficialPlanGrant({ clientId: ticket.clientId, subject: ticket.subject, hostId: ticket.hostId,
      access: file.access_token, refresh: file.refresh_token, idToken: file.id_token, earliestRefreshHint: file.earliest_refresh_at, provenance }, { fetch: (url, init) => services.fetch(url, { ...init, signal }), verifyAccessToken: token => services.verifier.verifyAccessToken(token) }));
    return await db.transaction(async tx => {
      await owner(tx, p);
      const [current] = await tx.select().from(officialPlanTransfers).where(eq(officialPlanTransfers.id, ticket.id)).for('update');
      if (current?.state !== 'importing' || current.expiresAt.getTime() <= Date.now()) throw failure();
      if (transport.assertHandoffCurrent) await bounded(signal => transport.assertHandoffCurrent!(p, ticket, signal, tx));
      const result = await persistOfficialPlanGrant(p, prepared, tx, { id: ticket.expectedConnectionId, revision: ticket.expectedRevision ?? undefined });
      await tx.update(officialPlanTransfers).set({ state: 'complete', updatedAt: new Date() }).where(eq(officialPlanTransfers.id, ticket.id));
      return result;
    });
  } catch {
    await db.update(officialPlanTransfers).set({ state: 'needs_attention', updatedAt: new Date() }).where(and(eq(officialPlanTransfers.id, ticket.id), eq(officialPlanTransfers.state, 'importing')));
    throw failure();
  }
}

/**
 * App-defined VM path: <private root>/<sha256 actor>/<transfer UUID>/credentials.json.
 * Only the trusted adapter can call this reader. Secure transfer/authenticated receipt are separate concerns.
 * Descriptor-pinned traversal and file checks are CompanionPrivateStore's; no home deletion or history mutation.
 */
export function protectedOfficialPlanFileReader(privateRoot: string) {
  return async (p: Principal, ticket: OfficialPlanTransfer): Promise<unknown> => {
    try {
      if (ticket.userId !== p.user.id || ticket.sessionVersion !== p.user.sessionVersion) throw failure();
      z.string().uuid().parse(ticket.id);
      const file = await new CompanionPrivateStore(privateRoot).under([sha256Hex(p.user.id), ticket.id], false, store => store.read('credentials.json'));
      if (file === null) throw failure();
      return file;
    } catch { throw failure(); }
  };
}
