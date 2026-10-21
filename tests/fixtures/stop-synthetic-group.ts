import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stopOwnedGroup } from '@/local-hermes/process-group';

/** Test drivers own these detached synthetic children. Production Docker/Linux
 * cleanup retains its /proc proof; macOS fixtures verify the same group with ps. */
export async function stopSyntheticGroup(group: number) {
  if (process.platform !== 'darwin') return stopOwnedGroup(group);
  const live = async () => {
    const { stdout } = await promisify(execFile)('/bin/ps', ['-axo', 'pgid=,stat=']);
    return stdout.split('\n').some(line => {
      const [id, state] = line.trim().split(/\s+/);
      return Number(id) === group && !state.startsWith('Z');
    });
  };
  const signal = (value: NodeJS.Signals) => {
    try { process.kill(-group, value); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  };
  signal('SIGTERM');
  for (const value of ['SIGTERM', 'SIGKILL'] as const) {
    if (value === 'SIGKILL') signal(value);
    const deadline = performance.now() + 2000;
    while (await live()) {
      if (performance.now() >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    if (!await live()) return;
  }
  throw new Error('Synthetic owned process group did not stop.');
}
