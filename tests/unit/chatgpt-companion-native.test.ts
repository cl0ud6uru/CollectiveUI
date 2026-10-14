import { afterAll, beforeAll, afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, realpath, rm, stat, symlink, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MacProtectedStore } from '@/chatgpt-companion/storage';
let helper: string;
let compilationRoot: string | undefined;
const exec = promisify(execFile);
const dirs: string[] = [], stores: MacProtectedStore[] = [];
afterEach(async () => { for (const s of stores.splice(0)) s.close(); for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
const store = (root: string) => { const s = new MacProtectedStore(helper, root); stores.push(s); return s; };
async function fixture() { const dir = await realpath(await mkdtemp(join(tmpdir(), 'mac-companion-'))); dirs.push(dir); return { dir, root: join(dir, 'private') }; }
describe.skipIf(process.platform !== 'darwin')('native descriptor storage without GUI', () => {
  beforeAll(async () => {
    compilationRoot = await realpath(await mkdtemp(join(tmpdir(), 'mac-companion-compile-')));
    helper = join(compilationRoot, 'CollectiveUIChatGPT');
    await exec('/usr/bin/swiftc', [resolve('companion/macos/Companion.swift'), '-o', helper, '-framework', 'AppKit',
      '-module-cache-path', join(compilationRoot, 'module-cache')], { timeout: 60000 });
  }, 65000);
  afterAll(async () => { if (compilationRoot) await rm(compilationRoot, { recursive: true, force: true }); });
  it('creates only private root/files and rejects path traversal and symlinks', async () => {
    const { dir, root } = await fixture(); const s = store(root); await s.write('journal.json', { synthetic: true });
    expect((await stat(root)).mode & 0o777).toBe(0o700); expect((await stat(join(root, 'journal.json'))).mode & 0o777).toBe(0o600);
    expect(await s.read('journal.json')).toEqual({ synthetic: true }); await expect(s.read('../outside')).rejects.toThrow();
    await symlink(join(dir, 'outside'), join(root, 'linked.json')); await expect(s.read('linked.json')).rejects.toThrow(); await expect(s.write('linked.json', {})).rejects.toThrow();
    await chmod(join(root, 'journal.json'), 0o644); await expect(s.read('journal.json')).rejects.toThrow();
  });
  it('kernel lock is exclusive and releases after helper exit', async () => {
    const { root } = await fixture(); const first = store(root), second = store(root); await first.request('lock'); expect(await second.isLocked()).toBe(true);
    await expect(second.request('lock')).rejects.toThrow();
    const child = (first as unknown as { child: import('node:child_process').ChildProcess }).child;
    await new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill('SIGKILL'); });
    expect(await second.isLocked()).toBe(false);
    await second.locked(async () => { await second.write('journal.json', { safe: true }); }); expect(JSON.parse(await readFile(join(root, 'journal.json'), 'utf8'))).toEqual({ safe: true });
  });
  it('refuses a symlink directory and an existing permissive root', async () => {
    const { dir, root } = await fixture(); await symlink(dir, root); await expect(store(root).read('journal.json')).rejects.toThrow();
    await rm(root); const s = store(root); await s.write('journal.json', {}); s.close(); await chmod(root, 0o755); await expect(store(root).read('journal.json')).rejects.toThrow();
  });
});
