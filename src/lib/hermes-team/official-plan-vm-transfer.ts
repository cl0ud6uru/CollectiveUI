import { constants } from 'node:fs';
import { open, realpath, type FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, type Tx } from '@/db';
import { officialPlanConnections, officialPlanTransfers, officialPlanAuthAttempts, officialPlanAuthOperations } from '@/db/schema';
import { loadPrincipal, type Principal } from '@/lib/auth/groups';
import { sha256Hex } from '@/lib/crypto';
import { HttpError } from '@/lib/authz';
import { officialAuthServices, type OfficialAuthServices } from './official-plan-auth';
import { prepareOfficialPlanGrant, persistOfficialPlanGrant } from './official-plan';
import { OfficialPlanProvenanceSchema, type OfficialPlanProvenance } from './official-plan-provenance';

const identity = z.string().min(1).max(256);
const selection = z.object({ clientId: identity, subject: identity, workspaceId: identity.optional() }).strict();
const credentialFile = z.object({
  version: z.literal(1), client_id: identity, subject: identity, source_host_id: identity,
  access_token: z.string().min(1).max(16000), refresh_token: z.string().min(1).max(16000),
  id_token: z.string().min(1).max(16000),
  earliest_refresh_at: z.union([z.string().max(256), z.number().finite(), z.null()]).optional(),
}).strict();
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

async function owner(tx: Tx, p: Principal) {
  await tx.execute(sql`select id from users where id = ${p.user.id} for update`);
  const current = await loadPrincipal(p.user.id, tx);
  if (!current || current.user.disabled || current.user.sessionVersion !== p.user.sessionVersion) throw new HttpError(403, 'The account session changed.');
}
const currentSelection = async (tx: Tx, p: Principal) => (await tx.select().from(officialPlanConnections)
  .where(and(eq(officialPlanConnections.userId, p.user.id), eq(officialPlanConnections.selected, true))).for('update'))[0];

/** Server-authenticated actor only. This internal candidate is deliberately not a browser import endpoint. */
export async function startOfficialPlanTransfer(p: Principal, raw: z.infer<typeof selection>, services = defaults()) {
  const selected = selection.parse(raw), transport = services.transports[0];
  if (!transport) throw unavailable();
  identity.parse(transport.id); identity.parse(transport.hostId);
  return db.transaction(async tx => {
    await owner(tx, p);
    // Expired in-flight imports remain uncertain; they are never resumed after restart.
    await tx.update(officialPlanTransfers).set({ state: 'cancelled', updatedAt: new Date() }).where(and(eq(officialPlanTransfers.userId, p.user.id), eq(officialPlanTransfers.state, 'pending'), sql`${officialPlanTransfers.expiresAt} <= now()`));
    await tx.update(officialPlanTransfers).set({ state: 'needs_attention', updatedAt: new Date() }).where(and(eq(officialPlanTransfers.userId, p.user.id), eq(officialPlanTransfers.state, 'importing'), sql`${officialPlanTransfers.expiresAt} <= now()`));
    const active = await tx.select({ id: officialPlanTransfers.id }).from(officialPlanTransfers).where(and(eq(officialPlanTransfers.userId, p.user.id), inArray(officialPlanTransfers.state, ['pending', 'importing'])));
    const auth = await tx.select({ id: officialPlanAuthAttempts.id }).from(officialPlanAuthAttempts).where(and(eq(officialPlanAuthAttempts.userId, p.user.id), inArray(officialPlanAuthAttempts.state, ['pending', 'exchanging'])));
    const rotation = await tx.select({ id: officialPlanAuthOperations.id }).from(officialPlanAuthOperations).where(and(eq(officialPlanAuthOperations.userId, p.user.id), eq(officialPlanAuthOperations.state, 'running')));
    if (active.length || auth.length || rotation.length) throw new HttpError(409, 'Complete or cancel the current account operation first.');
    const prior = await currentSelection(tx, p);
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
    const prior = await currentSelection(tx, p);
    if ((prior?.id ?? null) !== row.expectedConnectionId || (prior?.revision ?? null) !== row.expectedRevision) throw failure();
    await tx.update(officialPlanTransfers).set({ state: 'importing', updatedAt: new Date() }).where(eq(officialPlanTransfers.id, row.id));
    return row;
  });
  try {
    const transport = services.transports.find(item => item.id === ticket.transportId && item.hostId === ticket.hostId)!;
    const file = credentialFile.parse(await bounded(signal => transport.read(p, ticket, signal)));
    if (file.client_id !== ticket.clientId || file.subject !== ticket.subject || file.source_host_id === ticket.hostId) throw failure();
    const provenance = OfficialPlanProvenanceSchema.parse(await bounded(signal => transport.verifyHandoff(p, ticket, sha256Hex(JSON.stringify(file)), signal)));
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
 * No following links, FIFO waits, unbounded reads, arbitrary browser paths, home deletion or history mutation.
 */
export function protectedOfficialPlanFileReader(privateRoot: string) {
  const root = resolve(privateRoot);
  return async (p: Principal, ticket: OfficialPlanTransfer): Promise<unknown> => {
    try {
      if (ticket.userId !== p.user.id || ticket.sessionVersion !== p.user.sessionVersion) throw failure();
      z.string().uuid().parse(ticket.id);
      if (process.platform !== 'linux') throw failure(); // Descriptor-relative paths require Linux procfs.
      if (await realpath(root) !== root) throw failure();
      const directories: FileHandle[] = [];
      try {
        // Pin each parent before opening the next component. A replaced pathname cannot redirect its child.
        for (const component of [root, sha256Hex(p.user.id), ticket.id]) {
          const path = directories.length ? `/proc/self/fd/${directories.at(-1)!.fd}/${component}` : component;
          const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          directories.push(directory);
          const stat = await directory.stat();
          if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw failure();
        }
        const handle = await open(`/proc/self/fd/${directories.at(-1)!.fd}/credentials.json`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.nlink !== 1 || stat.size < 1 || stat.size > 50000) throw failure();
          const buffer = Buffer.alloc(50001); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          const after = await handle.stat();
          if (bytesRead !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw failure();
          return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)));
        } finally { await handle.close(); }
      } finally { await Promise.all(directories.map(directory => directory.close())); }
    } catch { throw failure(); }
  };
}
