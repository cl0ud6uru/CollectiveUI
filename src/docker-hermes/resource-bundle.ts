import { createHash } from 'node:crypto';
import { mkdir, open, readFile, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { LocalError } from '../local-hermes/controller';

/** Bundle application-owned resource functions; native files and package scripts are never build inputs. */
export async function buildResourceHelper(stateDir: string): Promise<string> {
  const output = await build({ entryPoints: [path.join(import.meta.dirname, 'resource-helper.ts')], bundle: true, write: false,
    platform: 'node', target: 'node26', format: 'esm', logLevel: 'silent', sourcemap: false, treeShaking: true });
  const code = output.outputFiles?.[0]?.contents;
  if (!code || code.length > 2 * 1024 * 1024) throw new LocalError(503, 'The resource helper could not be packaged safely.');
  const hash = createHash('sha256').update(code).digest('hex'), directory = path.join(stateDir, 'resource-helpers');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (await realpath(directory) !== directory || !(await lstat(directory)).isDirectory()) throw new LocalError(503, 'Unsafe resource helper storage.');
  const file = path.join(directory, `${hash}.mjs`);
  try {
    const handle = await open(file, 'wx', 0o444);
    // Broker umask is intentionally private. The fixed code mount must still be
    // readable by the separate unprivileged helper UID inside its container.
    try { await handle.writeFile(code); await handle.chmod(0o444); await handle.sync(); } finally { await handle.close(); }
    const parent = await open(directory, 'r'); try { await parent.sync(); } finally { await parent.close(); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.mode & 0o022
    || createHash('sha256').update(await readFile(file)).digest('hex') !== hash) throw new LocalError(503, 'Resource helper content changed.');
  return file;
}
