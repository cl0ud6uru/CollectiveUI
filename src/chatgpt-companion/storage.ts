import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { LocalCompanionStore } from '../lib/hermes-team/official-plan-local-companion';

/** Native helper owns directory descriptors and kernel-released locks; no Node path-based secret I/O. */
export class MacProtectedStore implements LocalCompanionStore {
  private child?: ChildProcessWithoutNullStreams;
  private pending?: { resolve(value: unknown): void; reject(error: Error): void };
  private failed = false;
  constructor(private readonly helper: string, private readonly root: string) {}
  private start() {
    if (this.failed) throw new Error('Protected local storage is unavailable.');
    if (this.child) return this.child;
    const child = spawn(this.helper, ['--store', this.root], { stdio: ['pipe', 'pipe', 'pipe'], env: { NODE_ENV: 'production', PATH: '/usr/bin:/bin' } });
    this.child = child; child.stderr.resume();
    const fail = () => { this.failed = true; this.pending?.reject(new Error('Protected local operation was not confirmed.')); this.pending = undefined; };
    child.on('error', fail); child.on('exit', fail);
    const lines = createInterface({ input: child.stdout });
    let bytes = 0; child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 200000) { fail(); child.kill(); } if (chunk.includes(10)) bytes = 0; });
    lines.on('line', line => {
      const pending = this.pending; if (!pending || line.length > 200000) return fail(); this.pending = undefined;
      try { const r = JSON.parse(line); if (r.ok !== true) throw new Error(); pending.resolve(r.value); } catch { pending.reject(new Error('Protected local operation was not confirmed.')); }
    });
    child.stdin.on('error', fail); return child;
  }
  async request(op: string, fields: Record<string, unknown> = {}): Promise<unknown> {
    if (this.pending) throw new Error('Concurrent protected operation refused.');
    const child = this.start();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.failed = true; child.kill(); reject(new Error('Protected operation timed out.')); }, op === 'confirm' ? 600000 : 15000);
      this.pending = { resolve: value => { clearTimeout(timer); resolve(value); }, reject: e => { clearTimeout(timer); reject(e); } };
      child.stdin.write(`${JSON.stringify({ op, ...fields })}\n`);
    });
  }
  async read(name: string) { const value = await this.request('read', { name }); return typeof value === 'string' ? JSON.parse(value) : null; }
  async write(name: string, value: unknown) { await this.request('write', { name, data: JSON.stringify(value) }); }
  async isLocked() { return await this.request('isLocked') === true; }
  async locked<T>(operation: () => Promise<T>): Promise<T> { await this.request('lock'); try { return await operation(); } finally { await this.request('unlock'); } }
  close() { this.child?.stdin.end(); }
}
