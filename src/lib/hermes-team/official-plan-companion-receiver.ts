import { and, eq } from 'drizzle-orm';
import { createPublicKey } from 'node:crypto';
import { z } from 'zod';
import { db, type DbOrTx } from '@/db';
import { officialPlanTransfers } from '@/db/schema';
import { loadPrincipal, type Principal } from '@/lib/auth/groups';
import { sha256Hex } from '@/lib/crypto';
import { type OfficialPlanProvenance } from './official-plan-provenance';
import { type OfficialAuthServices } from './official-plan-auth';
import { startOfficialPlanTransfer, completeOfficialPlanTransfer, cancelOfficialPlanTransfer, protectedOfficialPlanFileReader, type OfficialPlanTransfer, type OfficialPlanTransferServices } from './official-plan-vm-transfer';
import { CompanionPrivateStore } from './official-plan-companion-storage';
import { AckSchema, CompanionHostIdSchema, CustodySchema, EnvelopeSchema, SnapshotSchema, TicketSchema, companionFailure, credentialDigest, openCompanionPayload,
  signTranscript, signedSchema, transcriptDigest, verifyTranscript, type CompanionTicket, type Signed } from './official-plan-companion-protocol';

const key = z.string().min(1).max(8000), id = z.string().min(1).max(256);
export const ReceiverPairingSchema = z.object({ pairingId: id, ownerId: id, sourceHostId: id, sourceSigningPublicKey: key, approvedUntil: z.number().int().positive().safe() }).strict();
export type ApprovedCompanionPairing = z.infer<typeof ReceiverPairingSchema>;
/** Operator approval is separate from authenticated app ownership. No arbitrary/public pairing enrollment exists. */
export const VERIFIED_OFFICIAL_COMPANION_PAIRINGS: readonly ApprovedCompanionPairing[] = Object.freeze([]);
export type ReceiverInstallation = { hostId: string; signingPrivateKey: string; encryptionPrivateKey: string; privateRoot: string;
  /** Current server authentication or an approved gateway identity provider. Never derives a Principal from sender JSON. */
  getPrincipal(q?: DbOrTx): Promise<Principal>;
  /** Must consult the approved installation/pairing authority on every operation, including after provider I/O. */
  approvedPairing(pairingId: string, q?: DbOrTx): Promise<ApprovedCompanionPairing | null> };
const proofSchema = z.object({ ticket: signedSchema(TicketSchema), snapshot: signedSchema(SnapshotSchema) }).strict();
const handoffSchema = z.object({ custody: signedSchema(CustodySchema), snapshot: signedSchema(SnapshotSchema) }).strict();
const recoverySchema = signedSchema(z.object({ ticket: signedSchema(TicketSchema), custodyDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict());
const deliverySchema = z.object({ custodyDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

/** Executable receiver core. Production routes/SSH wrappers and trust configuration remain unregistered. */
export class OfficialPlanCompanionReceiver {
  private readonly root: CompanionPrivateStore;
  readonly services: OfficialPlanTransferServices;
  constructor(private readonly installation: ReceiverInstallation, providers: Pick<OfficialAuthServices, 'fetch' | 'verifier'>) {
    CompanionHostIdSchema.parse(installation.hostId);
    this.root = new CompanionPrivateStore(installation.privateRoot);
    this.services = { ...providers, transports: [{ id: 'collective-companion-v1', hostId: installation.hostId,
      read: protectedOfficialPlanFileReader(installation.privateRoot), verifyHandoff: (p, ticket, digest) => this.provenance(p, ticket, digest),
      assertHandoffCurrent: async (p, ticket, _signal, tx) => { const proof = await this.proof(p, ticket.id); await this.provenance(p, ticket, proof.ticket.body.credentialDigest, tx); } }] };
  }
  private async actor(q: DbOrTx = db) {
    const authenticated = await this.installation.getPrincipal(q), current = await loadPrincipal(authenticated.user.id, q);
    if (!current || current.user.disabled || current.user.sessionVersion !== authenticated.user.sessionVersion) throw companionFailure();
    return current;
  }
  private async pairing(p: Principal, pairingId: string, q: DbOrTx = db) {
    const raw = await this.installation.approvedPairing(pairingId, q); if (!raw) throw companionFailure();
    const pair = ReceiverPairingSchema.parse(raw);
    if (pair.ownerId !== p.user.id || pair.pairingId !== pairingId || pair.approvedUntil <= Date.now() || pair.sourceHostId === this.installation.hostId) throw companionFailure();
    return pair;
  }
  private async row(p: Principal, transferId: string) {
    const [row] = await db.select().from(officialPlanTransfers).where(and(eq(officialPlanTransfers.id, transferId), eq(officialPlanTransfers.userId, p.user.id)));
    if (!row || row.sessionVersion !== p.user.sessionVersion || row.transportId !== 'collective-companion-v1' || row.hostId !== this.installation.hostId) throw companionFailure();
    return row;
  }
  private checkTicket(p: Principal, raw: Signed<CompanionTicket>, pair: ApprovedCompanionPairing) {
    // Our retained challenge is checked against authenticated scope and approved pairing, not sender claims.
    const body = verifyTranscript(raw, createPublicKey(this.installation.signingPrivateKey).export({ format: 'pem', type: 'spki' }).toString());
    if (body.pairingDigest !== transcriptDigest(pair) || body.ownerId !== p.user.id || body.sessionVersion !== p.user.sessionVersion || body.pairingId !== pair.pairingId
      || body.sourceHostId !== pair.sourceHostId || body.destinationHostId !== this.installation.hostId || body.transportId !== 'collective-companion-v1') throw companionFailure();
    return body;
  }
  private async proof(p: Principal, transferId: string) { return this.root.under([sha256Hex(p.user.id), transferId], false, async store => proofSchema.parse(await store.read('challenge.json'))); }
  async challenge(raw: unknown) {
    const p = await this.actor(), snapshot = signedSchema(SnapshotSchema).parse(raw), pair = await this.pairing(p, snapshot.body.pairingId);
    const body = verifyTranscript(snapshot, pair.sourceSigningPublicKey);
    if (body.sourceHostId !== pair.sourceHostId || body.expiresAt <= Date.now() || body.receivedAt > Date.now() + 60000
      || !['chatgpt.tokens.use.direct', 'resource.invoke', 'offline_access'].every(scope => body.scopes.includes(scope))) throw companionFailure();
    const { transferId } = await startOfficialPlanTransfer(p, { clientId: body.clientId, subject: body.subject }, this.services), row = await this.row(p, transferId);
    const ticket = signTranscript<CompanionTicket>({ version: 1, pairingId: pair.pairingId, transferId, ownerId: p.user.id, sessionVersion: p.user.sessionVersion,
      sourceHostId: pair.sourceHostId, destinationHostId: row.hostId, transportId: row.transportId, clientId: body.clientId, subject: body.subject,
      snapshotDigest: transcriptDigest(snapshot), credentialDigest: body.credentialDigest, pairingDigest: transcriptDigest(pair), createdAt: row.createdAt.getTime(), expiresAt: row.expiresAt.getTime() }, this.installation.signingPrivateKey);
    try { await this.root.under([sha256Hex(p.user.id), transferId], true, store => store.write('challenge.json', { ticket, snapshot })); }
    catch { await cancelOfficialPlanTransfer(p, transferId); throw companionFailure(); }
    return ticket;
  }
  private async provenance(p: Principal, row: OfficialPlanTransfer, digest: string, q: DbOrTx = db): Promise<OfficialPlanProvenance> {
    const current = await this.actor(q); if (current.user.id !== p.user.id || current.user.sessionVersion !== p.user.sessionVersion) throw companionFailure();
    return this.root.under([sha256Hex(p.user.id), row.id], false, async store => {
      const proof = proofSchema.parse(await store.read('challenge.json')), pair = await this.pairing(current, proof.ticket.body.pairingId, q), ticket = this.checkTicket(current, proof.ticket, pair);
      const handoff = handoffSchema.parse(await store.read('handoff.json'));
      const custody = verifyTranscript(handoff.custody, pair.sourceSigningPublicKey), snapshot = verifyTranscript(handoff.snapshot, pair.sourceSigningPublicKey);
      if (ticket.transferId !== row.id || ticket.expiresAt <= Date.now() || ticket.clientId !== row.clientId || ticket.subject !== row.subject
        || ticket.credentialDigest !== digest || custody.credentialDigest !== digest || snapshot.credentialDigest !== digest
        || custody.ticketDigest !== transcriptDigest(ticket) || custody.snapshotDigest !== ticket.snapshotDigest || transcriptDigest(handoff.snapshot) !== ticket.snapshotDigest
        || custody.suspendedAt < ticket.createdAt || custody.suspendedAt > Date.now() + 60000 || custody.suspendedAt >= ticket.expiresAt || snapshot.expiresAt <= Date.now()) throw companionFailure();
      return { ownerId: current.user.id, clientId: ticket.clientId, subject: ticket.subject, sourceHostId: pair.sourceHostId, destinationHostId: row.hostId,
        transportId: row.transportId, handoffId: row.id, refreshOwner: 'collective_vm', verifiedAt: Date.now(), expiresAt: pair.approvedUntil };
    });
  }
  async receive(raw: unknown) {
    const p = await this.actor(), envelope = EnvelopeSchema.parse(raw), pair = await this.pairing(p, envelope.pairingId), row = await this.row(p, envelope.transferId);
    if (row.state !== 'pending' || row.expiresAt.getTime() <= Date.now()) throw companionFailure();
    return this.root.under([sha256Hex(p.user.id), row.id], false, store => store.locked(async () => {
      if (await store.read('delivery.json')) throw companionFailure(); // Crash/replay is never a second import.
      const proof = proofSchema.parse(await store.read('challenge.json')), ticket = this.checkTicket(p, proof.ticket, pair);
      if (envelope.ticketDigest !== transcriptDigest(ticket) || ticket.expiresAt <= Date.now()) throw companionFailure();
      const payload = openCompanionPayload(envelope, this.installation.encryptionPrivateKey, pair.sourceSigningPublicKey);
      verifyTranscript(payload.snapshot, pair.sourceSigningPublicKey); verifyTranscript(payload.custody, pair.sourceSigningPublicKey);
      if (credentialDigest(payload.file) !== ticket.credentialDigest || transcriptDigest(payload.snapshot) !== ticket.snapshotDigest
        || payload.custody.body.ticketDigest !== envelope.ticketDigest || payload.custody.body.snapshotDigest !== ticket.snapshotDigest
        || payload.custody.body.credentialDigest !== ticket.credentialDigest || payload.file.source_host_id !== pair.sourceHostId) throw companionFailure();
      const custodyDigest = transcriptDigest(payload.custody);
      await store.write('delivery.json', { custodyDigest }); // Durable claim before staging/provider I/O.
      try {
        await store.write('handoff.json', { custody: payload.custody, snapshot: payload.snapshot }); await store.write('credentials.json', payload.file);
        await completeOfficialPlanTransfer(p, row.id, this.services);
        // Pairing/session changes after provider I/O must not bless an acknowledgment.
        const current = await this.actor(); if (current.user.id !== p.user.id || current.user.sessionVersion !== p.user.sessionVersion) throw companionFailure();
        await this.pairing(current, pair.pairingId);
        return signTranscript({ version: 1 as const, ticketDigest: envelope.ticketDigest, custodyDigest, state: 'complete' as const, at: Date.now() }, this.installation.signingPrivateKey);
      } finally { await store.remove('credentials.json'); }
    }));
  }
  /** Lost-ack recovery is an authenticated status query, not replay of tokens or a rotating grant. */
  async recover(raw: unknown) {
    const p = await this.actor(), request = recoverySchema.parse(raw), pair = await this.pairing(p, request.body.ticket.body.pairingId);
    verifyTranscript(request, pair.sourceSigningPublicKey); const ticket = this.checkTicket(p, request.body.ticket, pair), row = await this.row(p, ticket.transferId);
    return this.root.under([sha256Hex(p.user.id), row.id], false, store => store.locked(async () => {
      const proof = proofSchema.parse(await store.read('challenge.json'));
      if (transcriptDigest(proof.ticket) !== transcriptDigest(request.body.ticket)) throw companionFailure();
      const rawDelivery = await store.read('delivery.json'), delivery = rawDelivery ? deliverySchema.parse(rawDelivery) : null;
      if (delivery && delivery.custodyDigest !== request.body.custodyDigest) throw companionFailure();
      let state: z.infer<typeof AckSchema>['state'] = row.state === 'complete' ? 'complete' : row.state === 'cancelled' ? 'cancelled' : row.state === 'pending' && !delivery ? 'pending' : 'needs_attention';
      if (state === 'complete' && !delivery) throw companionFailure();
      if (state === 'needs_attention' || (state === 'pending' && ticket.expiresAt <= Date.now())) { await cancelOfficialPlanTransfer(p, row.id); state = 'needs_attention'; }
      await store.remove('credentials.json');
      return signTranscript({ version: 1 as const, ticketDigest: transcriptDigest(ticket), custodyDigest: request.body.custodyDigest, state, at: Date.now() }, this.installation.signingPrivateKey);
    }));
  }
}
