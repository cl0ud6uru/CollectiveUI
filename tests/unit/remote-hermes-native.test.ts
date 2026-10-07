import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type ClientOptions } from 'ws';
import type { RequestOptions } from 'node:http';
import { DashboardSocket } from '@/lib/remote-hermes/socket';
import { answerFor, promptView, sessionView } from '@/lib/remote-hermes/view';

const resources: (() => void)[] = [];
afterEach(() => { resources.splice(0).reverse().forEach(close => close()); });
async function fixture() {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>(resolve => server.once('listening', resolve));
  resources.push(() => { server.clients.forEach(c => c.terminate()); server.close(); });
  const address = server.address(); if (typeof address !== 'object' || !address) throw new Error('Missing address');
  return { server, url: new URL(`ws://127.0.0.1:${address.port}`) };
}
const ready = JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: {} } });
describe('native Hermes socket', () => {
  it('pins the WebSocket upgrade to the validated address instead of resolving the URL host again', async () => {
    const { server, url } = await fixture(); url.hostname = 'dashboard.example.invalid';
    const lookup = vi.fn<NonNullable<RequestOptions['lookup']>>((_host, _options, callback) => callback(null, '127.0.0.1', 4));
    const options: ClientOptions & Pick<RequestOptions, 'lookup'> = { lookup, family: 4 };
    server.on('connection', ws => { ws.send(ready); ws.on('message', raw => ws.send(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(String(raw)).id, result: { server_requests: ['approval'] } }))); });
    const socket = new DashboardSocket(async () => ({ url, options }), () => {}); resources.push(() => socket.close());
    await socket.connect(); expect(socket.state).toBe('connected'); expect(lookup).toHaveBeenCalledOnce();
  });
  it('waits for native readiness, negotiates interactions and routes server requests separately from replies', async () => {
    const { server, url } = await fixture(); const frames = vi.fn(); const methods: string[] = [];
    server.on('connection', ws => {
      ws.send(ready);
      ws.on('message', raw => {
        const input = JSON.parse(String(raw)); methods.push(input.method);
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: input.id, result: input.method === 'client.capabilities' ? { server_requests: ['approval', 'clarify', 'secret'] } : { session_id: 'runtime' } }));
        if (input.method === 'session.resume') ws.send(JSON.stringify({ jsonrpc: '2.0', id: 'ask-1', method: 'approval', params: { session_id: 'runtime', command: 'test' } }));
      });
    });
    const socket = new DashboardSocket(async () => ({ url, options: {} }), frames); resources.push(() => socket.close());
    expect(await socket.call('session.resume', { session_id: 'stored' })).toEqual({ session_id: 'runtime' });
    await vi.waitFor(() => expect(frames).toHaveBeenCalled());
    expect(methods).toEqual(['client.capabilities', 'session.resume']); expect(socket.state).toBe('connected');
    expect(frames.mock.calls[0][0]).toMatchObject({ id: 'ask-1', method: 'approval' });
  });
  it.each([false, true])('holds concurrent work behind capability negotiation (supported=%s)', async supported => {
    const { server, url } = await fixture(); const methods: string[] = [];
    let reply!: () => void;
    server.on('connection', ws => {
      ws.send(ready);
      ws.on('message', raw => {
        const input = JSON.parse(String(raw)); methods.push(input.method);
        if (input.method === 'client.capabilities') reply = () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: input.id, result: { server_requests: supported ? ['approval'] : [] } }));
        else ws.send(JSON.stringify({ jsonrpc: '2.0', id: input.id, result: { status: 'streaming' } }));
      });
    });
    const socket = new DashboardSocket(async () => ({ url, options: {} }), () => {}); resources.push(() => socket.close());
    const connection = socket.connect().then(() => null, error => error);
    await vi.waitFor(() => expect(reply).toBeTypeOf('function'));
    const prompt = socket.call('prompt.submit', { text: 'Synthetic only' }).then(value => value, error => error);
    // Flush callers while the server intentionally withholds its capabilities.
    await new Promise(resolve => setImmediate(resolve));
    expect(methods).toEqual(['client.capabilities']);
    reply();
    if (supported) { expect(await connection).toBeNull(); expect(await prompt).toEqual({ status: 'streaming' }); expect(methods).toEqual(['client.capabilities', 'prompt.submit']); }
    else { expect((await connection).message).toContain('does not support native approval'); expect((await prompt).message).toContain('does not support native approval'); expect(methods).toEqual(['client.capabilities']); }
  });
  it('reconnects and recovers through snapshots without replaying an uncertain prompt', async () => {
    const { server, url } = await fixture(); let submits = 0; let connections = 0; const recovered = vi.fn(async () => {});
    server.on('connection', ws => {
      connections++; ws.send(ready);
      ws.on('message', raw => {
        const input = JSON.parse(String(raw));
        if (input.method === 'prompt.submit') { submits++; ws.terminate(); return; }
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: input.id, result: { server_requests: ['approval'] } }));
      });
    });
    const socket = new DashboardSocket(async () => ({ url, options: {} }), () => {}, () => {}, recovered); resources.push(() => socket.close());
    await expect(socket.call('prompt.submit', { text: 'Only once' })).rejects.toThrow('may have been accepted');
    await vi.waitFor(() => expect(recovered).toHaveBeenCalledOnce(), { timeout: 2500 });
    expect(connections).toBe(2); expect(submits).toBe(1);
  });
  it('allows a warm recovery callback to join the refresh waiting on reconnection', async () => {
    const { server, url } = await fixture(); let active: import('ws').WebSocket;
    server.on('connection', ws => {
      active = ws; ws.send(ready);
      ws.on('message', raw => { const input = JSON.parse(String(raw)); ws.send(JSON.stringify({ jsonrpc: '2.0', id: input.id, result: input.method === 'client.capabilities' ? { server_requests: ['approval'] } : { session_id: 'runtime' } })); });
    });
    const recovery = vi.fn(async () => { await refresh; });
    const socket = new DashboardSocket(async () => ({ url, options: {} }), () => {}, () => {}, recovery); resources.push(() => socket.close());
    await socket.connect(); active!.terminate();
    await vi.waitFor(() => expect(socket.state).toBe('reconnecting'));
    const refresh = socket.call('session.resume', { session_id: 'stored' });
    await expect(refresh).resolves.toEqual({ session_id: 'runtime' });
    await vi.waitFor(() => expect(recovery).toHaveBeenCalledOnce());
  });
  it('fails closed on unsupported approvals without exposing credentials in socket errors', async () => {
    const { server, url } = await fixture(); url.searchParams.set('ticket', 'synthetic-private-ticket');
    server.on('connection', ws => { ws.send(ready); ws.on('message', raw => ws.send(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(String(raw)).id, result: { server_requests: [] } }))); });
    const socket = new DashboardSocket(async () => ({ url, options: {} }), () => {}); resources.push(() => socket.close());
    await expect(socket.connect()).rejects.toThrow('does not support native approval'); expect(socket.state).toBe('disconnected');
  });
  it('binds sensitive sends to a verified socket epoch and refuses reconnects or stale snapshots', async () => {
    const { server, url } = await fixture(); let active: import('ws').WebSocket; let connections = 0; const methods: string[] = [];
    server.on('connection', ws => { ++connections; active = ws; ws.send(ready); ws.on('message', raw => {
      const input = JSON.parse(String(raw)); methods.push(input.method); ws.send(JSON.stringify({ jsonrpc: '2.0', id: input.id, result: input.method === 'client.capabilities' ? { server_requests: ['approval'] } : { session_id: 'runtime' } }));
    }); });
    const socket = new DashboardSocket(async () => ({ url, options: {} }), () => {}); resources.push(() => socket.close());
    expect(() => socket.callConnected('config.set', {}, 1)).toThrow('verified Hermes connection changed'); expect(connections).toBe(0);
    const snapshot = await socket.callWithEpoch('session.resume', {}); expect(snapshot.epoch).toBe(socket.connectionEpoch);
    await socket.callConnected('config.set', { value: 'on' }, snapshot.epoch); expect(methods.filter(m => m === 'config.set')).toHaveLength(1);
    active!.terminate(); await vi.waitFor(() => expect(socket.state).toBe('reconnecting'));
    expect(() => socket.callConnected('config.set', {}, snapshot.epoch)).toThrow('verified Hermes connection changed');
    await socket.connect(); expect(connections).toBe(2);
    expect(() => socket.callConnected('config.set', {}, snapshot.epoch)).toThrow('verified Hermes connection changed'); expect(methods.filter(m => m === 'config.set')).toHaveLength(1);
  });
});
describe('native Hermes UI projections', () => {
  it('keeps an admitted queued message active between turns for disablement and recovery', () => {
    expect(sessionView('local', 'default', { running: false, queued: { user: 'Next admitted message' } }, 'connected').running).toBe(true);
  });
  it('projects messages and native context counters without replaying attachment bytes or secret metadata', () => {
    const snapshot = sessionView('local', 'default', { session_id: 'runtime', running: true, info: { model: 'model', usage: { input: 100, context_used: 200, context_max: 1000, cost_usd: 0.03, secret: 'not-visible' }, environment: { TOKEN: 'not-visible' } }, messages: [{ row_id: 1, role: 'user', text: 'Old prompt', timestamp: 1, content: 'data:image/png;base64,not-visible' }], turn_started_at: 100, inflight: { user: 'New prompt', assistant: 'Partial' } }, 'connected');
    expect(snapshot.messages.map(m => m.text)).toEqual(['Old prompt', 'New prompt']); expect(snapshot.partial).toBe('Partial');
    expect(snapshot.usage).toEqual({ input: 100, context_used: 200, context_max: 1000, cost_usd: 0.03 });
    expect(JSON.stringify(snapshot)).not.toContain('not-visible');
  });
  it('uses native clarification qids and rejects cross-question answers', () => {
    const prompt = promptView('ask', 'clarify', { session_id: 'runtime', questions: [{ qid: 'q1', question: 'Which?', choices: ['One', 'Two'] }] })!;
    expect(prompt.questions[0].id).toBe('q1'); expect(answerFor(prompt, { answers: { q1: 'One' } })).toEqual({ answers: { q1: 'One' } });
    expect(() => answerFor(prompt, { answers: { other: 'No' } })).toThrow();
  });
  it('permits only single-use approvals and validates protected values separately from transcripts', () => {
    const approval = promptView(5, 'approval', { command: 'run', secret: 'not-visible' })!;
    expect(() => answerFor(approval, { choice: 'always' })).toThrow(); expect(answerFor(approval, { choice: 'deny' })).toEqual({ choice: 'deny' });
    const secret = promptView('secret', 'secret', { env_var: 'KEY', prompt: 'Enter value', value: 'not-visible' })!;
    expect(JSON.stringify(secret)).not.toContain('not-visible'); expect(answerFor(secret, { value: 'synthetic-secret' })).toEqual({ value: 'synthetic-secret' });
    expect(promptView('desktop', 'window.read', {})).toBeNull();
  });
});
