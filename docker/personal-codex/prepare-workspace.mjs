import { lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** Materialize the denied mount target before stock Codex plans its metadata masks.
 * Never follow a workspace metadata symlink or alter existing metadata contents.
 * A missing .codex becomes an empty persistent directory, still denied to tools.
 */
export function prepareWorkspace(workspace = '/home/agent/workspace') {
  const metadata = join(workspace, '.codex');
  try { mkdirSync(metadata, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const entry = lstatSync(metadata);
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('Unsafe workspace metadata mount target.');
}
