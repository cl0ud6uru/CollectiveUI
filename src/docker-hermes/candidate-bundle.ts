import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { LocalError } from '../local-hermes/controller';
import contract from '../local-hermes/team-candidate-contract.json';
import type { TeamCandidateConfig } from './types';

/** Application-owned bootstrap only. Native skill packages never become executable bundle inputs. */
export function candidateBootstrap(config: TeamCandidateConfig): string {
  const code = readFileSync(new URL('../local-hermes/team-candidate-native.py', import.meta.url), 'utf8');
  const line = JSON.stringify({ config, code, codeHash: createHash('sha256').update(code).digest('hex'), contract });
  if (Buffer.byteLength(line) > 65536) throw new LocalError(503, 'The fixed native candidate bootstrap is oversized.');
  return `${line}\n`;
}
