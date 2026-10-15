import { createHash } from 'node:crypto';
import { z } from 'zod';
import { HttpError } from '@/lib/authz';
import { remoteAccess } from './store';
import { dashboardFetch } from './transport';
import { nativeHub } from './hub';
import { record } from './socket';
import { ownedNativeSession, profileName } from './sessions';

export const inspectionQuery = z.object({ panel: z.enum(['projects', 'files', 'schedules', 'plugins', 'system']), profile: profileName, sessionId: z.string().uuid().optional(), workspaceId: z.string().regex(/^[a-f0-9]{32}$/).optional(), action: z.enum(['list', 'read']).optional(), path: z.string().max(1024).optional() }).strict();
const string = (v: unknown, max = 300) => typeof v === 'string' ? v.slice(0, max) : '';
const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
const rows = (v: unknown) => Array.isArray(v) ? v.slice(0, 500).map(record) : [];
function validDirectory(value: string) {
  return value.startsWith('/') && !/[\\\x00-\x1f\x7f]/.test(value) && !value.split('/').some(s => s === '..' || s.startsWith('.') || /^(?:credentials?(?:\..*)?|secrets?(?:\..*)?|vault(?:\..*)?|config\.ya?ml|auth\.(?:json|ya?ml)|id_(?:rsa|ed25519)(?:\..*)?)$/i.test(s));
}
export function projectProjection(value: unknown) {
  const result = record(value);
  return { activeId: string(result.active_id), projects: rows(result.projects).map(p => ({ id: string(p.id), slug: string(p.slug, 200), name: string(p.name), archived: p.archived === true, folders: rows(p.folders).map(f => ({ path: string(f.path, 2048), primary: f.is_primary === true })).filter(f => validDirectory(f.path)) })) };
}
export function scheduleProjection(value: unknown) {
  return { schedules: rows(Array.isArray(value) ? value : record(value).jobs).map(p => ({ id: string(p.id ?? p.job_id), name: string(p.name), enabled: p.enabled !== false && p.paused !== true, state: string(p.state, 100), schedule: string(typeof p.schedule === 'string' ? p.schedule : record(p.schedule).display), nextRun: string(p.next_run_at ?? p.next_run), lastStatus: string(p.last_status) })) };
}
export function pluginProjection(value: unknown) {
  return { plugins: rows(record(value).plugins).map(p => ({ name: string(p.name), version: string(p.version), status: string(p.status) || (p.enabled === true ? 'enabled' : p.enabled === false ? 'disabled' : 'unknown'), source: string(p.source) })) };
}
export function systemProjection(value: unknown) {
  const p = record(value);
  const resource = (v: unknown) => { const r = record(v); return { total: number(r.total), used: number(r.used), percent: number(r.percent) }; };
  return { version: string(p.hermes_version), architecture: string(p.arch), cpuCount: number(p.cpu_count), cpuPercent: number(p.cpu_percent), uptimeSeconds: number(p.uptime_seconds), memory: resource(p.memory), disk: resource(p.disk) };
}
// Native file names are relative to the server-approved workspace root. Never project absolute paths.
export function workspaceFilesProjection(value: unknown) {
  const p = record(value);
  if (p.protocol !== 'collective.workspace-files.v1') throw new HttpError(501, 'This Hermes version does not support the native workspace files protocol.');
  if (p.available !== true) return { available: false, entries: [] as { name: string; path: string; directory: boolean }[] };
  const workspaceId = string(p.workspace_id, 64), projectName = string(p.project_name, 160);
  if (!/^[a-f0-9]{32}$/.test(workspaceId) || !projectName) throw new HttpError(502, 'Hermes returned an invalid workspace identity.');
  const relativePath = (value: unknown) => {
    if (typeof value !== 'string' || value.length > 1024 || value.startsWith('/') || value.includes('\\') || /[\x00-\x1f\x7f]/.test(value)) return false;
    return value === '.' || value.split('/').every(part => !!part && part !== '.' && part !== '..' && !part.startsWith('.') && !/(?:secret|credential|token|vault)/i.test(part) && !/^(?:auth\.(?:json|ya?ml)|config\.(?:json|ya?ml)|id_(?:rsa|ed25519)(?:\..*)?|.*\.(?:pem|p12|pfx|key))$/i.test(part));
  };
  const path = string(p.path, 1024);
  if (!relativePath(path)) throw new HttpError(502, 'Hermes returned an invalid workspace path.');
  const entries = (Array.isArray(p.entries) ? p.entries.slice(0, 100) : []).map(record).flatMap(e => {
    const name = string(e.name, 255), entryPath = string(e.path, 1024);
    const expectedPath = path === '.' ? name : `${path}/${name}`;
    if (!name || name.includes('/') || name.includes('\\') || /[\x00-\x1f\x7f]/.test(name) || name.startsWith('.') || entryPath !== expectedPath || !relativePath(entryPath)) return [];
    if (e.kind !== 'directory' && e.kind !== 'file') return [];
    return [{ name, path: entryPath, directory: e.kind === 'directory' }];
  });
  if (p.action === 'read') {
    if (typeof p.content !== 'string' || Buffer.byteLength(p.content, 'utf8') > 256 * 1024) throw new HttpError(502, 'Hermes returned an invalid or oversized text file.');
    const sha256 = string(p.sha256, 64);
    if (!/^[a-f0-9]{64}$/.test(sha256) || createHash('sha256').update(p.content, 'utf8').digest('hex') !== sha256)
      throw new HttpError(502, 'Hermes returned an invalid workspace file revision.');
    return { available: true, workspaceId, projectName, action: 'read', path, content: p.content, sha256, entries: [] };
  }
  return { available: true, workspaceId, projectName, action: 'list', path, entries, truncated: p.truncated === true };
}

/** Read native panels through one profile-owned socket; only system metrics use a fixed dashboard route. */
export async function inspectNative(ownerId: string, connectionId: string, raw: unknown) {
  const input = inspectionQuery.parse(raw);
  const access = await remoteAccess(ownerId, connectionId, 'admission');
  if (!(await access.client.profiles()).some(p => p.name === input.profile)) throw new HttpError(404, 'Hermes profile not found.');
  const rpc = (method: 'projects.list' | 'plugins.list' | 'plugins.manage' | 'cron.manage') => nativeHub(ownerId, connectionId).socket.call(method, { profile: input.profile, ...(method === 'plugins.manage' ? { action: 'list' } : method === 'cron.manage' ? { action: 'list', include_disabled: true } : {}) });
  const transport = dashboardFetch(access.baseUrl, access.policy);
  const get = async (endpoint: '/api/fs/default-cwd' | '/api/fs/list' | '/api/system/stats', extra: Record<string, string> = {}) => {
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
  if (input.panel === 'schedules') {
    const value = record(await rpc('cron.manage'));
    if (value.scoped !== input.profile) throw new HttpError(501, 'This Hermes version cannot confirm profile-scoped schedules.');
    return scheduleProjection(value);
  }
  if (input.panel === 'system') return systemProjection(await get('/api/system/stats'));
  if (!input.sessionId) throw new HttpError(409, 'Open a saved native Hermes chat before browsing workspace files.');
  const row = await ownedNativeSession(ownerId, connectionId, input.sessionId);
  if (row.profile !== input.profile) throw new HttpError(403, 'Choose the profile of the selected native chat.');
  const hub = nativeHub(ownerId, connectionId);
  await hub.refresh(row);
  const runtimeId = hub.sessions.get(row.id)?.row.runtimeId;
  if (!runtimeId) throw new HttpError(409, 'Open this native Hermes chat before browsing workspace files.');
  const action = input.action ?? 'list';
  if (action === 'read' && !input.path) throw new HttpError(400, 'Choose a listed workspace file.');
  return workspaceFilesProjection(await hub.socket.call('collective.workspace.files', {
    profile: row.profile, session_id: runtimeId, action,
    ...(input.workspaceId ? { workspace_id: input.workspaceId } : {}),
    ...(input.path ? { path: input.path } : {}),
  }));
}
