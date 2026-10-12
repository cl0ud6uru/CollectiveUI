// Node-only protected IPC, also imported by the plain Node worker.
import { isAbsolute } from 'node:path';
import { socketFetch, LOCAL_ORIGIN } from '@/lib/local-hermes/client';
import { HttpError } from '@/lib/authz';
import type { BrokerStatus } from './contracts';

export function personalSocket() {
  const path = process.env.PERSONAL_CODEX_SOCKET;
  if (!path || !isAbsolute(path) || /[\x00-\x1f]/.test(path)) throw new HttpError(503, 'Personal Codex is not installed. An operator must approve runtime installation.');
  return path;
}
export async function personalControl(owner: string, action: 'status' | 'connect' | 'cancel' | 'disconnect' | 'start'): Promise<BrokerStatus> {
  try {
    const r = await socketFetch(personalSocket())(`${LOCAL_ORIGIN}/${action}`, { method: action === 'status' ? 'GET' : 'POST',
      headers: { 'x-collective-owner': owner }, signal: AbortSignal.timeout(45000) });
    if (!r.ok) throw new Error();
    return await r.json();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(503, 'Personal Codex is unavailable. Reload to check the current state before retrying.');
  }
}
