import { z } from 'zod';
import { ownerId } from './contracts';

export const AdminTemplateReference = z.string().max(512).regex(/^[a-z0-9][a-z0-9./_-]*@sha256:[a-f0-9]{64}$/);
const label = z.string().trim().min(1).max(100).refine(value => !/[\x00-\x1f\x7f]/.test(value));
export const NetworkDestination = z.string().trim().toLowerCase().max(253).regex(/^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?$/)
  .refine(value => !value.includes('..') && (!value.includes(':') || Number(value.split(':').at(-1)) >= 1 && Number(value.split(':').at(-1)) <= 65535), 'Enter a hostname or IPv4 address, optionally with a port.');
export const ValidationId = z.enum(['sbx', 'desktop', 'containment', 'inference']);
const revision = z.number().int().nonnegative();
export const SandboxAdminAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('settings'), revision, cpus: z.number().int().min(1).max(64), memoryMb: z.number().int().min(512).max(65536), maxRunning: z.number().int().min(1).max(1000), defaultTemplate: AdminTemplateReference }).strict(),
  z.object({ action: z.literal('enrollment'), revision, ownerId, admitted: z.boolean() }).strict(),
  z.object({ action: z.literal('lifecycle'), ownerId, operation: z.enum(['provision', 'start', 'stop', 'delete']), confirmation: z.literal('DELETE').optional() }).strict(),
  z.object({ action: z.literal('template-add'), revision, reference: AdminTemplateReference, label }).strict(),
  z.object({ action: z.literal('template-remove'), revision, reference: AdminTemplateReference }).strict(),
  z.object({ action: z.literal('template-import'), revision, archive: z.string().max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.tar$/), reference: AdminTemplateReference }).strict(),
  z.object({ action: z.literal('network-add'), ownerId, effect: z.enum(['allow', 'deny']), destination: NetworkDestination }).strict(),
  z.object({ action: z.literal('network-remove'), ownerId, ruleId: z.string().uuid() }).strict(),
  z.object({ action: z.literal('network-check'), ownerId, destination: NetworkDestination }).strict(),
  z.object({ action: z.literal('network-read'), ownerId }).strict(),
  z.object({ action: z.literal('diagnose') }).strict(),
  z.object({ action: z.literal('validation'), revision, id: ValidationId, result: z.enum(['passed', 'failed', 'pending']), reference: z.string().trim().max(300).refine(value => !/[\x00-\x1f\x7f]/.test(value)) }).strict(),
]);
export type SandboxAdminAction = z.infer<typeof SandboxAdminAction>;

export type AdminCheck = { id: string; label: string; state: 'passed' | 'failed' | 'unknown'; detail: string };
export type AdminTemplate = { reference: string; label: string; available: boolean | null; inUse: number };
export type AdminValidation = { id: z.infer<typeof ValidationId>; result: 'passed' | 'failed' | 'pending'; reference: string; checkedAt: string | null; checkedBy: string | null; template: string; source: 'operator' };
export type AdminNetworkRule = { id: string; ownerId: string; effect: 'allow' | 'deny'; destination: string; createdAt: string };
export type AdminNetwork = { ownerId: string; rules: AdminNetworkRule[]; observed: boolean; note: string; eventsObserved: boolean; events: { at: string | null; destination: string; decision: 'allowed' | 'denied' | 'unknown' }[] };
export type AdminRuntime = {
  ownerId: string; admitted: boolean; state: 'running' | 'stopped' | 'missing' | 'unavailable';
  cpus: number; memoryMb: number; template: string; activeSessions: number | null;
  credentialState: 'synchronized' | 'sync_required' | 'operator_unverified';
  computer: { available: boolean; paused: boolean; control: 'agent' | 'human' | 'paused' | 'unavailable'; lastFrameAt: string | null };
};
export type SandboxAdminSnapshot = {
  available: boolean; reason: string | null; checkedAt: string; backend: 'sbx' | 'docker' | 'unconfigured';
  version: string | null; checks: AdminCheck[];
  settings: { revision: number; cpus: number; memoryMb: number; maxRunning: number; defaultTemplate: string; admittedOwners: string[] };
  runtimes: AdminRuntime[]; templates: AdminTemplate[];
  archives: { name: string; sizeBytes: number }[];
  validation: AdminValidation[]; siwcSandboxVerified: boolean;
};
export type SandboxAdminResult = {
  message: string;
  network?: AdminNetwork;
  networkCheck?: { destination: string; decision: 'allowed' | 'denied' | 'unknown'; detail: string };
  diagnostics?: { checkedAt: string; checks: AdminCheck[]; source: 'host'; liveComputerUseVerified: false };
};
export type SandboxAdminPageData = SandboxAdminSnapshot & {
  people: { id: string; name: string; email: string; disabled: boolean }[];
};

/** This is a configuration snapshot, never evidence of a live sandbox or authenticated turn. */
export function unavailableAdminSnapshot(reason: string, backend: SandboxAdminSnapshot['backend'] = 'unconfigured'): SandboxAdminSnapshot {
  return { available: false, reason, checkedAt: new Date().toISOString(), backend, version: null, checks: [],
    settings: { revision: 0, cpus: 2, memoryMb: 4096, maxRunning: 1, defaultTemplate: '', admittedOwners: [] },
    runtimes: [], templates: [], archives: [], validation: [], siwcSandboxVerified: false };
}
