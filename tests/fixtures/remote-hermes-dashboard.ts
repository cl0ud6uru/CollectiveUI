import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export const DASHBOARD_PIN = 'f97608f178d1ffeca59860195ab7da295f7c8e5f';
/** Starts only the repository's disposable loopback fixture, never a user URL/profile. */
export async function startPinnedDashboard() {
  if (!process.env.HERMES_SOURCE || !process.env.HERMES_DASHBOARD_PYTHON) throw new Error('Exact source checkout and isolated Python runtime required');
  const child = spawn(process.env.HERMES_DASHBOARD_PYTHON, ['-B', 'tests/fixtures/remote-hermes-dashboard-bootstrap.py'], {
    env: { NODE_ENV: 'test', PATH: process.env.PATH, HERMES_SOURCE: process.env.HERMES_SOURCE }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.resume(); // Synthetic diagnostics are not retained as artifacts.
  async function stop() {
    if (child.exitCode !== null) return;
    child.kill('SIGTERM');
    await new Promise<void>(resolve => {
      const timeout = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000);
      child.once('exit', () => { clearTimeout(timeout); resolve(); });
    });
  }
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const lines = createInterface({ input: child.stdout });
      const timer = setTimeout(() => reject(new Error('Pinned dashboard fixture startup timed out')), 30000);
      child.once('error', () => { clearTimeout(timer); reject(new Error('Pinned dashboard fixture could not start')); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Pinned dashboard fixture exited')); });
      lines.once('line', line => {
        clearTimeout(timer); lines.close();
        try {
          const ready = JSON.parse(line);
          if (typeof ready.startupError === 'string' && /^[A-Za-z0-9_]{1,80}$/.test(ready.startupError) && typeof ready.missingModule === 'string' && /^([A-Za-z0-9_.]{1,120})?$/.test(ready.missingModule)) {
            reject(new Error(`Pinned dashboard startup failed (${ready.startupError}${ready.missingModule ? `: ${ready.missingModule}` : ''})`)); return;
          }
          if (ready.pin !== DASHBOARD_PIN || ready.runtimeVersion !== '0.21.5' || ready.desktopContract !== 8 || !Number.isInteger(ready.port) || ready.port < 1 || ready.port > 65535) throw new Error();
          resolve(ready.port);
        } catch { reject(new Error('Invalid pinned dashboard identity/readiness')); }
      });
    });
    return { base: `http://127.0.0.1:${port}`, stop };
  } catch (error) { await stop(); throw error; }
}
