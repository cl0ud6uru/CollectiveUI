import path from 'node:path';
import { z } from 'zod';
import { HttpError } from '@/lib/authz';
import { remoteAccess } from './store';
import { dashboardFetch } from './transport';
import { nativeHub } from './hub';
import { record } from './socket';
import { profileName } from './sessions';

export const inspectionQuery = z.object({ panel: z.enum(['projects', 'files', 'schedules', 'plugins', 'system']), profile: profileName, path: z.string().max(2048).optional() }).strict();
const string = (v: unknown, max = 300) => typeof v === 'string' ? v.slice(0, max) : '';
const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
const rows = (v: unknown) => Array.isArray(v) ? v.slice(0, 500).map(record) : [];
export function projectProjection(value: unknown) {
  const result = record(value);
  return { activeId: string(result.active_id), projects: rows(result.projects).map(p => ({ id: string(p.id), name: string(p.name), archived: p.archived === true, folders: rows(p.folders).map(f => ({ path: string(f.path, 2048), primary: f.is_primary === true })).filter(f => validDirectory(f.path)) })) };
}
export function scheduleProjection(value: unknown) {
  return { schedules: rows(Array.isArray(value) ? value : record(value).jobs).map(p => ({ id: string(p.id ?? p.job_id), name: string(p.name), enabled: p.enabled !== false && p.paused !== true, schedule: string(typeof p.schedule === 'string' ? p.schedule : record(p.schedule).display), nextRun: string(p.next_run_at ?? p.next_run), lastStatus: string(p.last_status) })) };
}
export function pluginProjection(value: unknown) {
  return { plugins: rows(record(value).plugins).map(p => ({ name: string(p.name), version: string(p.version), status: string(p.status) || (p.enabled === true ? 'enabled' : p.enabled === false ? 'disabled' : 'unknown'), source: string(p.source) })) };
}
export function systemProjection(value: unknown) {
  const p = record(value);
  const resource = (v: unknown) => { const r = record(v); return { total: number(r.total), used: number(r.used), percent: number(r.percent) }; };
  return { version: string(p.hermes_version), architecture: string(p.arch), cpuCount: number(p.cpu_count), cpuPercent: number(p.cpu_percent), uptimeSeconds: number(p.uptime_seconds), memory: resource(p.memory), disk: resource(p.disk) };
}
// Hidden paths and common credential/config stores never enter directory projections.
export function validDirectory(value: string) {
  return value.startsWith('/') && !/[\\\x00-\x1f\x7f]/.test(value) && !value.split('/').some(s => s === '..' || s.startsWith('.') || /^(?:credentials?|secrets?|vault|config\.ya?ml|auth\.json|id_(?:rsa|ed25519))$/i.test(s));
}
export function directoryProjection(value: unknown, directory: string) {
  const p = record(value);
  if (p.error) throw new HttpError(502, 'Hermes could not list this directory.');
  return rows(p.entries).flatMap(e => {
    const name = string(e.name, 255), candidate = string(e.path, 2048);
    if (!name || name.includes('/') || name === '.' || name === '..' || candidate !== path.posix.join(directory, name) || !validDirectory(candidate)) return [];
    return [{ name, path: candidate, directory: e.isDirectory === true || e.is_directory === true }];
  });
}

/** Only these fixed, read-only dashboard routes are reachable through this service. */
export async function inspectNative(ownerId: string, connectionId: string, raw: unknown) {
  const input = inspectionQuery.parse(raw);
  const access = await remoteAccess(ownerId, connectionId, 'admission');
  if (!(await access.client.profiles()).some(p => p.name === input.profile)) throw new HttpError(404, 'Hermes profile not found.');
  const rpc = (method: 'projects.list' | 'plugins.list' | 'plugins.manage') => nativeHub(ownerId, connectionId).socket.call(method, { profile: input.profile, ...(method === 'plugins.manage' ? { action: 'list' } : {}) });
  const transport = dashboardFetch(access.baseUrl, access.policy);
  const get = async (endpoint: '/api/fs/default-cwd' | '/api/fs/list' | '/api/cron/jobs' | '/api/system/stats', extra: Record<string, string> = {}) => {
    const query = new URLSearchParams({ profile: input.profile, ...extra });
    const headers: Record<string, string> = access.secrets.mode === 'sessionToken' ? { 'X-Hermes-Session-Token': access.secrets.sessionToken! } : { Authorization: `Bearer ${access.secrets.accessToken}` };
    const response = await transport(`${access.baseUrl}${endpoint}?${query}`, { headers, redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) { await response.body?.cancel(); throw new HttpError([404, 405, 501].includes(response.status) ? 501 : response.status === 401 || response.status === 403 ? 401 : 502, [404, 405, 501].includes(response.status) ? 'This Hermes version does not support this panel.' : 'Hermes could not load this panel.'); }
    const reader = response.body?.getReader(); if (!reader) throw new HttpError(502, 'Hermes returned an empty panel.');
    const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 1024 * 1024) throw new HttpError(502, 'This Hermes panel is too large.'); chunks.push(value); }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; } catch { throw new HttpError(502, 'Hermes returned an invalid panel.'); }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  };
  if (input.panel === 'projects') return projectProjection(await rpc('projects.list'));
  if (input.panel === 'plugins') return pluginProjection(await rpc('plugins.manage').catch((e: unknown) => { if (e instanceof HttpError && e.status === 501) return rpc('plugins.list'); throw e; }));
  if (input.panel === 'schedules') return scheduleProjection(await get('/api/cron/jobs'));
  if (input.panel === 'system') return systemProjection(await get('/api/system/stats'));
  const home = record(await get('/api/fs/default-cwd'));
  const projects = projectProjection(await rpc('projects.list').catch((e: unknown) => { if (e instanceof HttpError && e.status === 501) return {}; throw e; }));
  const roots = [...new Set([string(home.cwd, 2048), ...projects.projects.flatMap(p => p.folders.map(f => f.path))].filter(validDirectory).map(p => path.posix.normalize(p)))];
  if (!roots.length) throw new HttpError(409, 'No visible workspace folders are configured in this Hermes profile.');
  const directory = input.path ?? roots[0];
  if (!directory || !validDirectory(directory) || path.posix.normalize(directory) !== directory) throw new HttpError(400, 'Choose a listed workspace directory.');
  const root = roots.filter(r => directory === r || directory.startsWith(r.replace(/\/$/, '') + '/')).sort((a, b) => b.length - a.length)[0];
  if (!root) throw new HttpError(403, 'Choose a directory inside a listed workspace.');
  // Walk each ancestor through native listings. Symlinks and invented directories cannot become browser roots.
  const parts = path.posix.relative(root, directory).split('/').filter(Boolean);
  if (parts.length > 12) throw new HttpError(400, 'This directory is too deep to browse.');
  let current = root;
  for (const part of parts) { const next = path.posix.join(current, part); const entries = directoryProjection(await get('/api/fs/list', { path: current }), current); if (!entries.some(e => e.path === next && e.directory)) throw new HttpError(403, 'Choose a listed workspace directory.'); current = next; }
  return { roots, directory, entries: directoryProjection(await get('/api/fs/list', { path: directory }), directory) };
}
