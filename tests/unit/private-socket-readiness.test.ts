import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, connect, type Server } from 'node:net';
import { chmod, lstat, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const barrier = vi.hoisted(() => ({ chmod: undefined as undefined | (() => Promise<void>) }));
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, chmod: async (...args: Parameters<typeof fs.chmod>) => {
    await barrier.chmod?.(); return fs.chmod(...args);
  } };
});
import { listenPrivateSocket } from '../../src/agent-browserd/private-socket.mjs';
const directories: string[] = [], servers: Server[] = [];
afterEach(async () => {
  barrier.chmod = undefined;
  await Promise.all(servers.splice(0).map(server => server.listening ? new Promise<void>(resolve => server.close(() => resolve())) : Promise.resolve()));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'private-uds-')); directories.push(directory);
  const server = createServer(socket => socket.end('ready')); servers.push(server);
  return { directory, server, path: join(directory, 'runtime.sock') };
}
async function reply(path: string) {
  return new Promise<string>((resolve, reject) => {
    const socket = connect(path); let value = '';
    socket.on('data', bytes => { value += bytes; }); socket.once('end', () => resolve(value)); socket.once('error', reject);
  });
}
describe('private Unix socket publication', () => {
  it('keeps the final path absent while chmod is delayed, then first publishes mode0600 and accepts connections', async () => {
    const f = await fixture(); let release!: () => void, entered!: () => void;
    const wait = new Promise<void>(resolve => { entered = resolve; });
    const pause = new Promise<void>(resolve => { release = resolve; });
    barrier.chmod = async () => { entered(); await pause; };
    const starting = listenPrivateSocket(f.server, f.path);
    await wait;
    try {
      await expect(lstat(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
      const [staging] = await readdir(f.directory);
      expect((await lstat(join(f.directory, staging))).mode & 0o777).toBe(0o700);
    } finally { release(); }
    await starting;
    const first = await lstat(f.path);
    expect(first.isSocket()).toBe(true); expect(first.mode & 0o777).toBe(0o600);
    expect(first.uid).toBe(process.getuid?.());
    expect(await reply(f.path)).toBe('ready');
    expect(await readdir(f.directory)).toEqual(['runtime.sock']);
  });
  it('rejects chmod failures, closes the listener and leaves no published or staging path', async () => {
    const f = await fixture(); barrier.chmod = async () => { throw new Error('synthetic chmod refusal'); };
    await expect(listenPrivateSocket(f.server, f.path)).rejects.toThrow('synthetic chmod refusal');
    expect(f.server.listening).toBe(false); expect(await readdir(f.directory)).toEqual([]);
  });
  it('never replaces a listener that appears during publication', async () => {
    const f = await fixture(), existing = createServer(socket => socket.end('original')); servers.push(existing);
    barrier.chmod = async () => { await new Promise<void>(resolve => existing.listen(f.path, resolve)); };
    await expect(listenPrivateSocket(f.server, f.path)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(f.server.listening).toBe(false); expect(await reply(f.path)).toBe('original');
    expect(await readdir(f.directory)).toEqual(['runtime.sock']);
  });
  it('removes its published socket on close and preserves a replacement at that pathname', async () => {
    const f = await fixture(); const cleanup = await listenPrivateSocket(f.server, f.path);
    await new Promise<void>(resolve => f.server.close(() => resolve()));
    await Promise.all([cleanup(), cleanup()]);
    expect(await readdir(f.directory)).toEqual([]);
    const cleanupReplacement = await listenPrivateSocket(f.server, f.path);
    await rm(f.path); await writeFile(f.path, 'replacement'); await chmod(f.path, 0o600);
    await new Promise<void>(resolve => f.server.close(() => resolve()));
    await cleanupReplacement();
    expect((await lstat(f.path)).isFile()).toBe(true);
    expect(await readdir(f.directory)).toEqual(['runtime.sock']);
  });
});

it('does not publish after startup cancellation and removes staging after the pending operation settles', async () => {
  const f = await fixture(), controller = new AbortController(); let release!: () => void, entered!: () => void;
  const wait = new Promise<void>(resolve => { entered = resolve; });
  const pause = new Promise<void>(resolve => { release = resolve; });
  barrier.chmod = async () => { entered(); await pause; };
  const starting = listenPrivateSocket(f.server, f.path, controller.signal).then(() => false, () => true);
  await wait; controller.abort(); release();
  expect(await starting).toBe(true);
  expect(f.server.listening).toBe(false); expect(await readdir(f.directory)).toEqual([]);
});

it('settles cancellation between bind and the listening event rather than hanging startup', async () => {
  const f = await fixture(), controller = new AbortController(), listen = f.server.listen;
  vi.spyOn(f.server, 'listen').mockImplementationOnce((...args) => {
    const result = Reflect.apply(listen, f.server, args); controller.abort(); return result;
  });
  await expect(listenPrivateSocket(f.server, f.path, controller.signal)).rejects.toBeDefined();
  expect(f.server.listening).toBe(false); expect(await readdir(f.directory)).toEqual([]);
});
