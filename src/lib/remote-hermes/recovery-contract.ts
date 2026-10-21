import { z } from 'zod';

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonnegative = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const id = z.string().min(1).max(200);
/** Persisted intent data contains identities and counters only, never prompts or credentials. */
export const recoveryOwnership = z.object({
  protocol: z.literal('collective.portal-hub-ownership.v1'), ownerId: id, connectionId: id, instanceId: id,
  leaseGeneration: positive, sessionId: id, profile: z.string().min(1).max(100), storedId: id, runtimeId: id,
  sessionRevision: nonnegative, ownershipGeneration: nonnegative, socketEpoch: positive, portalSocketEpoch: positive,
  nativeFence: z.object({ protocol: z.literal('collective.native-hub-owner.v1'), generation: positive, socketEpoch: positive, nativeGeneration: positive, phase: z.enum(['recovery', 'full']), recoveryId: z.string().uuid().nullable(), recoverySessionId: id.nullable(), recoveryStoredSessionId: id.nullable() }).strict().nullable(),
}).strict();
export const recoveryBinding = z.object({
  ownership: recoveryOwnership,
  connectionDigest: z.string().regex(/^[a-f0-9]{64}$/),
  admissionRequestId: id.nullable(), queueRequestId: id.nullable(),
  status: z.enum(['idle', 'admitting', 'uncertain', 'running', 'waiting']),
  queueStatus: z.enum(['admitting', 'queued', 'uncertain']).nullable(),
}).strict();
export type RecoveryBinding = z.infer<typeof recoveryBinding>;
export const recoveryInput = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('prepare'), sessionId: id }).strict(),
  z.object({ operation: z.literal('confirm'), sessionId: id, intentId: z.string().uuid(), confirmed: z.literal(true) }).strict(),
  z.object({ operation: z.literal('check'), sessionId: id, intentId: z.string().uuid() }).strict(),
]);
export type RecoveryView = { intentId: string; state: 'prepared' | 'pending' | 'uncertain' | 'applied'; expiresAt: number; reservationCount: number; profile: string };
