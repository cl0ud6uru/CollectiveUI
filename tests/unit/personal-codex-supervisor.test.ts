import { EventEmitter } from 'node:events';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

class Child extends EventEmitter {
  exitCode: number | null = null;
  signalCode: string | null = null;
  kill = vi.fn();
  constructor(readonly pid: number) { super(); }
  exit(code = 0) { this.exitCode = code; this.emit('exit', code, null); }
  close() { this.emit('close', this.exitCode, this.signalCode); }
}

class Socket extends EventEmitter {
  end = vi.fn();
  destroy = vi.fn();
}

async function supervisor(mode = '') {
  const children: Child[] = [];
  const signals = new EventEmitter();
  const exit = vi.fn(), kill = vi.fn();
  const spawn = vi.fn<(file: string, args: string[], options: { env: Record<string, string> }) => Child>(() => {
    const child = new Child(19 + children.length * 40);
    children.push(child);
    return child;
  });
  const readdir = vi.fn<() => Promise<string[]>>().mockResolvedValue([]);
  let accept: (socket: Socket) => void;
  const server = { listen: vi.fn((_path: string, ready: () => void) => ready()), close: vi.fn((done: () => void) => done()) };
  const source = (await readFile('docker/personal-codex/server.mjs', 'utf8')).replace(/^import [^\n]*;$/gm, '');
  // Execute the real wrapper with controlled process/socket dependencies. No
  // Codex binary, filesystem permissions, credentials or live endpoints are used.
  await new Script(`(async () => {\n${source}\n})()`, { filename: 'server.mjs' }).runInNewContext({
    spawn, createHash, timingSafeEqual, Buffer, setTimeout,
    process: { argv: ['node', 'server.mjs', ...(mode ? [mode] : [])], platform: 'linux', env: { PATH: '/usr/bin', HOME: '/codex-home', CODEX_HOME: '/codex-home' },
      getuid: () => 10001, exit, kill, on: signals.on.bind(signals) },
    chmodSync: vi.fn(), unlinkSync: vi.fn(), lstatSync: () => { throw new Error('absent'); }, prepareWorkspace: vi.fn(),
    readdir, readFile: vi.fn(),
    createServer: (_options: unknown, listener: (socket: Socket) => void) => { accept = listener; return server; },
  });
  const request = (token?: string) => {
    const socket = new Socket();
    accept(socket);
    const body = token === undefined ? { clear: true } : { accessToken: token, credentialBinding: createHash('sha256').update(token).digest('hex') };
    socket.emit('data', Buffer.from(JSON.stringify(body)));
    socket.emit('end');
    return socket;
  };
  return { children, signals, exit, kill, spawn, readdir, server, request };
}

describe('stock Codex child rotation', () => {
  it('waits for Node exit and close after the process group disappears, then ignores an old exit/error callback', async () => {
    const runtime = await supervisor();
    const prior = runtime.children[0];
    const delayedExit = prior.listeners('exit')[0];
    const delayedError = prior.listeners('error')[0];
    const socket = runtime.request('synthetic-rotation-token');
    await vi.waitFor(() => expect(runtime.readdir).toHaveBeenCalled());
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(runtime.spawn).toHaveBeenCalledTimes(1);
    expect(socket.end).not.toHaveBeenCalled();
    const overlapping = runtime.request('synthetic-overlapping-token');
    await vi.waitFor(() => expect(overlapping.destroy).toHaveBeenCalledTimes(1));
    expect(overlapping.end).not.toHaveBeenCalled();

    prior.exit();
    await Promise.resolve();
    expect(runtime.spawn).toHaveBeenCalledTimes(1);
    prior.close();
    await vi.waitFor(() => expect(socket.end).toHaveBeenCalledWith('ok'));
    expect(runtime.spawn).toHaveBeenCalledTimes(2);
    expect(runtime.spawn.mock.calls[1][2].env.ACCESS_TOKEN).toBe('synthetic-rotation-token');

    // Reproduce the VM diagnostic's stale callback after a replacement is live.
    delayedExit(0);
    delayedError(new Error('retired child'));
    expect(runtime.exit).not.toHaveBeenCalled();
    runtime.children[1].exit(7);
    expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(7);
  });

  it('waits for the whole process group even when Node closes first', async () => {
    const runtime = await supervisor();
    let release!: (entries: string[]) => void;
    runtime.readdir.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const prior = runtime.children[0], socket = runtime.request('synthetic-rotation-token');
    prior.exit(); prior.close();
    expect(socket.end).not.toHaveBeenCalled();
    expect(runtime.spawn).toHaveBeenCalledTimes(1);
    release([]);
    await vi.waitFor(() => expect(socket.end).toHaveBeenCalledWith('ok'));
    expect(runtime.kill).toHaveBeenCalledWith(-prior.pid, 'SIGTERM');
    expect(runtime.spawn).toHaveBeenCalledTimes(2);
  });

  it('keeps the current child and token binding across repeated sync and clear rotations', async () => {
    const runtime = await supervisor();
    for (const token of ['synthetic-first-token', 'synthetic-second-token', undefined]) {
      const prior = runtime.children.at(-1)!;
      const delayedExit = prior.listeners('exit')[0];
      const socket = runtime.request(token);
      prior.exit(); prior.close();
      await vi.waitFor(() => expect(socket.end).toHaveBeenCalledWith('ok'));
      delayedExit(0);
      expect(runtime.exit).not.toHaveBeenCalled();
      const call = runtime.spawn.mock.calls.at(-1)!;
      expect(call[2].env.ACCESS_TOKEN).toBe(token);
      expect(call[1]).toContain(token ? 'model_provider="openai_chatgpt_plan"' : 'model_provider="openai"');
    }
    expect(runtime.spawn).toHaveBeenCalledTimes(4);
  });

  it('does not start a replacement if shutdown arrives during rotation', async () => {
    const runtime = await supervisor();
    const socket = runtime.request('synthetic-rotation-token');
    runtime.signals.emit('SIGTERM');
    runtime.children[0].exit(); runtime.children[0].close();
    await vi.waitFor(() => expect(socket.end).toHaveBeenCalledWith('ok'));
    expect(runtime.server.close).toHaveBeenCalledTimes(1);
    expect(runtime.spawn).toHaveBeenCalledTimes(1);
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it('does not replace or acknowledge a token when process-group inspection fails', async () => {
    const runtime = await supervisor();
    runtime.readdir.mockRejectedValueOnce(new Error('process-group inspection unavailable'));
    const socket = runtime.request('synthetic-rotation-token');
    await vi.waitFor(() => expect(socket.destroy).toHaveBeenCalledTimes(1));
    expect(socket.end).not.toHaveBeenCalled();
    expect(runtime.spawn).toHaveBeenCalledTimes(1);
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it.each([0, 9, null])('preserves wrapper termination for an unexpected current child exit (%s)', async code => {
    const runtime = await supervisor();
    runtime.children[0].emit('exit', code, null);
    expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(code ?? 1);
  });

  it('preserves failure for the current child spawn error', async () => {
    const runtime = await supervisor();
    runtime.children[0].emit('error', new Error('spawn failed'));
    expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('signals the current inherited-stdio child during shutdown', async () => {
    const runtime = await supervisor('--stdio');
    expect(runtime.spawn.mock.calls[0][2]).toMatchObject({ stdio: 'inherit', detached: false });
    runtime.signals.emit('SIGTERM');
    expect(runtime.children[0].kill).toHaveBeenCalledWith('SIGTERM');
    runtime.children[0].exit(); runtime.children[0].close();
    expect(runtime.exit).not.toHaveBeenCalled();
  });
});
