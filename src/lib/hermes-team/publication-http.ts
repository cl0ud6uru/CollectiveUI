import { z } from 'zod';
import { HttpError } from '@/lib/authz';
import { assertAuthOrigin } from '@/lib/auth/origin';
import { TeamResourceError } from './resources';
export const teamPublicationResponse = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
export function teamPublicationFailure(error: unknown): Response {
  const status = error instanceof HttpError ? error.status : error instanceof z.ZodError || error instanceof SyntaxError ? 400 : error instanceof TeamResourceError ? 422 : 503;
  const message = error instanceof HttpError || error instanceof TeamResourceError ? error.message : status === 400 ? 'Invalid publication request.' : 'Publication status could not be confirmed. Retry the same request after reloading.';
  return teamPublicationResponse({ error: message }, status);
}
/** Resource bytes arrive only from the broker. Browser requests contain bounded selections/IDs. */
export async function readTeamPublicationRequest(request: Request): Promise<unknown> {
  assertAuthOrigin(request.headers);
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) throw new HttpError(415, 'JSON required.');
  const maximum = 96 * 1024;
  if (!request.body || Number(request.headers.get('content-length')) > maximum) throw new HttpError(413, 'Publication request is too large.');
  const reader = request.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > maximum) { await reader.cancel(); throw new HttpError(413, 'Publication request is too large.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Invalid JSON.'); }
}
