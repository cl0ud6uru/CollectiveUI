import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connect } from 'node:net';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { startPersonalBroker } from '@/personal-codex/server';
import { SbxPersonalCodexDriver } from '@/personal-codex/sbx';
import { SbxBrokerConfigSchema, runtimeKey } from '@/personal-codex/docker';
import { enrollmentReadinessSchema, tokenFingerprint } from '@/personal-codex/contracts';
import { socketFetch, LOCAL_ORIGIN } from '@/lib/local-hermes/client';

const template = `registry.example/computer@sha256:${'a'.repeat(64)}`;
let directory: string;
let driver: SbxPersonalCodexDriver;
let broker: Awaited<ReturnType<typeof startPersonalBroker>> | undefined;
let running: boolean;
let exists: boolean;
let fetchBroker: ReturnType<typeof socketFetch>;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'admin-broker-'));
  running = false; exists = true;
  driver = new SbxPersonalCodexDriver(SbxBrokerConfigSchema.parse({ backend: 'sbx', adminEnabled: true,
    socketPath: join(directory, 'broker.sock'), sbxHome: directory, namespace: 'cui-codex-test',
    template, cpus: 2, memoryMb: 4096, owners: ['alice'], siwcSandboxVerified: true }));
  vi.spyOn(driver, 'adminConfigure');
  vi.spyOn(driver, 'adminHealth').mockResolvedValue({ version: 'v0.48.0', checks: [] });
  vi.spyOn(driver, 'adminInventory').mockImplementation(async () => [{ ownerId: 'alice', state: !exists ? 'missing' : running ? 'running' : 'stopped', cpus: 2, memoryMb: 4096, template, activeSessions: 0 }]);
  vi.spyOn(driver, 'adminTemplates').mockResolvedValue([{ reference: template, available: true }]);
  vi.spyOn(driver, 'adminArchives').mockResolvedValue([]);
  vi.spyOn(driver, 'inspect').mockImplementation(async () => exists ? { State: { Running: running } } : null);
  vi.spyOn(driver, 'ensure').mockImplementation(async () => { exists = true; running = true; });
  vi.spyOn(driver, 'startRetained').mockImplementation(async () => { running = true; });
  vi.spyOn(driver, 'stop').mockImplementation(async () => { running = false; });
  vi.spyOn(driver, 'cleanup').mockImplementation(async () => { exists = false; running = false; });
  vi.spyOn(driver, 'computerStatus').mockImplementation(async () => ({ available: exists, running, width: 1280, height: 800 }));
  vi.spyOn(driver, 'computerPause').mockResolvedValue();
  fetchBroker = socketFetch(driver.config.socketPath);
});
afterEach(async () => { await broker?.close(); broker = undefined; await rm(directory, { recursive: true, force: true }); });

const act = (request: unknown) => fetchBroker(`${LOCAL_ORIGIN}/admin/action`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actorId: 'admin', request }),
});

function runtimeSocket() {
  const ws = new WebSocket('ws://127.0.0.1/runtime', { createConnection: () => connect(driver.config.socketPath),
    headers: { 'x-collective-owner': 'alice' }, handshakeTimeout: 2000 });
  return new Promise<WebSocket>((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    ws.once('close', () => reject(new Error('Runtime transport denied.')));
  });
}

describe('protected admin broker routes', () => {
  it.each([false, true])('denies an unverified SBX bridge without native-login fallback (configured proof %s)', async configured => {
    driver.config.siwcSandboxVerified = configured;
    vi.spyOn(driver, 'siwcVerified').mockResolvedValue(false);
    const bridge = vi.spyOn(driver, 'bridge');
    broker = await startPersonalBroker(driver);
    await expect(runtimeSocket()).rejects.toThrow();
    expect(bridge).not.toHaveBeenCalled();
  });

  it('rejects an earlier upgrade generation after the same token is resynchronized during the final proof wait', async () => {
    vi.spyOn(driver, 'siwcVerified').mockResolvedValue(true);
    vi.spyOn(driver, 'synchronizeToken').mockResolvedValue();
    broker = await startPersonalBroker(driver);
    const accessToken = 'synthetic-same-token';
    const sync = () => fetchBroker(`${LOCAL_ORIGIN}/sync-token`, { method: 'POST', headers: { 'x-collective-owner': 'alice' },
      body: JSON.stringify({ accessToken, credentialBinding: tokenFingerprint(accessToken) }) });
    expect((await sync()).status).toBe(200);
    const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: 'pipe',
      env: { NODE_ENV: 'test', PATH: process.env.PATH } });
    vi.spyOn(driver, 'bridge').mockResolvedValue(child);
    let entered!: () => void, release!: () => void, calls = 0;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(driver.siwcVerified).mockImplementation(async () => {
      if (++calls === 2) { entered(); await wait; }
      return true;
    });
    const pending = runtimeSocket().then(ws => { ws.terminate(); return null; }, error => error);
    try {
      await started;
      expect((await sync()).status).toBe(200);
    } finally { release(); }
    try { expect(await pending).toBeInstanceOf(Error); }
    finally { child.kill(); }
  });

  it('reports operator-managed SBX preparation without adopting Docker consent or provisioning', async () => {
    const receiptName = `codex-enrollment-${runtimeKey('bob')}.json`;
    await writeFile(join(directory, receiptName), JSON.stringify({ version: 1, admission: 'admitted', owner: 'bob',
      namespace: driver.config.namespace, image: `sha256:${'a'.repeat(64)}`, consentVersion: 1, sessionVersion: 7 }), { mode: 0o600 });
    broker = await startPersonalBroker(driver);
    for (const owner of ['alice', 'bob']) {
      const expected = { state: 'operator_setup_required', selfEnrollment: false, enrolled: owner === 'alice',
        reason: 'SBX runtime preparation is operator managed; self enrollment is unavailable.' };
      for (const [path, method] of [['/readiness', 'GET'], ['/prepare', 'POST']] as const) {
        const response = await fetchBroker(`${LOCAL_ORIGIN}${path}`, { method, headers: { 'x-collective-owner': owner },
          ...(method === 'POST' ? { body: JSON.stringify({ consentVersion: 1, sessionVersion: 7 }) } : {}) });
        expect(response.status).toBe(200);
        expect(enrollmentReadinessSchema.parse(await response.json())).toEqual(expected);
      }
    }
    expect(driver.ensure).not.toHaveBeenCalled();
    expect(driver.startRetained).not.toHaveBeenCalled();
    expect(driver.inspect).not.toHaveBeenCalled();
    expect(await driver.adminOwnerAccess('bob')).toEqual({ known: false, admitted: false });
    expect(driver.config.owners).toEqual(['alice']);
    expect((await readdir(directory)).filter(name => name.startsWith('codex-enrollment-'))).toEqual([receiptName]);
  });

  it('exposes unavailable setup metadata when operator administration is disabled', async () => {
    driver.config.adminEnabled = false;
    broker = await startPersonalBroker(driver);
    const snapshot = await fetchBroker(`${LOCAL_ORIGIN}/admin/snapshot`);
    expect(snapshot.status).toBe(200);
    expect(await snapshot.json()).toMatchObject({ available: false, backend: 'sbx' });
    expect((await act({ action: 'lifecycle', ownerId: 'alice', operation: 'start' })).status).toBe(503);
    expect(driver.adminConfigure).not.toHaveBeenCalled();
    expect(driver.startRetained).not.toHaveBeenCalled();
  });
  it('validates admin envelopes without dispatching unknown commands or owner selectors', async () => {
    broker = await startPersonalBroker(driver);
    for (const request of [
      { action: 'exec', command: 'id' },
      { action: 'lifecycle', ownerId: 'alice', operation: 'start', sandboxName: 'external' },
      { action: 'template-import', revision: 0, archive: '../outside.tar', reference: template },
    ]) expect((await act(request)).status).toBe(400);
    expect(driver.startRetained).not.toHaveBeenCalled();
  });
  it('runs owner lifecycle operations and stops a human-controlled computer without resuming it', async () => {
    broker = await startPersonalBroker(driver);
    expect((await act({ action: 'lifecycle', ownerId: 'alice', operation: 'start' })).status).toBe(200);
    const takeover = await fetchBroker(`${LOCAL_ORIGIN}/computer/control`, { method: 'POST',
      headers: { 'x-collective-owner': 'alice', 'x-collective-view-session': 'b'.repeat(64) }, body: JSON.stringify({ action: 'takeover' }) });
    expect(takeover.status).toBe(200);
    const before = await (await fetchBroker(`${LOCAL_ORIGIN}/admin/snapshot`)).json();
    expect(before.runtimes[0].computer.control).toBe('human');
    expect(JSON.stringify(before)).not.toContain('b'.repeat(64));
    expect((await act({ action: 'lifecycle', ownerId: 'alice', operation: 'stop' })).status).toBe(200);
    expect(driver.computerPause).toHaveBeenCalledExactlyOnceWith('alice', true);
    expect(running).toBe(false);
    const after = await (await fetchBroker(`${LOCAL_ORIGIN}/admin/snapshot`)).json();
    expect(after.runtimes[0]).toMatchObject({ state: 'stopped', credentialState: 'sync_required', computer: { control: 'unavailable' } });
  });
  it('requires the explicit delete confirmation and never exposes driver exception details', async () => {
    broker = await startPersonalBroker(driver);
    expect((await act({ action: 'lifecycle', ownerId: 'alice', operation: 'delete' })).status).toBe(400);
    expect(driver.cleanup).not.toHaveBeenCalled();
    vi.mocked(driver.stop).mockRejectedValueOnce(new Error('secret-cli-stderr'));
    const response = await act({ action: 'lifecycle', ownerId: 'alice', operation: 'stop' });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('secret-cli-stderr');
  });
  it('admits new owners through the admin page and revokes their broker access without erasing identity', async () => {
    broker = await startPersonalBroker(driver);
    const request = (path: string, method = 'GET') => fetchBroker(`${LOCAL_ORIGIN}${path}`, {
      method, headers: { 'x-collective-owner': 'bob' },
    });
    expect((await request('/status')).status).toBe(403);
    expect((await act({ action: 'enrollment', revision: 0, ownerId: 'bob', admitted: true })).status).toBe(200);
    expect(driver.config.owners).toEqual(['alice']);
    expect((await request('/status')).status).toBe(200);
    expect((await request('/start', 'POST')).status).toBe(200);
    expect((await act({ action: 'enrollment', revision: 1, ownerId: 'bob', admitted: false })).status).toBe(200);
    expect((await request('/start', 'POST')).status).toBe(403);
    expect((await request('/computer/status')).status).toBe(403);
    expect((await request('/status')).status).toBe(200);
    expect((await request('/disconnect', 'POST')).status).toBe(200);
    expect(driver.cleanup).not.toHaveBeenCalled();
  });
});
