import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const f = vi.hoisted(() => ({ row: {} as Record<string, unknown>, receipts: [] as Record<string, unknown>[], call: vi.fn(), frame: (_frame: unknown) => { void _frame; }, lock: Promise.resolve() }));
vi.mock('@/lib/settings', () => ({ getSetting: async () => ({ enabled: true, privateGateways: [] }) }));
vi.mock('@/lib/remote-hermes/store', () => ({ remoteAccess: vi.fn() }));
vi.mock('@/lib/remote-hermes/socket', async original => {
  const actual = await original<typeof import('@/lib/remote-hermes/socket')>();
  return { ...actual, DashboardSocket: class { state = 'connected'; call = f.call; callWithEpoch = async (...args: unknown[]) => ({ result: await f.call(...args), epoch: 1 }); constructor(_target: unknown, frame: (value: unknown) => void) { f.frame = frame; } close() {} } };
});
vi.mock('@/db', () => {
  const dialect = new PgDialect();
  const query = (condition: unknown) => dialect.sqlToQuery(condition as Parameters<PgDialect['sqlToQuery']>[0]);
  const matches = (condition: unknown) => {
    const { sql, params } = query(condition);
    return [...sql.matchAll(/"(id|status|queue_request_id|admission_request_id)" (=|<>) \$(\d+)/g)].every(([, column, operator, index]) => {
      const value = f.row[column === 'queue_request_id' ? 'queueRequestId' : column === 'admission_request_id' ? 'admissionRequestId' : column];
      return operator === '=' ? value === params[Number(index) - 1] : value !== params[Number(index) - 1];
    });
  };
  const selection = (table: { [key: symbol]: unknown }, condition: unknown) => {
    const name = table[Symbol.for('drizzle:Name')];
    if (name === 'settings') return [];
    if (name === 'remote_hermes_turns') return f.receipts.filter(r => query(condition).params.includes(r.requestId));
    return matches(condition) ? [{ ...f.row }] : [];
  };
  const mock = {
    select: () => ({ from: (table: { [key: symbol]: unknown }) => ({
      innerJoin: () => ({ where: async () => [{ session: { ...f.row } }] }),
      where: (condition: unknown) => Object.assign(Promise.resolve(selection(table, condition)), { for: async () => selection(table, condition) }),
    }) }),
    update: () => ({ set: (values: Record<string, unknown>) => ({ where: (condition: unknown) => {
      const result = Promise.resolve().then(() => {
        if (!matches(condition)) return [];
        const next = { ...values };
        if (typeof next.revision === 'object') next.revision = Number(f.row.revision) + 1;
        Object.assign(f.row, next); return [{ ...f.row }];
      });
      return Object.assign(result, { returning: () => result });
    } }) }),
    insert: () => ({ values: async (values: Record<string, unknown>) => { f.receipts.push(values); } }),
  };
  return { db: { ...mock, transaction: async (run: (tx: unknown) => Promise<unknown>) => {
    // Model the per-session FOR UPDATE lock. Real PostgreSQL coverage is separate.
    const previous = f.lock; let release!: () => void;
    f.lock = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await run(mock); } finally { release(); }
  } } };
});
import { nativeSnapshot, submitNativePrompt, nativeControl } from '@/lib/remote-hermes/sessions';
import { nativeHub } from '@/lib/remote-hermes/hub';
import { NativeRpcError } from '@/lib/remote-hermes/socket';
const id1 = '9fd64d53-084f-4898-96e0-59ea8fdc623f', id2 = 'af63e18c-0581-44c5-8654-8f226b2660a8';
const idle = { session_id: 'runtime', stored_session_id: 'stored', running: false, info: { title: 'Synthetic' }, messages: [] };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
beforeEach(() => {
  vi.clearAllMocks(); f.receipts = []; f.lock = Promise.resolve();
  f.row = { id: 'session', connectionId: 'connection', profile: 'default', storedId: 'stored', runtimeId: null, status: 'idle', revision: 0, queueRequestId: null, queueStatus: null };
  f.call.mockImplementation(async (method: string) => method === 'session.resume' ? idle : { status: 'streaming' });
});
afterEach(() => { nativeHub('owner', 'connection').close(); });

it('single-flights cold snapshots and keeps staged admission closed to a second prompt', async () => {
  const resume = deferred<unknown>(), upload = deferred<unknown>();
  f.call.mockImplementation((method: string) => method === 'session.resume' ? resume.promise : method === 'image.attach_bytes' ? upload.promise : Promise.resolve({ status: 'streaming' }));
  const snapshot = nativeSnapshot('owner', 'connection', 'session');
  await vi.waitFor(() => expect(f.call).toHaveBeenCalledOnce());
  const first = submitNativePrompt('owner', 'connection', 'session', id1, 'First', [{ name: 'synthetic.png', type: 'image/png', bytes: Buffer.from('synthetic') }]);
  resume.resolve(idle); await snapshot;
  await vi.waitFor(() => expect(f.row.status).toBe('admitting'));
  await expect(submitNativePrompt('owner', 'connection', 'session', id2, 'Second')).rejects.toThrow('Finish or stop');
  expect(f.receipts).toHaveLength(1);
  upload.resolve({ attached: true, path: '/synthetic/image' }); await first;
  expect(f.call.mock.calls.filter(c => c[0] === 'prompt.submit')).toHaveLength(1);
});

it('does not let an older warm snapshot overwrite a newer durable admission', async () => {
  const hub = nativeHub('owner', 'connection'); await hub.refresh(f.row as never);
  const resume = deferred<unknown>(); f.call.mockReturnValueOnce(resume.promise);
  const refresh = hub.refresh(f.row as never);
  await vi.waitFor(() => expect(f.call).toHaveBeenCalledTimes(2));
  // Another process commits after this snapshot started.
  Object.assign(f.row, { status: 'admitting', revision: Number(f.row.revision) + 1 });
  resume.resolve(idle); expect((await refresh).uncertain).toBe(true);
  expect(f.row.status).toBe('admitting');
  await expect(submitNativePrompt('owner', 'connection', 'session', id2, 'Second')).rejects.toThrow('Finish or stop');
});

it('releases a command rejected by both optional methods and retains its no-replay receipt', async () => {
  f.call.mockImplementation(async (method: string) => { if (method === 'session.resume') return idle; if (method === 'commands.catalog') return { pairs: [['/help', 'Help']] }; throw new NativeRpcError(-32601); });
  await expect(nativeControl('owner', 'connection', 'session', 'command', { requestId: id1, text: '/help' })).rejects.toThrow('does not support');
  expect(f.row.status).toBe('idle'); expect(f.receipts).toHaveLength(1);
  expect(await nativeControl('owner', 'connection', 'session', 'command', { requestId: id1, text: '/help' })).toHaveProperty('output');
  expect(f.call.mock.calls.filter(c => ['slash.exec', 'command.dispatch'].includes(c[0]))).toHaveLength(2);
  f.call.mockImplementation(async (method: string) => method === 'session.resume' ? idle : { status: 'streaming' });
  await expect(submitNativePrompt('owner', 'connection', 'session', id2, 'Next prompt')).resolves.toEqual({ accepted: true, duplicate: false });
});

it('keeps an ambiguous command result uncertain and never falls back or replays it', async () => {
  f.call.mockImplementation(async (method: string) => { if (method === 'session.resume') return idle; if (method === 'commands.catalog') return { pairs: [['/compress', 'Compress']] }; throw new Error('Lost acknowledgement'); });
  await expect(nativeControl('owner', 'connection', 'session', 'command', { requestId: id1, text: '/compress' })).rejects.toThrow('Lost acknowledgement');
  expect(f.row.status).toBe('uncertain');
  await nativeControl('owner', 'connection', 'session', 'command', { requestId: id1, text: '/compress' });
  expect(f.call.mock.calls.filter(c => c[0] === 'slash.exec')).toHaveLength(1);
  expect(f.call.mock.calls.filter(c => c[0] === 'command.dispatch')).toHaveLength(0);
  await expect(submitNativePrompt('owner', 'connection', 'session', id2, 'Next')).rejects.toThrow('Finish or stop');
});

it('atomically reserves one queue slot before either concurrent RPC acknowledgement', async () => {
  f.row.status = 'running'; const acknowledgement = deferred<unknown>();
  f.call.mockImplementation((method: string) => method === 'session.resume' ? Promise.resolve({ ...idle, running: true }) : acknowledgement.promise);
  const a = nativeControl('owner', 'connection', 'session', 'queue', { requestId: id1, text: 'Queued A' });
  const b = nativeControl('owner', 'connection', 'session', 'queue', { requestId: id2, text: 'Queued B' }).then(() => null, error => error);
  await vi.waitFor(() => expect(f.call.mock.calls.filter(c => c[0] === 'prompt.submit')).toHaveLength(1));
  expect((await b).status).toBe(409); expect(f.receipts).toHaveLength(1); expect(f.row.queueStatus).toBe('admitting');
  expect(await nativeControl('owner', 'connection', 'session', 'queue', { requestId: id1, text: 'Queued A' })).toEqual({ accepted: true, duplicate: true });
  acknowledgement.resolve({ status: 'queued' }); await a;
  expect(f.row.queueStatus).toBe('queued');
});

it('retains an uncertain queue reservation through idle recovery and releases acknowledged consumption', async () => {
  f.row.status = 'running';
  f.call.mockImplementation(async (method: string) => { if (method === 'session.resume') return { ...idle, running: true }; throw new Error('Lost acknowledgement'); });
  await expect(nativeControl('owner', 'connection', 'session', 'queue', { requestId: id1, text: 'Queued A' })).rejects.toThrow('Lost acknowledgement');
  expect(f.row.queueStatus).toBe('uncertain');
  f.call.mockResolvedValue(idle);
  const hub = nativeHub('owner', 'connection'); expect((await hub.refresh(f.row as never)).queuePending).toBe(true);
  await expect(nativeControl('owner', 'connection', 'session', 'queue', { requestId: id2, text: 'Queued B' })).rejects.toThrow('unfinished');
  f.call.mockResolvedValue({ ...idle, queued: { user: 'Queued A' } }); await hub.refresh(f.row as never);
  expect(f.row.queueStatus).toBe('queued');
  f.call.mockResolvedValue(idle); expect((await hub.refresh(f.row as never)).queuePending).toBe(false);
  expect(f.row.queueRequestId).toBeNull();
});


it('clears prompt uncertainty when a native start event arrives before the acknowledgement', async () => {
  const ack = deferred<unknown>();
  f.call.mockImplementation((method: string) => method === 'session.resume' ? Promise.resolve(idle) : ack.promise);
  const submit = submitNativePrompt('owner', 'connection', 'session', id1, 'Synthetic');
  await vi.waitFor(() => expect(f.row.status).toBe('admitting'));
  f.frame({ jsonrpc: '2.0', method: 'event', params: { session_id: 'runtime', type: 'message.start', payload: {} } });
  await vi.waitFor(() => expect(f.row.status).toBe('running'));
  ack.resolve({ status: 'streaming' }); await submit;
  expect(nativeHub('owner', 'connection').sessions.get('session')!.view.uncertain).toBe(false);
});
