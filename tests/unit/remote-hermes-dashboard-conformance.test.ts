import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DashboardClient, type DashboardSecrets } from '@/lib/remote-hermes/client';
import { startPinnedDashboard } from '../fixtures/remote-hermes-dashboard';
import { DashboardSocket, NativeRpcError, type NativeFrame, type RpcRecord } from '@/lib/remote-hermes/socket';

const enabled = process.env.REMOTE_HERMES_DASHBOARD_CONFORMANCE === '1';
let processFixture: Awaited<ReturnType<typeof startPinnedDashboard>>;
let base: string, auth: DashboardClient, secrets: DashboardSecrets, socket: DashboardSocket;
const frames: NativeFrame[] = [];
const rpc = (method: string, params: RpcRecord = {}) => socket.call(method, params);
let runtime: string, stored: string;
const params = () => ({ session_id: runtime, profile: 'default' });
async function snapshot() { return rpc('session.resume', { session_id: stored, profile: 'default', close_on_disconnect: false }); }
async function fixture(path: string, body?: unknown) {
  const result = await fetch(base + '/api/__fixture/' + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${secrets.accessToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!result.ok) throw new Error(`Synthetic fixture control failed (${result.status})`);
  return result.json();
}
function syntheticPdf() {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] /Contents 4 0 R >>', '<< /Length 0 >>\nstream\n\nendstream'];
  let text = '%PDF-1.4\n'; const offsets = [0];
  for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(text)); text += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref = Buffer.byteLength(text);
  text += `xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text).toString('base64');
}
async function idle() { await expect.poll(async () => (await snapshot()).running, { timeout: 15000 }).toBe(false); }
describe.skipIf(!enabled)('actual pinned Hermes dashboard conformance; synthetic provider/agent', () => {
  beforeAll(async () => {
    processFixture = await startPinnedDashboard(); base = processFixture.base;
    const bootstrap = new DashboardClient(base, fetch);
    expect((await bootstrap.status()).version).toBe('0.21.5');
    secrets = await bootstrap.passwordLogin('synthetic', 'synthetic-password');
    auth = new DashboardClient(base, fetch, secrets);
    socket = new DashboardSocket(async () => ({ url: new URL(`${base.replace('http:', 'ws:')}/api/ws?ticket=${encodeURIComponent(await auth.websocketTicket())}`), options: {} }), frame => frames.push(frame));
    await socket.connect();
    const created = await rpc('session.create', { profile: 'default', close_on_disconnect: false, title: 'Synthetic conformance' });
    runtime = String(created.session_id); stored = String(created.stored_session_id);
  }, 45000);
  afterAll(async () => {
    socket?.close();
    await processFixture?.stop();
  });
  it('uses actual native password login, refresh rotation, authenticated profiles and one-use WS tickets', async () => {
    expect((await auth.profiles()).map(p => p.name)).toContain('default');
    const old = auth; secrets = await auth.refresh(); auth = new DashboardClient(base, fetch, secrets);
    await expect(old.profiles()).rejects.toThrow('sign-in');
    expect((await auth.profiles()).map(p => p.name)).toContain('default');
    expect((await fixture('metrics')).refreshes).toBe(1);
    expect(socket.serverRequests).toContain('approval');
    const ticket = await auth.websocketTicket();
    const target = async () => ({ url: new URL(`${base.replace('http:', 'ws:')}/api/ws?ticket=${encodeURIComponent(ticket)}`), options: {} });
    const first = new DashboardSocket(target, () => {}), reused = new DashboardSocket(target, () => {});
    try { await first.connect(); await expect(reused.connect()).rejects.toThrow(); }
    finally { first.close(); reused.close(); }
  });
  it('stages original image and file bytes through actual native handlers; bounds PDF capability explicitly', async () => {
    const image = await rpc('image.attach_bytes', { ...params(), filename: 'fixture.png', content_base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zf7cAAAAASUVORK5CYII=' });
    expect(image).toMatchObject({ attached: true });
    expect(await rpc('file.attach', { ...params(), name: 'fixture.txt', data_url: 'data:text/plain;base64,U3ludGhldGljIGZpeHR1cmU=' })).toMatchObject({ attached: true });
    const pdf = await rpc('pdf.attach', { ...params(), filename: 'fixture.pdf', content_base64: syntheticPdf() }).catch(error => error);
    if (process.env.HERMES_REQUIRE_PDF === '1') expect(pdf).toMatchObject({ attached: true, pages_attached: 1 });
    else if (pdf instanceof NativeRpcError) expect(pdf.code).toBe(5028); // Explicit local Poppler capability gap.
    else expect(pdf).toMatchObject({ attached: true, pages_attached: 1 });
    const hashes = (await fixture('metrics')).attachment_hashes;
    expect(hashes).toContain(createHash('sha256').update('Synthetic fixture').digest('hex'));
    expect(hashes).toContain(createHash('sha256').update(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zf7cAAAAASUVORK5CYII=', 'base64')).digest('hex'));
    await rpc('image.detach', { ...params(), path: image.path });
  });
  it('adds a typed HTTPS MCP server through the exact native handler and reads back redacted inventory', async () => {
    const token = 'synthetic-mcp-bearer-only';
    const added = await rpc('mcp.servers.add', {
      profile: 'default', name: 'fixture-custom-http',
      config: { url: 'https://mcp.example.invalid/v1' }, bearer_token: token,
    });
    expect(added).toMatchObject({ ok: true, name: 'fixture-custom-http', server: {
      name: 'fixture-custom-http', transport: 'http', source: 'config', auth: 'header', env: [],
    } });
    expect(JSON.stringify(added)).not.toContain(token);
    const inventory = await rpc('mcp.servers.list', { profile: 'default' });
    expect(inventory.servers).toEqual(expect.arrayContaining([expect.objectContaining({
      name: 'fixture-custom-http', transport: 'http', source: 'config', auth: 'header', env: [],
    })]));
    expect(JSON.stringify(inventory)).not.toContain(token);
    await expect(rpc('mcp.servers.add', {
      profile: 'default', name: 'fixture-custom-http', config: { url: 'https://other.example.invalid/mcp' },
    })).rejects.toMatchObject({ code: 4090 });
    expect((await rpc('mcp.servers.list', { profile: 'default' })).servers).toEqual(expect.arrayContaining([expect.objectContaining({
      name: 'fixture-custom-http', url: 'https://mcp.example.invalid/v1',
    })]));
  });
  it('confirms the pinned native credential-slot punctuation normalization', async () => {
    const names = ['fixture-slot-team-api', 'fixture-slot-team.api'];
    const token = 'synthetic-slot-parity-token';
    try {
      for (const name of names) {
        await expect(rpc('mcp.servers.add', {
          profile: 'default', name, config: { url: 'https://mcp.example.invalid/v1' },
        })).resolves.toMatchObject({ ok: true, name });
      }
      const slots = [];
      for (const name of names) {
        const configured = await rpc('mcp.servers.set_api_key', { profile: 'default', name, value: token });
        expect(JSON.stringify(configured)).not.toContain(token);
        slots.push(configured.env_var);
      }
      // Exact pinned _env_key_for_server replaces punctuation with underscores.
      expect(slots).toEqual(['MCP_FIXTURE_SLOT_TEAM_API_API_KEY', 'MCP_FIXTURE_SLOT_TEAM_API_API_KEY']);
    } finally {
      for (const name of names) await rpc('mcp.servers.remove', { profile: 'default', name }).catch(() => undefined);
    }
  });
  it('runs a deterministic native turn, restores history and reconnects without resubmitting', async () => {
    const before = (await fixture('metrics')).agent_turns;
    expect(await rpc('prompt.submit', { ...params(), text: 'fixture-reply' })).toMatchObject({ status: 'streaming' });
    await idle();
    await fixture('control', { disconnect: true });
    await expect.poll(() => socket.state, { timeout: 5000 }).toBe('reconnecting');
    const resumed = await snapshot();
    expect(resumed.session_id).toBe(runtime);
    expect((await auth.history('default', stored, 0)).messages.some(row => row.text.includes('fixture-reply'))).toBe(true);
    expect((await fixture('metrics')).agent_turns).toBe(before + 1);
  }, 20000);
  it.each(['secret', 'clarify', 'approval'])('recovers and answers actual native %s requests by exact request identity', async method => {
    frames.length = 0;
    await rpc('prompt.submit', { ...params(), text: method === 'secret' ? 'fixture-protected' : `fixture-${method}` });
    await expect.poll(() => frames.some(frame => frame.method === method), { timeout: 10000 }).toBe(true);
    const request = frames.find(frame => frame.method === method)!;
    await fixture('control', { disconnect: true });
    await expect.poll(() => socket.state, { timeout: 5000 }).toBe('reconnecting');
    expect((await snapshot()).open_requests).toEqual(expect.arrayContaining([expect.objectContaining({ id: request.id, method })]));
    await socket.answer(request.id!, method === 'secret' ? { value: 'synthetic-protected-only' } : method === 'clarify' ? { answers: { q1: 'One' } } : { choice: 'deny' });
    await idle();
    expect(JSON.stringify(await auth.history('default', stored, 0))).not.toContain('synthetic-protected-only');
  }, 20000);
  it('queues once, interrupts through the real handler and observes native settlement', async () => {
    await rpc('prompt.submit', { ...params(), text: 'fixture-hold' });
    expect(await rpc('prompt.submit', { ...params(), text: 'fixture-next', queued: true })).toMatchObject({ status: 'queued' });
    expect((await snapshot()).queued).toBeTruthy();
    expect(await rpc('session.interrupt', params())).toMatchObject({ status: 'interrupted' });
    await idle();
    expect((await snapshot()).queued).toBeUndefined();
  });
  it('does not resubmit a turn after the actual handler accepts it and its transport acknowledgement is lost', async () => {
    const before = (await fixture('metrics')).agent_turns;
    await fixture('control', { drop_next_ack: true });
    await expect(rpc('prompt.submit', { ...params(), text: 'fixture-lost-ack' })).rejects.toThrow('may have been accepted');
    await idle();
    expect((await fixture('metrics')).agent_turns).toBe(before + 1);
    expect((await fixture('metrics')).dropped_acks).toBe(1);
    expect((await fixture('metrics')).external_attempts).toBe(0);
  });
});
