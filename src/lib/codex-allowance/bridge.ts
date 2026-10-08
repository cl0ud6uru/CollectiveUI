import 'server-only';
import { z } from 'zod';
import type { Principal } from '@/lib/auth/groups';
import { HttpError } from '@/lib/authz';
import type { CodexAllowanceView, QuotaWindow } from './contracts';
import { normalizeQuota } from './normalize';

/** Trusted runtime broker only. No browser URLs, credentials, OAuth reuse, shell commands or ingestion endpoint. */
export type CodexAllowanceRuntime = {
  ownerId: string; connectionId: string; label: string;
  /** Re-check runtime ownership, session revocation, connection/auth epoch and availability on EVERY read. */
  authorize: (p: Principal) => Promise<boolean>;
  request: (method: 'account/read' | 'account/rateLimits/read') => Promise<unknown>;
  subscribe: (listener: (method: string, params: unknown) => void) => () => void;
};
type Entry = { runtime: CodexAllowanceRuntime; windows: QuotaWindow[]; lastReadAt: string | null; lastAttemptAt: number; epoch: number; quotaVersion: number; error: boolean; needsAuth: boolean; unsubscribe: () => void };
const runtimes = new Map<string, Entry>();
const enabled = () => process.env.CODEX_ALLOWANCE_BRIDGE_ENABLED === '1';
const base = (state: CodexAllowanceView['state'], message: string | null): CodexAllowanceView => ({ state, message, runtimeLabel: null, source: 'codex_app_server', windows: [], lastReadAt: null });
/** Registration remains disabled until an operator wires an isolated authenticated app-server transport. */
export function registerCodexAllowanceRuntime(runtime: CodexAllowanceRuntime) {
  if (!enabled()) throw new Error('Codex allowance bridge is disabled');
  if (!runtime.ownerId || !runtime.connectionId || runtime.label.length > 80 || !runtime.label) throw new Error('Invalid runtime binding');
  const prior = runtimes.get(runtime.ownerId); prior?.unsubscribe();
  const entry: Entry = { runtime, windows: [], lastReadAt: null, lastAttemptAt: 0, epoch: 0, quotaVersion: 0, error: false, needsAuth: false, unsubscribe: () => {} };
  runtimes.set(runtime.ownerId, entry);
  entry.unsubscribe = runtime.subscribe((method, params) => {
    if (!enabled() || runtimes.get(runtime.ownerId) !== entry) return;
    if (method === 'account/updated') { ++entry.epoch; entry.windows = []; entry.lastReadAt = null; entry.needsAuth = true; return; }
    // Ignore quotas until an authenticated ChatGPT account/read and full rateLimits/read succeed.
    if (method !== 'account/rateLimits/updated' || !entry.lastReadAt) return;
    try { entry.windows = normalizeQuota(params, entry.windows, 'account/rateLimits/updated', new Date()); ++entry.quotaVersion; }
    catch { entry.error = true; }
  });
  return () => { entry.unsubscribe(); if (runtimes.get(runtime.ownerId) === entry) runtimes.delete(runtime.ownerId); };
}
async function timeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Runtime timeout')), 10_000); })]); }
  finally { clearTimeout(timer); }
}
const Account = z.object({ account: z.object({ type: z.string() }).nullable() });
/** Derives owner from the authenticated principal; even admins cannot read another owner's cache. */
export async function readCodexAllowance(p: Principal, refresh = false, now = new Date()): Promise<CodexAllowanceView> {
  if (!enabled()) return base('disabled', 'A supported per-user Codex runtime connection has not been enabled.');
  const entry = runtimes.get(p.user.id);
  if (!entry) return base('unavailable', 'No supported authenticated Codex app-server is connected for your account.');
  let authorized = false;
  try { authorized = await timeout(entry.runtime.authorize(p)); } catch { /* no transport errors or secrets are logged */ }
  if (!authorized || !enabled() || runtimes.get(p.user.id) !== entry || entry.runtime.ownerId !== p.user.id) return base('unavailable', 'The owned runtime connection is unavailable.');
  const epoch = entry.epoch; const quotaVersion = entry.quotaVersion;
  if (refresh) {
    if (now.getTime() - entry.lastAttemptAt < 30_000) throw new HttpError(429, 'Wait 30 seconds before refreshing allowance again.');
    entry.lastAttemptAt = now.getTime();
    try {
      const account = Account.parse(await timeout(entry.runtime.request('account/read')));
      if (account.account?.type !== 'chatgpt') { ++entry.epoch; entry.windows = []; entry.lastReadAt = null; entry.needsAuth = true; return base('needs_auth', 'This runtime does not report an authenticated ChatGPT subscription account.'); }
      const result = await timeout(entry.runtime.request('account/rateLimits/read'));
      const windows = normalizeQuota(result, [], 'account/rateLimits/read', now);
      if (!enabled() || runtimes.get(p.user.id) !== entry || entry.epoch !== epoch || !await timeout(entry.runtime.authorize(p))) return base('unavailable', 'The runtime connection changed during refresh.');
      // A notification observed during this read is newer evidence; a late read must not overwrite it.
      if (entry.quotaVersion === quotaVersion) { entry.windows = windows; entry.lastReadAt = now.toISOString(); }
      entry.error = false; entry.needsAuth = false;
    } catch { entry.error = true; }
  }
  // Recheck after I/O and do not publish a cache retired by a connection/account change.
  if (!enabled() || runtimes.get(p.user.id) !== entry || entry.epoch !== epoch) return base('unavailable', 'The runtime connection changed.');
  return { state: entry.needsAuth ? 'needs_auth' : entry.error ? 'error' : 'ready', runtimeLabel: entry.runtime.label, source: 'codex_app_server',
    windows: entry.windows.map(w => ({ ...w, usedPercent: { ...w.usedPercent }, windowDurationMins: { ...w.windowDurationMins }, resetsAt: { ...w.resetsAt } })),
    lastReadAt: entry.lastReadAt, message: entry.error ? 'Allowance refresh or notification failed. Last observed windows retain their original timestamps.' : null };
}
