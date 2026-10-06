import { z } from 'zod';
import { requireAdmin } from '@/lib/session';
import { HttpError } from '@/lib/authz';
import { getDockerNetworks, requestDockerNetwork } from '@/lib/docker-hermes/network';
import { ownerId } from '@/docker-hermes/types';
import { networkRequest } from '@/docker-hermes/network';
const response = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const failure = (e: unknown) => response({ error: e instanceof HttpError ? e.message : e instanceof z.ZodError ? 'Invalid network change.' : 'Network status could not be confirmed. Reload before retrying the same request.' }, e instanceof HttpError ? e.status : e instanceof z.ZodError ? 400 : 503);
export async function GET() {
  try { return response(await getDockerNetworks(await requireAdmin())); } catch (e) { return failure(e); }
}
export async function POST(request: Request) {
  try {
    const p = await requireAdmin();
    if (request.headers.get('origin') !== new URL(process.env.AUTH_URL || request.url).origin) throw new HttpError(403, 'Invalid request origin.');
    if (!request.headers.get('content-type')?.startsWith('application/json')) throw new HttpError(415, 'JSON required.');
    if (!request.body || Number(request.headers.get('content-length')) > 4096) throw new HttpError(413, 'Network request is too large.');
    const reader = request.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 4096) { await reader.cancel(); throw new HttpError(413, 'Network request is too large.'); } chunks.push(value); }
    } finally { reader.releaseLock(); }
    let raw: unknown; try { raw = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new HttpError(400, 'Invalid JSON.'); }
    const input = z.object({ owner: ownerId, request: networkRequest }).strict().parse(raw);
    return response(await requestDockerNetwork(p, input.owner, input.request), 202);
  } catch (e) { return failure(e); }
}
