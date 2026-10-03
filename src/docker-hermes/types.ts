import { z } from 'zod';
export const ownerId = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
export const profileName = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
export const bindingSchema = z.object({ bindingId: z.string().regex(/^[a-f0-9]{32}$/), ownerId,
  botId: z.string(), appId: z.string(), profile: profileName, identity: z.string(), name: z.string(), runtimeId: z.string() }).strict();
export type DockerBinding = z.infer<typeof bindingSchema>;
export const phases = ['disabled', 'checking_image', 'creating_storage', 'starting_container', 'checking_native', 'pairing', 'ready', 'stopping', 'stopped', 'error', 'interrupted'] as const;
export type DockerStatus = { network: 'none' | 'proxy'; phase: typeof phases[number]; error: string | null; generation: number; bindings: DockerBinding[]; unlinked: { name: string; identity: string }[] };
export type NativeResources = { skills: { id: string; name: string; content: string }[]; memories: { id: string; content: string }[] };
