import { z } from 'zod';
export const ownerId = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
export const teamBotId = ownerId;
/** Reserved runtime identities are derived by the broker, never accepted as a human actor. */
export const runtimeOwnerId = z.union([ownerId, z.string().regex(/^team-admin:[A-Za-z0-9_-]{1,160}$/)]);
export const teamMode = z.enum(['member', 'admin']);
export const teamModelPolicy = z.enum(['admin_provided', 'admin_default_personal_allowed', 'personal_required']);
export type TeamMode = z.infer<typeof teamMode>;
export type TeamModelPolicy = z.infer<typeof teamModelPolicy>;
export const profileName = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
export const bindingSchema = z.object({ bindingId: z.string().regex(/^[a-f0-9]{32}$/), ownerId: runtimeOwnerId,
  botId: z.string(), appId: z.string(), profile: profileName, identity: z.string(), name: z.string(), runtimeId: z.string(),
  purpose: z.enum(['team-member', 'team-admin']).optional(), teamBotId: teamBotId.optional(), modelPolicy: teamModelPolicy.optional() }).strict().refine(b => {
    if (!b.purpose) return !b.teamBotId && !b.modelPolicy && !b.ownerId.startsWith('team-admin:');
    return !!b.teamBotId && !!b.modelPolicy && /^cui-team-[a-f0-9]{32}$/.test(b.profile) &&
      (b.purpose === 'team-admin' ? b.ownerId === `team-admin:${b.teamBotId}` : !b.ownerId.startsWith('team-admin:'));
  }, 'Invalid Team Bot runtime binding');
export type DockerBinding = z.infer<typeof bindingSchema>;
export type TeamBinding = DockerBinding & { purpose: 'team-member' | 'team-admin'; teamBotId: string; modelPolicy: TeamModelPolicy };
export const teamAuthorization = z.object({ teamBotId, mode: teamMode, modelPolicy: teamModelPolicy }).strict();
export const teamEnsure = z.object({ teamBotId, mode: teamMode, name: z.string().trim().min(1).max(80) }).strict();
export const teamScope = z.object({ teamBotId, mode: teamMode }).strict();
export type TeamGrant = { grantId: string; expiresAt: number };
const safeRelativeResource = z.string().min(1).max(256).refine(value => new TextEncoder().encode(value).length <= 256
  && !/[\\%\x00-\x1f\x7f]/.test(value) && !value.startsWith('/') && !/^[A-Za-z]:/.test(value)
  && value.split('/').length <= 15 && value.split('/').every(segment => !!segment && segment !== '.' && segment !== '..'));
export const teamResourceSelection = z.object({ skillPackages: z.array(safeRelativeResource).max(256).optional(),
  includeRole: z.boolean().optional(), documents: z.array(safeRelativeResource).max(256).optional() }).strict();
export type TeamResourceSelection = z.infer<typeof teamResourceSelection>;
/** Structural IPC contract of the publication engine; the app validates the immutable manifest before persistence. */
export type TeamPublishableSnapshot = { readonly format: 1; readonly manifestHash: string; readonly resources: readonly {
  readonly path: string; readonly kind: 'skill' | 'role' | 'document'; readonly packageId: string; readonly sha256: string;
  readonly encoding: 'utf8' | 'base64'; readonly content: string; readonly size: number;
}[] };
export const phases = ['disabled', 'checking_image', 'creating_storage', 'starting_container', 'checking_native', 'pairing', 'ready', 'stopping', 'stopped', 'error', 'interrupted'] as const;
export type DockerStatus = { network: import('./network').NetworkMode; phase: typeof phases[number]; error: string | null; generation: number; bindings: DockerBinding[]; unlinked: { name: string; identity: string }[] };
export type NativeResources = { skills: { id: string; name: string; content: string }[]; memories: { id: string; content: string }[] };
