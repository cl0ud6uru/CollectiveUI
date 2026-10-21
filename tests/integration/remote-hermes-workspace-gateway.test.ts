import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { remoteHermesConnections, remoteHermesSessions, users } from '@/db/schema';
import { encrypt } from '@/lib/crypto';
import { newId } from '@/lib/ids';
import type { DashboardSecrets } from '@/lib/remote-hermes/client';
import { remoteConnectionAAD } from '@/lib/remote-hermes/secrets';
import { startPinnedDashboard } from '../fixtures/remote-hermes-dashboard';

// Only request authentication and policy configuration are synthetic. Principal lookup,
// operations route, portal DB/receipts, socket, ASGI upgrade, dispatcher and adapters are real.
const f = vi.hoisted(() => ({ base: '', actor: '', headers: new Headers() }));
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/headers', () => ({ headers: async () => f.headers }));
vi.mock('@/auth', () => ({ auth: async () => f.actor ? { user: { id: f.actor, sessionVersion: 0 } } : null }));
vi.mock('@/lib/settings', () => ({ getSetting: async () => ({ enabled: true, privateGateways: [f.base] }) }));

const enabled = process.env.REMOTE_HERMES_WORKSPACE_GATEWAY === '1';
const adapter = process.env.REMOTE_HERMES_WORKSPACE_GATEWAY_ADAPTER === 'read' ? 'read' : 'write';
let db: typeof import('@/db').db, pool: typeof import('@/db').pool;
let DashboardClient: typeof import('@/lib/remote-hermes/client').DashboardClient;
let DashboardSocket: typeof import('@/lib/remote-hermes/socket').DashboardSocket;
let nativeHub: typeof import('@/lib/remote-hermes/hub').nativeHub;
let GET: typeof import('@/app/api/hermes/[connectionId]/operations/route').GET;
let POST: (request: Request, context: { params: Promise<{ connectionId: string }> }) => Promise<Response>;
let fixture: Awaited<ReturnType<typeof startPinnedDashboard>>, secrets: DashboardSecrets;
let owner = '', connection = '', foreign = '';
const sockets: InstanceType<typeof import('@/lib/remote-hermes/socket').DashboardSocket>[] = [];
const portal = 'http://portal.fixture.invalid';
const context = () => ({ params: Promise.resolve({ connectionId: connection }) });
async function control(body: unknown) {
  const response = await fetch(f.base + '/api/__fixture/control', { method: 'POST',
    headers: { Authorization: `Bearer ${secrets.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  expect(response.ok).toBe(true);
  return response.json();
}
async function metrics() {
  return (await fetch(f.base + '/api/__fixture/metrics', { headers: { Authorization: `Bearer ${secrets.accessToken}` } })).json();
}
async function getFiles(sessionId: string, profile = 'default', extra: Record<string, string> = {}) {
  const query = new URLSearchParams({ panel: 'files', profile, sessionId, ...extra });
  return GET(new Request(`${portal}/api/hermes/${connection}/operations?${query}`), context());
}
async function postEdit(sessionId: string, input: unknown, origin = portal) {
  return POST(new Request(`${portal}/api/hermes/${connection}/operations`, { method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, input }) }), context());
}
async function openWorkspace(profile = 'default') {
  const setup = await control({ workspace_roots: true });
  expect(setup.adapter).toBe(adapter);
  for (const [key, path] of [['workspace_sha256', 'src/hermes-recovery/native_workspace_files.py'],
    ['owner_sha256', 'src/hermes-recovery/native_hub_owner.py'], ['owner_installer_sha256', 'scripts/install-hermes-hub-owner.py']])
    expect(setup[key]).toBe(createHash('sha256').update(await readFile(path)).digest('hex'));
  const hub = nativeHub(owner, connection), root = setup.roots[profile];
  await hub.socket.call('projects.create', { profile, name: `Synthetic ${profile} project`, folders: [root] });
  // Seed a real persisted native session without submitting any model turn.
  const created = await hub.socket.call('session.create', { profile, cwd: root, source: 'desktop',
    messages: [{ role: 'user', content: 'Synthetic saved question' }, { role: 'assistant', content: 'Synthetic saved answer' }] });
  const [saved] = await db.insert(remoteHermesSessions).values({ id: newId(), connectionId: connection, profile,
    storedId: String(created.stored_session_id), runtimeId: String(created.session_id), title: 'Synthetic workspace chat' }).returning();
  await vi.waitFor(async () => expect((await hub.refresh(saved)).running).toBe(false), { timeout: 10_000 });
  return { saved, hub };
}
async function rawSocket() {
  const auth = new DashboardClient(f.base, fetch, secrets);
  const socket = new DashboardSocket(async () => ({ url: new URL(`${f.base.replace('http:', 'ws:')}/api/ws?ticket=${encodeURIComponent(await auth.websocketTicket())}`), options: {} }), () => {});
  sockets.push(socket);
  await socket.connect();
  return socket;
}

describe.skipIf(!enabled)(`real pinned gateway workspace ${adapter} through portal operations route`, () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL ?? '');
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' || !url.port ||
      url.pathname !== '/hermes_fixture' || url.search || url.hash ||
      Object.keys(process.env).some(key => /^PG(?:HOST|HOSTADDR|PORT|DATABASE|USER|PASSWORD|OPTIONS|SERVICE|SERVICEFILE|SSLMODE|SSLROOTCERT|SSLCERT|SSLKEY)$/.test(key) && process.env[key]))
      throw new Error('New disposable explicit-port loopback hermes_fixture database without driver overrides required');
    vi.stubEnv('AUTH_URL', portal);
    const provenance = Object.fromEntries(await Promise.all([
      ['workspace', 'src/hermes-recovery/native_workspace_files.py'],
      ['owner', 'src/hermes-recovery/native_hub_owner.py'],
      ['ownerInstaller', 'scripts/install-hermes-hub-owner.py'],
    ].map(async ([name, path]) => [name, createHash('sha256').update(await readFile(path)).digest('hex')])));
    console.info('Full-gateway adapter SHA256:', JSON.stringify(provenance));
    ({ db, pool } = await import('@/db'));
    ({ DashboardClient } = await import('@/lib/remote-hermes/client'));
    ({ DashboardSocket } = await import('@/lib/remote-hermes/socket'));
    ({ nativeHub } = await import('@/lib/remote-hermes/hub'));
    ({ GET, POST } = await import('@/app/api/hermes/[connectionId]/operations/route'));
  });
  beforeEach(async () => {
    owner = newId(); foreign = newId(); connection = newId(); f.actor = owner;
    fixture = await startPinnedDashboard({ workspaceAdapter: adapter }); f.base = fixture.base;
    secrets = await new DashboardClient(f.base, fetch).passwordLogin('synthetic', 'synthetic-password');
    await db.insert(users).values([owner, foreign].map(id => ({ id, upn: `workspace-gateway-${id}`, name: 'Synthetic fixture', identityRealm: 'local' as const, authSource: 'local' as const })));
    await db.insert(remoteHermesConnections).values({ id: connection, userId: owner, name: 'Synthetic workspace dashboard', baseUrl: f.base, authMode: 'password',
      secretEnc: encrypt(JSON.stringify(secrets), remoteConnectionAAD(connection, owner)) });
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

  it('lists and reads persisted native projects across A → B → A without exposing protected paths', async () => {
    const a = await openWorkspace(), b = await openWorkspace('fixture-other');
    for (const { saved } of [a, b, a]) {
      const list = await getFiles(saved.id, saved.profile);
      expect(list.status).toBe(200);
      const files = await list.json();
      expect(files.available).toBe(true);
      expect(files.entries.map((entry: { name: string }) => entry.name)).toEqual(['nested', 'README.md']);
      const response = await getFiles(saved.id, saved.profile, { action: 'read', workspaceId: files.workspaceId, path: 'README.md' });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ content: `Synthetic ${saved.profile} workspace\n`, path: 'README.md' });
      for (const path of ['../outside.txt', '.env', 'outside-link']) expect((await getFiles(saved.id, saved.profile, { action: 'read', path })).status).toBeGreaterThanOrEqual(400);
    }
    expect(await metrics()).toMatchObject({ agent_turns: 0, external_attempts: 0 });
  }, 20_000);

  it('denies anonymous and foreign portal actors, profile mismatch, and invalid workspace identity', async () => {
    const { saved } = await openWorkspace();
    f.actor = ''; expect((await getFiles(saved.id)).status).toBe(401);
    f.actor = foreign; expect((await getFiles(saved.id)).status).toBe(404);
    f.actor = owner; expect((await getFiles(saved.id, 'fixture-other')).status).toBe(403);
    expect((await getFiles(saved.id, 'default', { workspaceId: '0'.repeat(32) })).status).toBeGreaterThanOrEqual(400);
    expect(await metrics()).toMatchObject({ agent_turns: 0, external_attempts: 0 });
  });

  it('denies busy native sessions and an authenticated socket without a current owner claim', async () => {
    const { saved } = await openWorkspace();
    await control({ workspace_busy: true, session_id: saved.runtimeId });
    try {
      expect((await getFiles(saved.id)).status).toBeGreaterThanOrEqual(400);
      await expect(nativeHub(owner, connection).socket.call('collective.workspace.files', { profile: 'default', session_id: saved.runtimeId, action: 'list' })).rejects.toMatchObject({ code: 4090 });
    }
    finally { await control({ workspace_busy: false, session_id: saved.runtimeId }); }
    const socket = await rawSocket();
    await expect(socket.call('collective.workspace.files', { profile: 'default', session_id: saved.runtimeId, action: 'list' })).rejects.toMatchObject({ code: 4091 });
    expect(await metrics()).toMatchObject({ agent_turns: 0, external_attempts: 0 });
  });

  it.skipIf(adapter === 'read')('confirms one digest-bound edit through the portal route, native write and readback without replay', async () => {
    const { saved } = await openWorkspace();
    const loaded = await getFiles(saved.id, 'default', { action: 'read', path: 'README.md' });
    expect(loaded.status).toBe(200);
    const file = await loaded.json(), content = 'Reviewed full-gateway edit\n';
    const prepared = await postEdit(saved.id, { operation: 'prepare', action: 'file-edit', workspaceId: file.workspaceId, path: file.path, expectedSha256: file.sha256, content });
    expect(prepared.status).toBe(200);
    const { confirmation } = await prepared.json();
    expect((await postEdit(saved.id, { operation: 'confirm-file-edit', confirmation, content }, 'http://foreign.fixture.invalid')).status).toBe(403);
    expect((await postEdit(saved.id, { operation: 'confirm-file-edit', confirmation, content: 'Altered after review' })).status).toBe(409);
    const confirmed = await postEdit(saved.id, { operation: 'confirm-file-edit', confirmation, content });
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toMatchObject({ accepted: true, duplicate: false });
    const repeated = await postEdit(saved.id, { operation: 'confirm-file-edit', confirmation, content });
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({ accepted: true, duplicate: true });
    const readback = await getFiles(saved.id, 'default', { action: 'read', path: 'README.md' });
    expect(await readback.json()).toMatchObject({ content });
    expect(await metrics()).toMatchObject({ agent_turns: 0, external_attempts: 0 });
  });

  it.skipIf(adapter === 'read')('rejects stale content and a confirmation moved to another saved native chat', async () => {
    const a = await openWorkspace(), b = await openWorkspace('fixture-other');
    const file = await (await getFiles(a.saved.id, 'default', { action: 'read', path: 'README.md' })).json();
    const content = 'Reviewed only for A\n';
    const prepare = () => postEdit(a.saved.id, { operation: 'prepare', action: 'file-edit', workspaceId: file.workspaceId, path: file.path, expectedSha256: file.sha256, content });
    const { confirmation } = await (await prepare()).json();
    expect((await postEdit(b.saved.id, { operation: 'confirm-file-edit', confirmation, content })).status).toBe(409);
    expect((await postEdit(a.saved.id, { operation: 'prepare', action: 'file-edit', workspaceId: file.workspaceId, path: file.path, expectedSha256: '0'.repeat(64), content })).status).toBe(409);
    expect(await metrics()).toMatchObject({ agent_turns: 0, external_attempts: 0 });
  });

  it('fences an old portal socket after native owner replacement', async () => {
    const { saved, hub } = await openWorkspace();
    const socket = await rawSocket();
    const current = await socket.call('collective.hub_owner.current', { profile: 'default' });
    // Native session pollers are tracked workers in the published owner adapter;
    // close this synthetic session first rather than weakening takeover guards.
    await hub.socket.call('session.close', { profile: 'default', session_id: saved.runtimeId });
    await vi.waitFor(async () => {
      expect(await control({ profile_workers: true })).toMatchObject({ default: 0 });
    }, { timeout: 10_000 });
    await socket.call('collective.hub_owner.claim', { profile: 'default', phase: 'full', portal_connection_id: randomUUID(), portal_instance_id: randomUUID(),
      portal_generation: 1, portal_socket_epoch: 1, expected_native_generation: current.native_generation });
    await expect(hub.socket.callConnected('collective.workspace.files', { profile: 'default', session_id: saved.runtimeId, action: 'list' }, hub.socket.connectionEpoch)).rejects.toMatchObject({ code: 4091 });
    expect(await metrics()).toMatchObject({ agent_turns: 0, external_attempts: 0 });
  }, 20_000);
});
