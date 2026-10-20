import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const DASHBOARD_PIN = 'f97608f178d1ffeca59860195ab7da295f7c8e5f';
/** Starts only the repository's disposable loopback fixture, never a user URL/profile. */
export async function startPinnedDashboard(options: { recoveryAdapters?: boolean } = {}) {
  if (!process.env.HERMES_SOURCE || !process.env.HERMES_DASHBOARD_PYTHON) throw new Error('Exact source checkout and isolated Python runtime required');
  // The launcher owns cleanup even if Python is killed during archive/startup.
  const temporary = await mkdtemp(join(tmpdir(), 'collective-dashboard-launcher-'));
  const child = spawn(process.env.HERMES_DASHBOARD_PYTHON, ['-B', 'tests/fixtures/remote-hermes-dashboard-bootstrap.py'], {
    env: { NODE_ENV: 'test', TMPDIR: temporary, PATH: process.env.PATH, HERMES_SOURCE: process.env.HERMES_SOURCE, ...(options.recoveryAdapters ? { REMOTE_HERMES_RECOVERY_ADAPTER_FIXTURE: '1' } : {}) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.resume(); // Synthetic diagnostics are not retained as artifacts.
  async function stop() {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>(resolve => {
        const timeout = setTimeout(() => { child.kill('SIGKILL'); }, 5000);
        child.once('exit', () => { clearTimeout(timeout); resolve(); });
      });
    }
    await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
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
            const site = typeof ready.startupSite === 'string' && /^[A-Za-z0-9_.:<>-]{1,160}$/.test(ready.startupSite) ? ` at ${ready.startupSite}` : '';
            reject(new Error(`Pinned dashboard startup failed (${ready.startupError}${ready.missingModule ? `: ${ready.missingModule}` : ''})${site}`)); return;
          }
          if (options.recoveryAdapters && ready.recoveryAdapters !== true) throw new Error();
          if (ready.pin !== DASHBOARD_PIN || ready.runtimeVersion !== '0.21.5' || ready.desktopContract !== 8 || !Number.isInteger(ready.port) || ready.port < 1 || ready.port > 65535) throw new Error();
          resolve(ready.port);
        } catch { reject(new Error('Invalid pinned dashboard identity/readiness')); }
      });
    });
    const base = `http://127.0.0.1:${port}`;
    // The native fixture announces the bound listener before Uvicorn accepts HTTP.
    // Use the pinned lightweight liveness route, not /api/status's gateway and
    // session probes. Callers must not race a one-second waitFor.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(base + '/api/health', { signal: AbortSignal.timeout(1000) });
        if (response.ok && (await response.json()).version === '0.21.5') return { base, stop };
        await response.body?.cancel();
      } catch { /* Retry only this owned disposable loopback endpoint. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Pinned dashboard HTTP startup timed out');
  } catch (error) { await stop(); throw error; }
}
