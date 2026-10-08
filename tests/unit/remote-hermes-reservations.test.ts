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
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: Error) => void; const promise = new Promise<T>((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; }
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

it.each([
  ['image.png', 'image/png', 'image.attach_bytes'],
  ['document.pdf', 'application/pdf', 'pdf.attach'],
  ['notes.txt', 'text/plain', 'file.attach'],
])('releases a rejected %s before prompt dispatch without deleting its receipt', async (name, type, method) => {
  f.call.mockImplementation(async (rpc: string) => rpc === 'session.resume' ? idle : { attached: false });
  const uploads = [{ name, type, bytes: Buffer.from('synthetic') }];
  await expect(submitNativePrompt('owner', 'connection', 'session', id1, 'First', uploads)).rejects.toThrow('No prompt was sent');
  expect(f.call.mock.calls.filter(c => c[0] === method)).toHaveLength(1);
  expect(f.call.mock.calls.some(c => c[0] === 'prompt.submit')).toBe(false);
  expect(f.row).toMatchObject({ status: 'idle', admissionRequestId: null });
  expect(f.receipts).toHaveLength(1);
  expect(nativeHub('owner', 'connection').sessions.get('session')!.view.uncertain).toBe(false);
  await expect(submitNativePrompt('owner', 'connection', 'session', id1, 'First', uploads)).resolves.toEqual({ accepted: true, duplicate: true });
  f.call.mockImplementation(async (rpc: string) => rpc === 'session.resume' ? idle : { status: 'streaming' });
  await expect(submitNativePrompt('owner', 'connection', 'session', id2, 'Next')).resolves.toEqual({ accepted: true, duplicate: false });
});

it('releases a prompt rejected by method-not-found and retains its receipt', async () => {
  f.call.mockImplementation(async (method: string) => { if (method === 'session.resume') return idle; throw new NativeRpcError(-32601); });
  await expect(submitNativePrompt('owner', 'connection', 'session', id1, 'First')).rejects.toThrow('does not support');
  expect(f.row).toMatchObject({ status: 'idle', admissionRequestId: null });
  expect(await submitNativePrompt('owner', 'connection', 'session', id1, 'First')).toEqual({ accepted: true, duplicate: true });
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

it.each(['stop', 'command'] as const)('reconciles native evidence after %s without treating interrupt as proof', async operation => {
  Object.assign(f.row, { status: 'running', admissionRequestId: id1, queueRequestId: id2, queueStatus: 'queued' });
  let interrupted = false;
  f.call.mockImplementation(async (method: string) => {
    if (method === 'session.resume') return interrupted ? idle : { ...idle, running: true, queued: { user: 'Next' } };
    if (method === 'commands.catalog') return { pairs: [['/stop', 'Stop']] };
    if (method === 'session.interrupt') { interrupted = true; return { status: 'interrupted' }; }
    throw new Error(`Unexpected ${method}`);
  });
  await nativeControl('owner', 'connection', 'session', operation, operation === 'command' ? { text: '/stop' } : {});
  expect(f.row).toMatchObject({ status: 'idle', admissionRequestId: null, queueRequestId: null, queueStatus: null });
  expect(f.call.mock.calls.filter(c => c[0] === 'session.resume')).toHaveLength(2);
});

it.each((['stop', 'command'] as const).flatMap(operation =>
  (['success', 'lost interrupt reply', 'fresh snapshot failure', 'older snapshot failure'] as const).map(outcome => [operation, outcome] as const),
))('waits for a concurrent pre-interrupt resume before fresh %s reconciliation (%s)', async (operation, outcome) => {
  Object.assign(f.row, { status: 'running', admissionRequestId: id1, queueRequestId: id2, queueStatus: 'queued' });
  const interrupt = deferred<unknown>(), stale = deferred<unknown>(), fresh = deferred<unknown>();
  let resumes = 0, settled = false;
  const running = { ...idle, running: true, queued: { user: 'Next' } };
  f.call.mockImplementation((method: string) => {
    if (method === 'commands.catalog') return Promise.resolve({ pairs: [['/stop', 'Stop']] });
    if (method === 'session.interrupt') return interrupt.promise;
    if (method === 'session.resume') {
      resumes++;
      if (resumes === 1) return Promise.resolve(running);
      if (resumes === 2) return stale.promise;
      expect(settled).toBe(true);
      return fresh.promise;
    }
    throw new Error(`Unexpected ${method}`);
  });
  let finished = false;
  const stop = nativeControl('owner', 'connection', 'session', operation, operation === 'command' ? { text: '/stop' } : {}).then(
    value => { finished = true; return { value, error: null }; },
    error => { finished = true; return { value: null, error }; },
  );
  await vi.waitFor(() => expect(f.call.mock.calls.some(c => c[0] === 'session.interrupt')).toBe(true));
  const hub = nativeHub('owner', 'connection');
  const concurrent = hub.refresh(f.row as never).catch((error: unknown) => error);
  await vi.waitFor(() => expect(resumes).toBe(2));
  expect(settled).toBe(false);
  settled = true;
  if (outcome === 'lost interrupt reply') interrupt.reject(new Error('Lost interrupt reply'));
  else interrupt.resolve({ status: 'interrupted' });
  await Promise.resolve();
  expect(resumes).toBe(2); // Never overlap resumes or reset the single-flight slot.
  if (outcome === 'older snapshot failure') stale.reject(new Error('Older snapshot failed'));
  else stale.resolve(running);
  await concurrent;
  await vi.waitFor(() => expect(resumes).toBe(3));
  expect(finished).toBe(false);
  expect(f.row.queueRequestId).toBe(id2);
  if (outcome === 'fresh snapshot failure') fresh.reject(new Error('Fresh snapshot failed'));
  else fresh.resolve(idle);
  const result = await stop;
  if (outcome === 'lost interrupt reply') expect(result.error).toHaveProperty('message', 'Lost interrupt reply');
  else expect(result.error).toBeNull();
  if (outcome === 'fresh snapshot failure') {
    expect(result.value).toMatchObject({ status: 'interrupted' });
    expect(f.row).toMatchObject({ status: 'running', admissionRequestId: id1, queueRequestId: id2, queueStatus: 'queued' });
    expect(hub.sessions.get('session')!.view).toMatchObject({ running: true, queuePending: true, uncertain: true });
  } else {
    expect(f.row).toMatchObject({ status: 'idle', admissionRequestId: null, queueRequestId: null, queueStatus: null });
    expect(hub.sessions.get('session')!.view).toMatchObject({ running: false, queuePending: false, uncertain: false });
  }
  expect(f.receipts).toHaveLength(0);
  expect(f.call.mock.calls.filter(c => c[0] === 'session.interrupt')).toHaveLength(1);
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


it.each(['image/png', 'application/pdf', 'text/plain'])('releases upload-only transport failure (%s) while preserving the no-replay receipt', async type => {
  f.call.mockImplementation(async (method: string) => { if (method === 'session.resume') return idle; throw new Error('Upload acknowledgement lost'); });
  const uploads = [{ name: 'fixture', type, bytes: Buffer.from('synthetic') }];
  await expect(submitNativePrompt('owner', 'connection', 'session', id1, 'First', uploads)).rejects.toThrow('Upload acknowledgement lost');
  expect(f.row).toMatchObject({ status: 'idle', admissionRequestId: null, admissionAt: null });
  nativeHub('owner', 'connection').close();
  expect((await nativeSnapshot('owner', 'connection', 'session')).uncertain).toBe(false);
  await submitNativePrompt('owner', 'connection', 'session', id1, 'First', uploads);
  expect(f.call.mock.calls.some(c => c[0] === 'prompt.submit')).toBe(false);
});

it('cleans up staged image paths after a later rejection even if detach fails', async () => {
  f.call.mockImplementation(async (method: string) => {
    if (method === 'session.resume') return idle;
    if (method === 'image.attach_bytes') return { attached: true, path: '/fixture/image' };
    if (method === 'file.attach') return { attached: false };
    throw new Error('Detach failed');
  });
  await expect(submitNativePrompt('owner', 'connection', 'session', id1, 'First', [
    { name: 'image.png', type: 'image/png', bytes: Buffer.from('synthetic') },
    { name: 'notes.txt', type: 'text/plain', bytes: Buffer.from('synthetic') },
  ])).rejects.toThrow('No prompt was sent');
  expect(f.call).toHaveBeenCalledWith('image.detach', { session_id: 'runtime', profile: 'default', path: '/fixture/image' });
  expect(f.row.status).toBe('idle');
  expect(f.call.mock.calls.some(c => c[0] === 'prompt.submit')).toBe(false);
});

it.each([new Error('Lost prompt acknowledgement'), new NativeRpcError(4018)])('keeps ambiguous prompt outcomes closed across reload and stop (%s)', async error => {
  f.call.mockImplementation(async (method: string) => { if (method === 'session.resume') return idle; throw error; });
  await expect(submitNativePrompt('owner', 'connection', 'session', id1, 'First')).rejects.toThrow();
  expect(f.row.status).toBe('uncertain');
  nativeHub('owner', 'connection').close();
  f.call.mockResolvedValue(idle);
  expect(await nativeSnapshot('owner', 'connection', 'session')).toMatchObject({ uncertain: true });
  await nativeControl('owner', 'connection', 'session', 'stop');
  expect(f.row.status).toBe('uncertain');
  expect(await submitNativePrompt('owner', 'connection', 'session', id1, 'First')).toEqual({ accepted: true, duplicate: true });
  await expect(submitNativePrompt('owner', 'connection', 'session', id2, 'Next')).rejects.toThrow('Finish or stop');
  // Native running evidence confirms admission; a subsequent idle snapshot settles it.
  f.call.mockResolvedValue({ ...idle, running: true });
  expect((await nativeHub('owner', 'connection').refresh(f.row as never)).uncertain).toBe(false);
  f.call.mockResolvedValue(idle);
  expect((await nativeHub('owner', 'connection').refresh(f.row as never)).running).toBe(false);
  expect(f.row).toMatchObject({ status: 'idle', admissionRequestId: null });
  expect(f.call.mock.calls.filter(c => c[0] === 'prompt.submit')).toHaveLength(1);
});

it('preserves unseen queue reservations across reload, completion and stop', async () => {
  Object.assign(f.row, { status: 'running', queueRequestId: id1, queueStatus: 'uncertain' });
  nativeHub('owner', 'connection').close();
  expect(await nativeSnapshot('owner', 'connection', 'session')).toMatchObject({ uncertain: true, queuePending: true });
  f.frame({ method: 'event', params: { session_id: 'runtime', type: 'message.complete', payload: {} } });
  await nativeControl('owner', 'connection', 'session', 'stop');
  expect(f.row).toMatchObject({ queueRequestId: id1, queueStatus: 'uncertain' });
  expect(nativeHub('owner', 'connection').sessions.get('session')!.view.queuePending).toBe(true);
});

it('ignores a late queue acknowledgement after native evidence consumes its reservation', async () => {
  f.row.status = 'running'; const ackA = deferred<unknown>(), ackB = deferred<unknown>();
  f.call.mockImplementation((method: string) => method === 'session.resume' ? Promise.resolve({ ...idle, running: true }) : ackA.promise);
  const a = nativeControl('owner', 'connection', 'session', 'queue', { requestId: id1, text: 'Queue A' });
  await vi.waitFor(() => expect(f.row.queueRequestId).toBe(id1));
  const hub = nativeHub('owner', 'connection');
  f.call.mockResolvedValue({ ...idle, running: true, queued: { user: 'Queue A' } }); await hub.refresh(f.row as never);
  f.call.mockImplementation((method: string) => method === 'session.resume' ? Promise.resolve({ ...idle, running: true }) : ackB.promise);
  await hub.refresh(f.row as never);
  const b = nativeControl('owner', 'connection', 'session', 'queue', { requestId: id2, text: 'Queue B' });
  await vi.waitFor(() => expect(f.row.queueRequestId).toBe(id2));
  ackA.resolve({ status: 'queued' }); await a;
  expect(f.row).toMatchObject({ queueRequestId: id2, queueStatus: 'admitting' });
  expect(hub.sessions.get('session')!.view.queued).not.toBe('Queue A');
  ackB.resolve({ status: 'queued' }); await b;
  expect(hub.sessions.get('session')!.view.queued).toBe('Queue B');
});

it('reconciles after a lost interrupt reply without hiding the transport error', async () => {
  f.row.status = 'running'; let interrupted = false;
  f.call.mockImplementation(async (method: string) => {
    if (method === 'session.resume') return interrupted ? idle : { ...idle, running: true };
    interrupted = true; throw new Error('Lost interrupt reply');
  });
  await expect(nativeControl('owner', 'connection', 'session', 'stop')).rejects.toThrow('Lost interrupt reply');
  expect(f.row.status).toBe('idle');
});

it('does not release a different admission when a staged upload fails late', async () => {
  const upload = deferred<unknown>();
  f.call.mockImplementation((method: string) => method === 'session.resume' ? Promise.resolve(idle) : upload.promise);
  const first = submitNativePrompt('owner', 'connection', 'session', id1, 'First', [{ name: 'image.png', type: 'image/png', bytes: Buffer.from('synthetic') }]);
  await vi.waitFor(() => expect(f.row.admissionRequestId).toBe(id1));
  // Simulate another process's native reconciliation followed by a newer admission.
  Object.assign(f.row, { admissionRequestId: id2, status: 'admitting', revision: Number(f.row.revision) + 1 });
  upload.resolve({ attached: false });
  await expect(first).rejects.toThrow('No prompt was sent');
  expect(f.row).toMatchObject({ admissionRequestId: id2, status: 'admitting' });
  expect(f.call.mock.calls.some(c => c[0] === 'prompt.submit')).toBe(false);
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
