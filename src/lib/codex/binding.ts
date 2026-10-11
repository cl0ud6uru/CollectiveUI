import { createHash } from 'node:crypto';
import type { CodexRuntime } from './runtime';

export function runtimeBinding(runtime: CodexRuntime) {
  // Transport-token rotation may retain the binding. Account, endpoint, home/isolation changes may not.
  return createHash('sha256').update(JSON.stringify(runtime)).digest('hex');
}
