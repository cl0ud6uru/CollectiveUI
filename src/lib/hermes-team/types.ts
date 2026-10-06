import { z } from 'zod';
export const teamMode = z.enum(['member', 'admin']);
export type TeamMode = z.infer<typeof teamMode>;
export const teamModelMode = z.enum(['admin_provided', 'admin_default_personal_allowed', 'personal_required']);
export type TeamModelMode = z.infer<typeof teamModelMode>;
export type TeamProfileState = 'preparing' | 'connection_needed' | 'ready' | 'updating' | 'needs_attention' | 'revoked';
export type TeamModelPolicy = { mode: TeamModelMode; adminRouteId?: string; personalRouteId?: string };
export type TeamToolPolicy = { capabilities: { capabilityId: string; connectionMode: 'approved_team_connection' | 'member_connection' | 'disabled'; connectionId?: string; adapterId?: string; action?: string; resourceIds: string[]; effect: 'read' | 'write'; requireApproval: boolean }[] };
export const teamConfiguration = z.object({
  modelPolicy: z.object({ mode: teamModelMode, adminRouteId: z.string().min(1).max(100).optional(), personalRouteId: z.string().min(1).max(100).optional() }).strict(),
  maintainerIds: z.array(z.string().min(1).max(100)).min(1).max(100),
  enabled: z.boolean(),
  expectedVersion: z.number().int().min(0),
}).strict();
export type TeamChatStatus = { enabled: boolean; mode: TeamMode; canMaintain: boolean; state: TeamProfileState; installedRevision: number | null; publishedRevision: number; conflictCount: number };
/** Rollout views contain counts and hashes, never members' private resource contents. */
export type TeamRollout = { profileId: string; state: TeamProfileState; installedRevision: number | null; conflictCount: number };
