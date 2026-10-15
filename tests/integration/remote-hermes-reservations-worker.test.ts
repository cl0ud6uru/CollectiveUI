import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';

const rpc = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('@/lib/settings', () => ({ getSetting: async () => ({ enabled: true, privateGateways: [] }) }));
vi.mock('@/lib/remote-hermes/store', () => ({ remoteAccess: vi.fn() }));
vi.mock('@/lib/remote-hermes/transport', () => ({ dashboardAddress: async () => ({ address: '93.184.216.34', family: 4 }) }));
vi.mock('@/lib/remote-hermes/socket', async original => {
  const actual = await original<typeof import('@/lib/remote-hermes/socket')>();
  return { ...actual, DashboardSocket: class {
    state = 'connected';
    call = rpc.call;
    async callWithEpoch(...args: unknown[]) { return { result: await rpc.call(...args), epoch: 1 }; }
    close() {}
  } };
});

import { assertDisposableHermesDatabase } from '../fixtures/remote-hermes-disposable-database';

const role = process.env.REMOTE_HERMES_PORTAL_WORKER;
const enabled = role === 'dispatch' || role === 'verify';
let pool: typeof import('@/db').pool;
let nativeHub: typeof import('@/lib/remote-hermes/hub').nativeHub;
let nativeControl: typeof import('@/lib/remote-hermes/sessions').nativeControl;
const owner = process.env.REMOTE_HERMES_PORTAL_WORKER_OWNER!;
const connection = process.env.REMOTE_HERMES_PORTAL_WORKER_CONNECTION!;
const session = process.env.REMOTE_HERMES_PORTAL_WORKER_SESSION!;
const request = process.env.REMOTE_HERMES_PORTAL_WORKER_REQUEST!;
const otherRequest = process.env.REMOTE_HERMES_PORTAL_WORKER_OTHER_REQUEST!;
const signalPath = process.env.REMOTE_HERMES_PORTAL_WORKER_SIGNAL!;
const idle = { session_id: 'runtime', stored_session_id: 'stored', running: false, info: { title: 'Synthetic' }, messages: [] };

describe.skipIf(!enabled)('portal queue receipt subprocess fixture', () => {
  beforeAll(async () => {
    if (![owner, connection, session, request, otherRequest, signalPath].every(value => typeof value === 'string' && value.length > 0)) {
      throw new Error('Portal subprocess fixture arguments are required.');
    }
    assertDisposableHermesDatabase(process.env.DATABASE_URL);
    ({ pool } = await import('@/db'));
    ({ nativeHub } = await import('@/lib/remote-hermes/hub'));
    ({ nativeControl } = await import('@/lib/remote-hermes/sessions'));
  });
  afterAll(async () => {
    if (owner && connection) nativeHub?.(owner, connection).close();
    await pool?.end();
  });

  it.skipIf(role !== 'dispatch')('holds a synthetic prompt RPC after its durable reservation', async () => {
    rpc.call.mockImplementation(async (method: string) => {
      if (method === 'session.resume') return { ...idle, running: true };
      if (method === 'prompt.submit' && role === 'dispatch') {
        writeFileSync(signalPath, 'submitted');
        return new Promise<never>(() => {});
      }
      throw new Error('Unexpected synthetic native RPC.');
    });
    expect(role).toBe('dispatch');
    await nativeControl(owner, connection, session, 'queue', { requestId: request, text: 'Synthetic queue request' });
  }, 60000);

  it.skipIf(role !== 'verify')('rejects a different request and deduplicates the persisted receipt without RPC replay', async () => {
    rpc.call.mockImplementation(async (method: string) => {
      if (method === 'session.resume') return { ...idle, running: true };
      throw new Error('Queue prompt RPC must not be replayed.');
    });
    expect(role).toBe('verify');
    await expect(nativeControl(owner, connection, session, 'queue', { requestId: otherRequest, text: 'Different queue request' }))
      .rejects.toMatchObject({ status: 409 });
    await expect(nativeControl(owner, connection, session, 'queue', { requestId: request, text: 'Synthetic queue request' }))
      .resolves.toEqual({ accepted: true, duplicate: true });
    expect(rpc.call.mock.calls.filter(([method]) => method === 'prompt.submit')).toHaveLength(0);
  });
});
