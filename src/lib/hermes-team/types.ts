import { z } from 'zod';
import { TeamModelPolicyModeSchema, TeamModelPolicySchema } from './model-policy';
import { TeamToolPolicySchema } from './tool-policy';
export const teamMode = z.enum(['member', 'admin']);
export type TeamMode = z.infer<typeof teamMode>;
export const teamModelMode = TeamModelPolicyModeSchema;
export type TeamModelMode = z.infer<typeof teamModelMode>;
export type TeamProfileState = 'preparing' | 'connection_needed' | 'ready' | 'updating' | 'needs_attention' | 'revoked';
export type { TeamModelPolicy } from './model-policy';
export type { TeamToolPolicy } from './tool-policy';
export const teamConfiguration = z.object({
  modelPolicy: TeamModelPolicySchema,
  // Older editors omit tools. An omission preserves saved policy instead of granting or clearing capabilities.
  toolPolicy: TeamToolPolicySchema.optional(),
  maintainerIds: z.array(z.string().min(1).max(100)).min(1).max(100),
  enabled: z.boolean(),
  expectedVersion: z.number().int().min(0),
}).strict();
export type TeamChatStatus = { enabled: boolean; mode: TeamMode; canMaintain: boolean; state: TeamProfileState; installedRevision: number | null; publishedRevision: number; conflictCount: number; modelAccessAvailable?: boolean; modelAccessReason?: string };
/** Rollout views contain counts and hashes, never members' private resource contents. */
export type TeamRollout = { profileId: string; state: TeamProfileState; installedRevision: number | null; conflictCount: number };
