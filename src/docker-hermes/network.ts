import { z } from 'zod';
import { providerId } from './settings';

export const networkMode = z.enum(['none', 'internet', 'proxy']);
export type NetworkMode = z.infer<typeof networkMode>;
export const networkRequest = z.object({
  mode: networkMode, revision: z.number().int().nonnegative(), requestId: z.string().uuid(),
  confirmRestart: z.literal(true),
}).strict();
export type NetworkRequest = z.infer<typeof networkRequest>;
export const networkReceipt = z.object({
  requestId: z.string().uuid(), previous: networkMode, requested: networkMode,
  state: z.enum(['pending', 'applied', 'committed', 'rolled_back', 'failed']),
  checkedAt: z.string(), actor: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
  wasRunning: z.boolean(),
  revision: z.number().int().nonnegative(),
}).strict();
export type NetworkReceipt = z.infer<typeof networkReceipt>;
// Private recovery information never appears in an Admin status response.
export const networkMigration = networkReceipt.extend({
  originalId: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  replacementId: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  snapshotReady: z.boolean(),
  profiles: z.array(z.object({ name: z.string(), identity: z.string() }).strict()),
}).strict();
export type NetworkMigration = z.infer<typeof networkMigration>;
export const connectivityCode = z.enum(['reachable', 'offline', 'dns_failed', 'tls_failed', 'proxy_blocked', 'unavailable']);
export const connectivity = z.object({
  code: connectivityCode, provider: providerId, checkedAt: z.string(), revision: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type Connectivity = z.infer<typeof connectivity>;
export type NetworkStatus = {
  mode: NetworkMode; onlineMode: 'internet' | 'proxy'; actual: NetworkMode | 'absent' | 'unknown'; running: boolean | null;
  revision: number; changing: boolean; receipt: NetworkReceipt | null; error: string | null;
};
export const networkLabels: Record<NetworkMode, string> = { none: 'Offline', internet: 'Standard Internet', proxy: 'Restricted proxy' };
export const connectivityMessages: Record<Connectivity['code'], string> = {
  reachable: 'Provider TLS connection reached. Sign-in and model access still need verification.',
  offline: 'Internet access is off. An administrator can turn it on in Admin → Managed Hermes.',
  dns_failed: 'Provider DNS could not be resolved. Check the runtime DNS and host connection.',
  tls_failed: 'The provider TLS connection failed. Check certificates, host connectivity and provider availability.',
  proxy_blocked: 'The restricted proxy could not connect. Check its provider allowance or select Standard Internet in Admin → Managed Hermes.',
  unavailable: 'The check could not be confirmed. Reload runtime status before trying again.',
};
