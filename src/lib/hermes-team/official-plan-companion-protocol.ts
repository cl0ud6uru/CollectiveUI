import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';
import { z } from 'zod';
import { HttpError } from '@/lib/http-error';

export const companionFailure = () => new HttpError(409, 'The protected companion operation was not confirmed. Keep this session suspended and start a new approved connection.');
const id = z.string().min(1).max(256), digest = z.string().regex(/^[a-f0-9]{64}$/), time = z.number().int().nonnegative().safe();
export const CompanionHostIdSchema = id.refine(value => /^urn:uuid:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
  || /^urn:ietf:params:oauth:jwk-thumbprint:[A-Za-z0-9:._-]+$/.test(value) || /^did:key:[A-Za-z0-9:_-]+$/.test(value));
const secret = z.string().min(1).max(16000);
export const CompanionCredentialSchema = z.object({ version: z.literal(1), client_id: id, subject: id, source_host_id: id,
  access_token: secret, refresh_token: secret, id_token: secret, earliest_refresh_at: z.union([z.string().max(256), z.number().finite(), z.null()]).optional() }).strict();
export type CompanionCredential = z.infer<typeof CompanionCredentialSchema>;
export const SnapshotSchema = z.object({ version: z.literal(1), pairingId: id, sourceHostId: id, clientId: id, subject: id,
  exchangeId: z.string().uuid(), credentialDigest: digest, receivedAt: time, expiresAt: time,
  scopes: z.array(id).min(1).max(32), validation: z.enum(['authorization_code', 'refresh_token']) }).strict();
export type SourceSnapshot = z.infer<typeof SnapshotSchema>;
export const TicketSchema = z.object({ version: z.literal(1), pairingId: id, transferId: z.string().uuid(), ownerId: id, sessionVersion: z.number().int().nonnegative(),
  sourceHostId: id, destinationHostId: id, transportId: id, clientId: id, subject: id, snapshotDigest: digest,
  credentialDigest: digest, pairingDigest: digest, createdAt: time, expiresAt: time }).strict();
export type CompanionTicket = z.infer<typeof TicketSchema>;
export const CustodySchema = z.object({ version: z.literal(1), ticketDigest: digest, snapshotDigest: digest, credentialDigest: digest,
  journalRevision: z.number().int().positive().safe(), suspendedAt: time, refreshOwner: z.literal('collective_vm') }).strict();
export const AckSchema = z.object({ version: z.literal(1), ticketDigest: digest, custodyDigest: digest,
  state: z.enum(['complete', 'pending', 'cancelled', 'needs_attention']), at: time }).strict();
export type Signed<T> = { body: T; signature: string };
export function signedSchema<T extends z.ZodType>(body: T) { return z.object({ body, signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) }).strict(); }
export const EnvelopeSchema = z.object({ version: z.literal(1), pairingId: id, transferId: z.string().uuid(), ticketDigest: digest,
  ephemeralKey: z.string().max(256), iv: z.string().regex(/^[A-Za-z0-9_-]{16}$/), ciphertext: z.string().min(1).max(100000),
  tag: z.string().regex(/^[A-Za-z0-9_-]{22}$/), signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) }).strict();
export type CompanionEnvelope = z.infer<typeof EnvelopeSchema>;
export const PayloadSchema = z.object({ file: CompanionCredentialSchema, snapshot: signedSchema(SnapshotSchema), custody: signedSchema(CustodySchema) }).strict();
export type CompanionPayload = z.infer<typeof PayloadSchema>;

/** Canonical application transcript; a digest alone is not authenticated evidence. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  if (value === undefined) throw companionFailure();
  return JSON.stringify(value);
}
export const transcriptDigest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
// Kept byte-identical to the existing importer digest; schema order normalizes optional fields.
export const credentialDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(CompanionCredentialSchema.parse(value))).digest('hex');
function key(value: string, kind: 'ed25519' | 'x25519', privateKey = false) {
  const result = privateKey ? createPrivateKey(value) : createPublicKey(value);
  if (result.asymmetricKeyType !== kind) throw companionFailure();
  return result;
}
export function signTranscript<T>(body: T, privateKey: string): Signed<T> {
  return { body, signature: sign(null, Buffer.from(canonical(body)), key(privateKey, 'ed25519', true)).toString('base64url') };
}
export function verifyTranscript<T>(value: Signed<T>, publicKey: string): T {
  try { if (!verify(null, Buffer.from(canonical(value.body)), key(publicKey, 'ed25519'), Buffer.from(value.signature, 'base64url'))) throw companionFailure(); return value.body; }
  catch { throw companionFailure(); }
}
export function samePublicKey(privateKey: string, publicKey: string) {
  return createPublicKey(createPrivateKey(privateKey)).export({ format: 'der', type: 'spki' }).equals(createPublicKey(publicKey).export({ format: 'der', type: 'spki' }));
}
function encryptionKey(shared: Buffer, header: unknown) { return createHash('sha256').update('CollectiveUI SIWC transfer v1\0').update(shared).update(canonical(header)).digest(); }
export function sealCompanionPayload(payload: CompanionPayload, ticket: CompanionTicket, receiverKey: string, sourceSigningKey: string): CompanionEnvelope {
  const ephemeral = generateKeyPairSync('x25519');
  const header = { version: 1 as const, pairingId: ticket.pairingId, transferId: ticket.transferId, ticketDigest: transcriptDigest(ticket),
    ephemeralKey: ephemeral.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'), iv: randomBytes(12).toString('base64url') };
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: key(receiverKey, 'x25519') });
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(shared, header), Buffer.from(header.iv, 'base64url'));
  cipher.setAAD(Buffer.from(canonical(header)));
  const body = { ...header, ciphertext: Buffer.concat([cipher.update(canonical(payload)), cipher.final()]).toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
  return { ...body, signature: signTranscript(body, sourceSigningKey).signature };
}
export function openCompanionPayload(raw: unknown, receiverKey: string, sourceKey: string): CompanionPayload {
  try {
    const envelope = EnvelopeSchema.parse(raw), { signature, ciphertext, tag, ...header } = envelope;
    verifyTranscript({ body: { ...header, ciphertext, tag }, signature }, sourceKey);
    const peer = createPublicKey({ key: Buffer.from(header.ephemeralKey, 'base64url'), format: 'der', type: 'spki' });
    if (peer.asymmetricKeyType !== 'x25519') throw companionFailure();
    const shared = diffieHellman({ privateKey: key(receiverKey, 'x25519', true), publicKey: peer });
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(shared, header), Buffer.from(header.iv, 'base64url'));
    decipher.setAAD(Buffer.from(canonical(header))); decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    const plain = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]);
    if (plain.length > 64000) throw companionFailure();
    return PayloadSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain)));
  } catch { throw companionFailure(); }
}
