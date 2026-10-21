import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { remoteHermesConnections, remoteHermesSessions, remoteHermesTurns, users } from '@/db/schema';
import { encrypt } from '@/lib/crypto';
import { newId } from '@/lib/ids';
import type { DashboardSecrets } from '@/lib/remote-hermes/client';
import type { NativeHub } from '@/lib/remote-hermes/hub';
import { remoteConnectionAAD } from '@/lib/remote-hermes/secrets';
import { startPinnedDashboard } from '../fixtures/remote-hermes-dashboard';

const f = vi.hoisted(() => ({ base: '', actor: '', headers: new Headers() }));
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/headers', () => ({ headers: async () => f.headers }));
vi.mock('@/auth', () => ({ auth: async () => f.actor ? { user: { id: f.actor, sessionVersion: 0 } } : null }));
vi.mock('@/lib/settings', () => ({ getSetting: async () => ({ enabled: true, privateGateways: [f.base] }) }));
const enabled = process.env.REMOTE_HERMES_WORKSPACE_GATEWAY === '1';
let db: typeof import('@/db').db, pool: typeof import('@/db').pool;
let DashboardClient: typeof import('@/lib/remote-hermes/client').DashboardClient;
let DashboardSocket: typeof import('@/lib/remote-hermes/socket').DashboardSocket;
let nativeHub: typeof import('@/lib/remote-hermes/hub').nativeHub;
let GET: typeof import('@/app/api/hermes/[connectionId]/operations/route').GET;
let POST: typeof import('@/app/api/hermes/[connectionId]/operations/route').POST;
let fixture: Awaited<ReturnType<typeof startPinnedDashboard>>, secrets: DashboardSecrets;
let owner = '', foreign = '', connection = '';
const sockets: InstanceType<typeof import('@/lib/remote-hermes/socket').DashboardSocket>[] = [];
const portal = 'http://portal.fixture.invalid';
const context = () => ({ params: Promise.resolve({ connectionId: connection }) });
async function control(body: unknown) {
  const response = await fetch(f.base + '/api/__fixture/control', { method: 'POST',
    headers: { Authorization: `Bearer ${secrets.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  expect(response.ok).toBe(true); return response.json();
}
async function createChat() {
  const hub: NativeHub = nativeHub(owner, connection);
  const created = await hub.socket.call('session.create', { profile: 'default', source: 'desktop',
    messages: [{ role: 'user', content: 'Synthetic saved question' }, { role: 'assistant', content: 'Synthetic saved answer' }] });
  const [saved] = await db.insert(remoteHermesSessions).values({ id: newId(), connectionId: connection, profile: 'default',
    storedId: String(created.stored_session_id), runtimeId: String(created.session_id), title: 'Synthetic selection chat' }).returning();
  return { hub, saved };
}
async function readyChat({ hub, saved }: Awaited<ReturnType<typeof createChat>>) {
  // Native create schedules construction after its reply. An idle-looking lazy
  // resume can lack profile proof and still have build/resume workers alive.
  // Wait for the real owner fence before arming no-discovery traps, then hydrate
  // once as ordinary chat setup and retain its reconciled persisted identity.
  const readiness = async () => {
    const native = await control({ plugin_selection_readiness: saved.runtimeId });
    expect(native).toMatchObject({ agent_ready: true, status: 'idle', native_profile: 'default', profile_work: false });
    return native;
  };
  await vi.waitFor(readiness, { timeout: 10_000 });
  expect((await hub.refresh(saved)).running).toBe(false);
  const native = await vi.waitFor(readiness, { timeout: 10_000 });
  const [current] = await db.select().from(remoteHermesSessions).where(eq(remoteHermesSessions.id, saved.id));
  const cached = hub.sessions.get(saved.id)!;
  expect(current).toMatchObject({ runtimeId: native.runtime_id, storedId: native.stored_id, profile: 'default', status: 'idle' });
  expect(cached.row).toMatchObject({ runtimeId: current.runtimeId, storedId: current.storedId, profile: current.profile, status: 'idle' });
  expect(cached.view).toMatchObject({ running: false, nativeProfile: 'default', profile: 'default', uncertain: false });
  return { hub, saved: current };
}
async function openChat() {
  return readyChat(await createChat());
}
function post(sessionId: string, input: unknown) {
  return POST(new Request(portal + '/api/hermes/' + connection + '/operations', { method: 'POST',
    headers: { Origin: portal, 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, input }) }), context());
}
function inspect(sessionId: string) {
  return GET(new Request(`${portal}/api/hermes/${connection}/operations?` + new URLSearchParams({ panel: 'plugin-selection', profile: 'default', sessionId })), context());
}

describe.skipIf(!enabled)('selection sidecar through actual pinned gateway, owner fence and portal PostgreSQL', () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL ?? '');
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/hermes_fixture' || url.search || url.hash ||
      Object.keys(process.env).some(key => /^PG(?:HOST|HOSTADDR|PORT|DATABASE|USER|PASSWORD|OPTIONS|SERVICE|SERVICEFILE|SSLMODE|SSLROOTCERT|SSLCERT|SSLKEY)$/.test(key) && process.env[key]))
      throw new Error('Disposable explicit-port loopback hermes_fixture database without driver overrides required');
    vi.stubEnv('AUTH_URL', portal);
    ({ db, pool } = await import('@/db'));
    ({ DashboardClient } = await import('@/lib/remote-hermes/client'));
    ({ DashboardSocket } = await import('@/lib/remote-hermes/socket'));
    ({ nativeHub } = await import('@/lib/remote-hermes/hub'));
    ({ GET, POST } = await import('@/app/api/hermes/[connectionId]/operations/route'));
  });
  beforeEach(async () => {
    owner = newId(); foreign = newId(); connection = newId(); f.actor = owner;
    fixture = await startPinnedDashboard({ pluginSelection: true }); f.base = fixture.base;
    secrets = await new DashboardClient(f.base, fetch).passwordLogin('synthetic', 'synthetic-password');
    await db.insert(users).values([owner, foreign].map(id => ({ id, upn: `plugin-selection-${id}`, name: 'Synthetic fixture', identityRealm: 'local' as const, authSource: 'local' as const })));
    await db.insert(remoteHermesConnections).values({ id: connection, userId: owner, name: 'Synthetic selection dashboard', baseUrl: f.base,
      authMode: 'password', secretEnc: encrypt(JSON.stringify(secrets), remoteConnectionAAD(connection, owner)) });
  }, 45_000);
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    if (f.base) nativeHub(owner, connection).close();
    await fixture?.stop();
    if (db && owner) await db.delete(users).where(eq(users.id, owner));
    if (db && foreign) await db.delete(users).where(eq(users.id, foreign));
    f.base = ''; f.actor = '';
  });
  afterAll(async () => { await pool?.end(); vi.unstubAllEnvs(); });

  it('refuses an idle-looking chat during construction, then accepts only its ready matching identity without discovery', async () => {
    await control({ plugin_selection_build: 'hold' });
    const chat = await createChat();
    try {
      await vi.waitFor(async () => expect(await control({ plugin_selection_readiness: chat.saved.runtimeId }))
        .toMatchObject({ agent_ready: false, status: 'starting', profile_work: true, build_blocked: true }), { timeout: 10_000 });
      // Reproduce the old setup's false readiness signal with actual native resume.
      const early = await chat.hub.refresh(chat.saved);
      expect(early).toMatchObject({ running: false, nativeProfile: '' });
      const blocked = await post(chat.saved.id, { operation: 'prepare', action: 'plugin-selection', enabled: true });
      expect(blocked.status).toBe(409);
      expect(await blocked.json()).toMatchObject({ error: 'Refresh the selected Hermes chat before changing its project.' });
      await expect(chat.hub.socket.callConnected('collective.plugins.selection.v1', { profile: 'default',
        session_id: chat.saved.runtimeId, action: 'inspect' }, chat.hub.socket.connectionEpoch)).rejects.toMatchObject({ code: 4090 });
      expect(await db.select().from(remoteHermesTurns).where(eq(remoteHermesTurns.sessionId, chat.saved.id))).toHaveLength(0);
    } finally {
      await control({ plugin_selection_build: 'release' });
    }
    const { saved } = await readyChat(chat);
    const before = await control({ plugin_selection_probe: true });
    expect(before).toMatchObject({ forbidden_plugin_calls: 0, selection_hydration_calls: 0, sidecar_exists: false });
    const preparedResponse = await post(saved.id, { operation: 'prepare', action: 'plugin-selection', enabled: true });
    const prepared = await preparedResponse.json(); expect(preparedResponse.status, JSON.stringify(prepared)).toBe(200);
    expect(prepared).toMatchObject({ action: 'plugin-selection', enabled: true });
    const after = await control({ plugin_selection_probe: true });
    expect(after).toMatchObject({ config_sha256: before.config_sha256, forbidden_plugin_calls: 0,
      selection_hydration_calls: 0, sidecar_exists: false, source_module_imported: false });
  }, 45_000);

  it('stores one confirmed preference, preserves raw config, retains frozen startup state and refuses replay', async () => {
    const { hub, saved } = await openChat();
    const before = await control({ plugin_selection_probe: true });
    for (const [key, source] of [['selection_sha256', 'native_plugin_selection.py'], ['selection_store_sha256', 'native_plugin_selection_store.py']])
      expect(before[key]).toBe(createHash('sha256').update(await readFile('src/hermes-recovery/' + source)).digest('hex'));
    expect(before.sidecar_exists).toBe(false); expect(before.startup_selected).toBeNull();
    const response = await post(saved.id, { operation: 'prepare', action: 'plugin-selection', enabled: true });
    const prepared = await response.json(); expect(response.status, JSON.stringify(prepared)).toBe(200);
    expect(prepared).toMatchObject({ action: 'plugin-selection', name: 'teams_pipeline', enabled: true });
    expect((await control({ plugin_selection_probe: true })).sidecar_exists).toBe(false);
    const nativeDispatch = hub.socket.dispatchConnected.bind(hub.socket);
    let selectionWrites = 0;
    const observeDispatch: typeof nativeDispatch = async (method, params, epoch, timeout, tx) => {
      if (method === 'collective.plugins.selection.v1' && params.action === 'select') {
        ++selectionWrites;
        expect(tx).toBeDefined();
        expect(await tx!.select().from(remoteHermesTurns).where(eq(remoteHermesTurns.sessionId, saved.id))).toHaveLength(1);
      }
      return nativeDispatch(method, params, epoch, timeout, tx);
    };
    const dispatch = vi.spyOn(hub.socket, 'dispatchConnected').mockImplementation(observeDispatch);
    const confirmed = await post(saved.id, { operation: 'confirm', confirmation: prepared.confirmation });
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toMatchObject({ accepted: true, pluginSelection: { selected: true, operatorSelected: null, startupSelected: null, loadedState: 'unreported' } });
    const after = await control({ plugin_selection_probe: true });
    expect(after).toMatchObject({ config_sha256: before.config_sha256, sidecar_exists: true, startup_selected: null, forbidden_plugin_calls: 0, selection_hydration_calls: 0, source_module_imported: false });
    const readback = await inspect(saved.id); expect(readback.status).toBe(200);
    expect(await readback.json()).toMatchObject({ pluginSelection: { selected: true, loadedState: 'unreported' } });
    const duplicate = await post(saved.id, { operation: 'confirm', confirmation: prepared.confirmation });
    expect(await duplicate.json()).toMatchObject({ duplicate: true, accepted: false });
    expect(await db.select().from(remoteHermesTurns).where(eq(remoteHermesTurns.sessionId, saved.id))).toHaveLength(1);
    expect((await db.select().from(remoteHermesSessions).where(eq(remoteHermesSessions.id, saved.id)))[0].status).toBe('idle');
    expect(selectionWrites).toBe(1);
    dispatch.mockRestore();
  }, 45_000);

  it('refuses a changed sidecar revision before receipt and never invokes the upstream toggle', async () => {
    const { hub, saved } = await openChat(); await control({ plugin_selection_probe: true });
    const prepareResponse = await post(saved.id, { operation: 'prepare', action: 'plugin-selection', enabled: true });
    const prepared = await prepareResponse.json(); expect(prepareResponse.status, JSON.stringify(prepared)).toBe(200);
    const current = await hub.socket.callConnected('collective.plugins.selection.v1', { profile: 'default', session_id: saved.runtimeId, action: 'inspect' }, hub.socket.connectionEpoch);
    await hub.socket.callConnected('collective.plugins.selection.v1', { profile: 'default', session_id: saved.runtimeId, action: 'select',
      key: 'teams_pipeline', expected_identity: current.identity_revision, expected_revision: current.revision, enabled: false }, hub.socket.connectionEpoch);
    const stale = await post(saved.id, { operation: 'confirm', confirmation: prepared.confirmation });
    expect(stale.status).toBe(409);
    expect(await db.select().from(remoteHermesTurns).where(eq(remoteHermesTurns.sessionId, saved.id))).toHaveLength(0);
    const after = await control({ plugin_selection_probe: true });
    expect(after.forbidden_plugin_calls, JSON.stringify(after.forbidden_plugin_labels)).toBe(0);
  }, 45_000);

  it('refuses an uncached chat without native hydration, discovery, receipt or sidecar writes', async () => {
    const { hub, saved } = await openChat(); const before = await control({ plugin_selection_probe: true });
    hub.sessions.delete(saved.id);
    expect((await inspect(saved.id)).status).toBe(409);
    expect((await post(saved.id, { operation: 'prepare', action: 'plugin-selection', enabled: true })).status).toBe(409);
    expect(await db.select().from(remoteHermesTurns).where(eq(remoteHermesTurns.sessionId, saved.id))).toHaveLength(0);
    expect(await control({ plugin_selection_probe: true })).toMatchObject({ sidecar_exists: false, forbidden_plugin_calls: 0,
      selection_hydration_calls: 0, config_sha256: before.config_sha256 });
  }, 45_000);

  it('rejects unclaimed native requests, foreign portal users and work in a different session of the same profile', async () => {
    const { hub, saved } = await openChat();
    const sibling = await hub.socket.callConnected('session.create', { profile: 'default', source: 'desktop' }, hub.socket.connectionEpoch);
    await vi.waitFor(async () => expect(await control({ plugin_selection_readiness: sibling.session_id }))
      .toMatchObject({ agent_ready: true, status: 'idle', native_profile: 'default', profile_work: false }), { timeout: 10_000 });
    const before = await control({ plugin_selection_probe: true });
    const auth = new DashboardClient(f.base, fetch, secrets);
    const unclaimed = new DashboardSocket(async () => ({ url: new URL(`${f.base.replace('http:', 'ws:')}/api/ws?ticket=${encodeURIComponent(await auth.websocketTicket())}`), options: {} }), () => {});
    sockets.push(unclaimed); await unclaimed.connect();
    await expect(unclaimed.call('collective.plugins.selection.v1', { profile: 'default', session_id: saved.runtimeId })).rejects.toMatchObject({ code: 4091 });
    await expect(hub.socket.callConnected('collective.plugins.selection.v1', { profile: 'default', session_id: saved.runtimeId, action: 'promote' }, hub.socket.connectionEpoch)).rejects.toMatchObject({ code: 4090 });
    f.actor = foreign; expect((await inspect(saved.id)).status).toBe(404); f.actor = owner;
    await control({ workspace_busy: true, session_id: sibling.session_id });
    const blocked = await post(saved.id, { operation: 'prepare', action: 'plugin-selection', enabled: true });
    expect(blocked.status).toBeGreaterThanOrEqual(400);
    await control({ workspace_busy: false, session_id: sibling.session_id });
    expect(await db.select().from(remoteHermesTurns).where(eq(remoteHermesTurns.sessionId, saved.id))).toHaveLength(0);
    const after = await control({ plugin_selection_probe: true });
    expect(after).toMatchObject({ config_sha256: before.config_sha256, sidecar_exists: false,
      forbidden_plugin_calls: 0, selection_hydration_calls: 0, source_module_imported: false });
  }, 45_000);
});
