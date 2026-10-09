import { z } from 'zod';

const identity = z.string().min(1).max(256);
/** Trusted adapter evidence, never a workspace decoded from sub/email or supplied by the browser. */
export const OfficialPlanProvenanceSchema = z.object({
  ownerId: identity, clientId: identity, subject: identity, workspaceId: identity.optional(),
  sourceHostId: identity, destinationHostId: identity, transportId: identity, handoffId: identity,
  refreshOwner: z.literal('collective_vm'),
  verifiedAt: z.number().int().nonnegative().safe(), expiresAt: z.number().int().positive().safe(),
}).strict().refine(value => value.sourceHostId !== value.destinationHostId && value.expiresAt > value.verifiedAt)
  .transform(value => { if (value.workspaceId === undefined) delete value.workspaceId; return value; });
export type OfficialPlanProvenance = z.infer<typeof OfficialPlanProvenanceSchema>;
