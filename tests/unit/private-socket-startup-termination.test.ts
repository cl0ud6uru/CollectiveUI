import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function message(child: ChildProcess, type: string) {
  return new Promise<void>((done, reject) => {
    const timer = setTimeout(() => { clean(); reject(new Error('Synthetic startup marker timed out')); }, 5000);
    const receive = (value: unknown) => { if ((value as { type?: string })?.type === type) { clean(); done(); } };
    const exit = () => { clean(); reject(new Error('Synthetic daemon exited before its startup marker')); };
    const clean = () => { clearTimeout(timer); child.off('message', receive); child.off('exit', exit); };
    child.on('message', receive); child.once('exit', exit);
  });
}

describe('actual egress entrypoint startup termination', () => {
  it.each(['SIGTERM', 'SIGINT'] as const)('cleans up %s during delayed chmod and publication', async signal => {
    for (const phase of ['chmod', 'link']) {
      const directory = await mkdtemp('/tmp/uds-startup-');
      const hook = join(directory, 'barrier.mjs');
      await writeFile(hook, `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const originalOn = process.on;
process.on = function(name, listener) {
  return originalOn.call(this, name, ['SIGTERM', 'SIGINT'].includes(name) ? function(...args) {
    const result = listener.apply(this, args); process.send({ type: 'stopping' }); return result;
  } : listener);
};
const operation = fs.promises[${JSON.stringify(phase)}];
fs.promises[${JSON.stringify(phase)}] = async (...args) => {
  process.send({ type: 'blocked' });
  await new Promise(done => process.once('message', done));
  return operation(...args);
};
syncBuiltinESMExports();
`);
      const child = spawn(process.execPath, ['--import', hook, resolve('src/agent-browserd/egress.ts')], {
        // No inherited credentials, node preload, runtime configuration or external URL.
        env: { NODE_ENV: 'test', PATH: process.env.PATH, HOME: directory, AGENT_BROWSER_EGRESS_SOCKET: join(directory, 'egress.sock'),
          AGENT_BROWSER_EGRESS_SECRET: 'synthetic-startup-termination-secret-32' },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(done => child.once('exit', (code, signal) => done({ code, signal })));
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await message(child, 'blocked');
        const stopping = message(child, 'stopping'); child.kill(signal); await stopping;
        expect((await readdir(directory)).includes('egress.sock')).toBe(false);
        child.send({ type: 'release' }); child.disconnect();
        const result = await Promise.race([exited, new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Synthetic daemon did not finish shutdown')), 5000);
        })]);
        expect(result).toEqual({ code: 0, signal: null });
        expect(await readdir(directory)).toEqual(['barrier.mjs']);
      } finally {
        clearTimeout(timeout);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await exited;
        await rm(directory, { recursive: true, force: true });
      }
    }
  }, 15000);
});
