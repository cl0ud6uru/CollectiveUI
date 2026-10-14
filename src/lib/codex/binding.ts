import { createHash } from 'node:crypto';
import type { CodexRuntime } from './runtime';

export function runtimeBinding(runtime: CodexRuntime) {
  // Transport-token rotation may retain the binding. Account, endpoint, home/isolation changes may not.
  const { tokenFingerprint: _tokenFingerprint, ...accountRuntime } = runtime;
  void _tokenFingerprint;
  return createHash('sha256').update(JSON.stringify(accountRuntime)).digest('hex');
}
