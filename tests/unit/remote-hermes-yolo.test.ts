import { beforeEach, describe, expect, it, vi } from 'vitest';
import contract from '../fixtures/remote-hermes-command-contract.json';
import { sessionYoloCompatible, yoloStatusText } from '@/lib/remote-hermes/yolo-contract';
import { decrypt, encrypt } from '@/lib/crypto';
import { NativeRpcError, NativeConnectionChanged } from '@/lib/remote-hermes/socket';
const f = vi.hoisted(() => ({ enabled: true, gate: true, locks: 0, disableAt: 0, gateAt: 0, runAt: 0, rotateAt: 0, epoch: 1, epochAt: 0, beforeSend: false, profiles: vi.fn(), call: vi.fn(), refresh: vi.fn(), receipt: null as null | { digest: string }, row: {} as Record<string, unknown>, cached: {} as { row: Record<string, unknown>; view: Record<string, unknown>; pending: Map<string, unknown>; socketEpoch: number } }));
vi.mock('@/lib/settings', () => ({ getSetting: async () => ({ enabled: f.enabled, allowSessionYolo: f.gate, privateGateways: [] }) }));
vi.mock('@/lib/remote-hermes/sessions', () => ({ ownedNativeSession: async (owner: string, connection: string, session: string) => { if (owner !== 'owner' || connection !== 'connection' || session !== 'session') throw new Error('not found'); return f.row; } }));
vi.mock('@/lib/remote-hermes/store', () => ({ remoteAccess: async () => ({ client: { profiles: f.profiles } }) }));
vi.mock('@/lib/remote-hermes/hub', () => ({ nativeHub: () => ({ socket: { get connectionEpoch() { return f.epoch; }, state: 'connected', callConnected: (method: string, params: unknown, epoch: number) => { if (f.beforeSend || epoch !== f.epoch) throw new NativeConnectionChanged(); return f.call(method, params); } }, refresh: f.refresh, sessions: new Map([['session', f.cached]]) }) }));
vi.mock('@/db', () => {
  const update = (values: Record<string, unknown>) => ({ where: () => ({ returning: async () => { f.row = { ...f.row, ...values, revision: Number(f.row.revision) + 1 }; return [f.row]; } }) });
  return { db: { update: () => ({ set: update }), transaction: async (run: (tx: unknown) => unknown) => run({
    select: () => ({ from: (table: { [key: symbol]: unknown }) => {
      const name = table[Symbol.for('drizzle:Name')];
      return { where: () => {
        const rows = () => name === 'settings' ? [] : name === 'remote_hermes_turns' ? f.receipt ? [f.receipt] : [] : [f.row];
        return Object.assign(Promise.resolve().then(rows), { for: async () => { if (name === 'settings') { ++f.locks; if (f.locks === f.disableAt) f.enabled = false; if (f.locks === f.gateAt) f.gate = false; if (f.locks === f.runAt) f.cached.view.running = true; if (f.locks === f.rotateAt) f.cached.row = { ...f.cached.row, storedId: 'new-native-conversation' }; if (f.locks === f.epochAt) ++f.epoch; } return rows(); } });
      } };
    } }), insert: () => ({ values: async (value: { digest: string }) => { f.receipt = { digest: value.digest }; } }), update: () => ({ set: update }),
  }) } };
});
import { nativeSessionYolo, yoloInput } from '@/lib/remote-hermes/yolo';
const prepare = async (value: 'on' | 'off' = 'on') => {
  const result = await nativeSessionYolo('owner', 'connection', 'session', { operation: 'prepare', value });
  if (!('confirmation' in result)) throw new Error('Expected a confirmation without dispatch.');
  return result;
};
const confirm = (confirmation: string) => nativeSessionYolo('owner', 'connection', 'session', { operation: 'confirm', confirmation });
const binding = JSON.stringify(['remote-hermes-session-yolo:v1', 'owner', 'connection', 'session']);
describe('confirmed native session YOLO', () => {
  beforeEach(() => {
    vi.restoreAllMocks(); vi.clearAllMocks(); f.enabled = f.gate = true; f.locks = f.disableAt = f.gateAt = f.runAt = f.rotateAt = f.epochAt = 0; f.receipt = null; f.epoch = 1; f.beforeSend = false;
    f.row = { id: 'session', connectionId: 'connection', profile: 'default', storedId: 'stored', runtimeId: 'runtime', status: 'idle', revision: 1, queueRequestId: null };
    f.cached = { row: f.row, view: { title: 'Fixture chat', profile: 'default', nativeProfile: 'default', runtimeVersion: '0.21.5', desktopContract: 8, running: false, uncertain: false, queuePending: false, queued: '', prompts: [], yolo: false, approvalMode: 'manual' }, pending: new Map(), socketEpoch: 1 };
    f.profiles.mockResolvedValue([{ name: 'default' }]); f.refresh.mockImplementation(async () => f.cached.view);
    f.call.mockImplementation(async (_method, params) => { f.cached.view.yolo = params.value === 'on'; return { key: 'yolo', scope: 'session', value: params.value === 'on' ? '1' : '0' }; });
  });
  it('uses executed pinned source contracts for explicit session changes and stale rejection', () => {
    expect(contract.yolo.on.result).toEqual({ key: 'yolo', value: '1', scope: 'session' });
    expect(contract.yolo.off.result).toEqual({ key: 'yolo', value: '0', scope: 'session' });
    expect(contract.yolo.stale.error.code).toBe(4001); expect(contract.yolo.profile_writes).toEqual([]); expect(contract.yolo.process_environment).toEqual({}); expect(contract.yolo.status_mutates).toBe(true);
  });
  it.each(['on', 'off'] as const)('prepares without mutation and confirms explicit %s with server-owned scope and identities', async value => {
    const p = await prepare(value); expect(p).toMatchObject({ value, profile: 'default', effectiveBypass: false }); expect(f.call).not.toHaveBeenCalled(); expect(f.receipt).toBeNull();
    const result = await confirm(p.confirmation!); expect(result).toMatchObject({ accepted: true, sessionValue: value, effectiveBypass: value === 'on' });
    expect(f.call).toHaveBeenCalledExactlyOnceWith('config.set', { profile: 'default', session_id: 'runtime', scope: 'session', key: 'yolo', value }); expect(f.row.status).toBe('idle');
    expect(await confirm(p.confirmation!)).toMatchObject({ duplicate: true }); expect(f.call).toHaveBeenCalledOnce();
  });
  it('keeps inherited effective bypass visible after clearing only the session flag', async () => {
    const p = await prepare('off'); f.cached.view.approvalMode = 'off'; f.call.mockImplementation(async () => { f.cached.view.yolo = true; return contract.yolo.off.result; });
    const result = await confirm(p.confirmation!); expect(result).toMatchObject({ effectiveBypass: true, sessionValue: 'off', output: expect.stringContaining('Bypass remains active') });
    expect(yoloStatusText({ yolo: true, approvalMode: 'manual' }, 'off')).toContain('profile/process policy');
  });
  it('denies other owners and client-selected scopes/keys before RPC', async () => {
    await expect(nativeSessionYolo('intruder', 'connection', 'session', { operation: 'prepare', value: 'on' })).rejects.toThrow('not found');
    for (const input of [{ operation: 'prepare', value: 'toggle' }, { operation: 'prepare', value: 'status' }, { operation: 'prepare', value: 'on', scope: 'global' }, { operation: 'confirm', value: 'on' }]) expect(yoloInput.safeParse(input).success).toBe(false);
    expect(f.refresh).not.toHaveBeenCalled(); expect(f.call).not.toHaveBeenCalled();
  });
  it.each(['gate', 'enabled'] as const)('denies disabled %s at preparation and final dispatch', async key => {
    f[key] = false; await expect(prepare()).rejects.toThrow('disabled'); f[key] = true; const p = await prepare(); f.locks = 0; if (key === 'gate') f.gateAt = 2; else f.disableAt = 2;
    await expect(confirm(p.confirmation!)).rejects.toThrow('disabled'); expect(f.receipt).not.toBeNull(); expect(f.call).not.toHaveBeenCalled(); expect(f.row.status).toBe('idle');
  });
  it.each(['0.21.4', '0.21.6', 'unknown', '0.21.5+custom'])('withholds mutation for unverified runtime %s without probing setters', async version => {
    f.cached.view.runtimeVersion = version; await expect(prepare()).rejects.toThrow('verified Hermes'); expect(f.call).not.toHaveBeenCalled();
  });
  it('requires matching native profile and the exact checked desktop contract', async () => {
    f.cached.view.nativeProfile = 'another-profile'; await expect(prepare()).rejects.toThrow('matching profile');
    f.cached.view.nativeProfile = 'default'; f.cached.view.desktopContract = 7; await expect(prepare()).rejects.toThrow('verified Hermes');
    expect(sessionYoloCompatible({ profile: 'default', nativeProfile: 'default', runtimeVersion: '0.21.5', desktopContract: 9 })).toBe(false);
  });
  it.each(['running', 'uncertain', 'queuePending', 'queued', 'prompts', 'pending', 'rowStatus', 'queueRequestId'])('refuses %s before confirmation issuance', async state => {
    if (state === 'pending') f.cached.pending.set('prompt', {}); else if (state === 'rowStatus') f.row.status = 'waiting'; else if (state === 'queueRequestId') f.row.queueRequestId = 'queue'; else f.cached.view[state] = state === 'prompts' ? [{}] : state === 'queued' ? 'next' : true;
    await expect(prepare()).rejects.toThrow('Finish pending'); expect(f.call).not.toHaveBeenCalled(); expect(f.receipt).toBeNull();
  });
  it('rejects expired, altered, cross-bound and invalid confirmations', async () => {
    const p = await prepare();
    await expect(confirm(p.confirmation!.slice(0, -5) + 'xxxxx')).rejects.toThrow('invalid or expired');
    const target = JSON.parse(decrypt(p.confirmation!, binding));
    await expect(confirm(encrypt(JSON.stringify(target), binding.replace('owner', 'other')))).rejects.toThrow('invalid or expired');
    vi.spyOn(Date, 'now').mockReturnValue(target.expiresAt + 1); await expect(confirm(p.confirmation!)).rejects.toThrow('expired'); expect(f.call).not.toHaveBeenCalled();
  });
  it.each(['runtimeId', 'storedId', 'profile'] as const)('rejects changed %s after user reviews confirmation', async key => {
    const p = await prepare(); f.row[key] = 'changed'; f.cached.row = f.row;
    await expect(confirm(p.confirmation!)).rejects.toThrow(key === 'profile' ? 'profile not found' : 'changed after confirmation'); expect(f.call).not.toHaveBeenCalled();
  });
  it('rechecks native activity at final dispatch after reserving a durable receipt', async () => {
    const p = await prepare(); f.locks = 0; f.runAt = 2; await expect(confirm(p.confirmation!)).rejects.toThrow('no longer ready'); expect(f.call).not.toHaveBeenCalled(); expect(f.receipt).not.toBeNull();
  });
  it('rejects cached-only native conversation rotation while the final database lock is held', async () => {
    const p = await prepare(); f.locks = 0; f.rotateAt = 2;
    await expect(confirm(p.confirmation!)).rejects.toThrow('changed after confirmation'); expect(f.call).not.toHaveBeenCalled(); expect(f.receipt).not.toBeNull();
  });
  it.each(['snapshot', 'final-lock', 'before-send'])('rejects connection changes at %s without reconnecting a setter', async when => {
    const p = await prepare(); f.locks = 0;
    if (when === 'snapshot') ++f.epoch; else if (when === 'final-lock') f.epochAt = 2; else f.beforeSend = true;
    await expect(confirm(p.confirmation!)).rejects.toThrow('verified Hermes connection changed'); expect(f.call).not.toHaveBeenCalled(); expect(f.row.status).toBe('idle');
  });
  it.each([-32601, 4001])('settles definitive RPC rejection %s without fallback or replay', async code => {
    const p = await prepare(); f.call.mockRejectedValue(new NativeRpcError(code)); await expect(confirm(p.confirmation!)).rejects.toThrow(); expect(f.row.status).toBe('idle'); await confirm(p.confirmation!); expect(f.call).toHaveBeenCalledOnce();
  });
  it.each(['lost', 'bad-result'])('retains uncertain %s outcomes and never replays the confirmation', async failure => {
    const p = await prepare(); if (failure === 'lost') f.call.mockRejectedValue(new Error('lost acknowledgement')); else f.call.mockResolvedValue({ key: 'yolo', value: '1', scope: 'global' });
    await expect(confirm(p.confirmation!)).rejects.toThrow(); expect(f.row.status).toBe('uncertain'); expect(f.cached.view.uncertain).toBe(true);
    expect(await confirm(p.confirmation!)).toMatchObject({ duplicate: true }); expect(f.call).toHaveBeenCalledOnce(); await expect(prepare()).rejects.toThrow('Uncertain');
  });
});
