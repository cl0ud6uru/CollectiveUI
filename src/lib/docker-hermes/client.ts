import path from 'node:path';
import { HttpError } from '@/lib/authz';
import { LOCAL_ORIGIN, socketFetch } from '@/lib/local-hermes/client';
import type { DockerStatus } from '@/docker-hermes/types';
export function dockerFetch(ownerId: string): typeof fetch {
  const socket = process.env.DOCKER_HERMES_SOCKET;
  if (!socket || !path.isAbsolute(socket) || /[\x00-\x1f]/.test(socket)) throw new HttpError(503, 'Personal Hermes is not configured.');
  const fetchSocket = socketFetch(socket);
  return (input, init = {}) => {
    const headers = new Headers(init.headers); headers.set('x-collective-owner', ownerId);
    return fetchSocket(input, { ...init, headers });
  };
}
export async function dockerControl<T = DockerStatus>(ownerId: string, action: string, data?: unknown): Promise<T> {
  try {
    const res = await dockerFetch(ownerId)(`${LOCAL_ORIGIN}${action}`, { method: data === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(45000) });
    const result = await res.json();
    if (!res.ok) throw new HttpError(res.status, result.error ?? 'Personal Hermes operation failed.');
    return result as T;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(503, 'Personal Hermes broker is unavailable. Retry after the operator checks its protected socket.');
  }
}

/** Server cleanup only: retained owner/profile and run IDs come from the application database. */
export function dockerCleanupFetch(ownerId: string, bindingId: string, runId: string): typeof fetch {
  const allowed = `${LOCAL_ORIGIN}/p/${bindingId}/v1/runs/${runId}`;
  const fetch = dockerFetch(ownerId);
  return (input, init = {}) => {
    const url = String(input), method = init.method ?? 'GET';
    if (!((url === allowed && method === 'GET') || (url === `${allowed}/stop` && method === 'POST')))
      throw new Error('Cleanup cannot read resources, stream, submit or approve native work.');
    return fetch(input, init);
  };
}
