// Node-only protected IPC, also imported by the plain Node worker.
import { isAbsolute } from 'node:path';
import { socketFetch, LOCAL_ORIGIN } from '@/lib/local-hermes/client';
import { HttpError } from '@/lib/authz';
import type { BrokerStatus, PersonalControlResult, SiwcSyncResult, EnrollmentReadiness } from './contracts';
import type { z } from 'zod';
import { enrollmentReadinessSchema, enrollmentRequest, ownerId, tokenSyncRequest } from './contracts';

export class PersonalControlError extends HttpError {
  constructor(status: number, message: string, public code?: 'not_enrolled') { super(status, message); }
}

export function personalSocket() {
  const path = process.env.PERSONAL_CODEX_SOCKET;
  if (!path || !isAbsolute(path) || /[\x00-\x1f]/.test(path)) throw new HttpError(503, 'Personal Codex is not installed. An operator must approve runtime installation.');
  return path;
}
export function personalControl(owner: string, action: 'readiness'): Promise<EnrollmentReadiness>;
export function personalControl(owner: string, action: 'prepare', consent: z.infer<typeof enrollmentRequest>): Promise<EnrollmentReadiness>;
export function personalControl(owner: string, action: 'status' | 'connect' | 'cancel' | 'disconnect' | 'start'): Promise<BrokerStatus>;
export function personalControl(owner: string, action: 'sync-token', credential: z.infer<typeof tokenSyncRequest>): Promise<SiwcSyncResult>;
export async function personalControl(owner: string, action: 'status' | 'connect' | 'cancel' | 'disconnect' | 'start' | 'sync-token' | 'readiness' | 'prepare', credential?: z.infer<typeof tokenSyncRequest> | z.infer<typeof enrollmentRequest>): Promise<PersonalControlResult | EnrollmentReadiness> {
  try {
    ownerId.parse(owner);
    if (action === 'prepare') enrollmentRequest.parse(credential);
    const r = await socketFetch(personalSocket())(`${LOCAL_ORIGIN}/${action}`, { method: ['status', 'readiness'].includes(action) ? 'GET' : 'POST',
      headers: { 'x-collective-owner': owner, ...(credential ? { 'content-type': 'application/json' } : {}) },
      ...(credential ? { body: JSON.stringify((action === 'prepare' ? enrollmentRequest : tokenSyncRequest).parse(credential)) } : {}), signal: AbortSignal.timeout(45000) });
    if (!r.ok) {
      const body = await r.json().catch(() => null) as { code?: unknown } | null;
      if (r.status === 403 && body?.code === 'not_enrolled')
        throw new PersonalControlError(403, 'This account is not enrolled in Personal Codex.', 'not_enrolled');
      throw new Error();
    }
    const body = await r.json();
    return ['readiness', 'prepare'].includes(action) ? enrollmentReadinessSchema.parse(body) : body;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(503, 'Personal Codex is unavailable. Reload to check the current state before retrying.');
  }
}
