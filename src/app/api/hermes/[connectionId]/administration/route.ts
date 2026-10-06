import { z } from 'zod';
import { requirePrincipal } from '@/lib/session';
import { assertAuthOrigin } from '@/lib/auth/origin';
import { HttpError } from '@/lib/authz';
import { nativeAdministration } from '@/lib/remote-hermes/administration';

const envelope = z.object({ sessionId: z.string().min(1).max(200), input: z.unknown() }).strict();
type Context = { params: Promise<{ connectionId: string }> };
const headers = { 'Cache-Control': 'private, no-store' };
function failure(error: unknown) {
  // Protected values and native responses must never reach console/error telemetry.
  const status = error instanceof HttpError ? error.status : error instanceof z.ZodError ? 400 : 502;
  return Response.json({ error: error instanceof HttpError ? error.message : status === 400 ? 'Invalid Hermes administration request.' : 'Hermes administration could not be completed. Refresh to check its outcome.' }, { status, headers });
}
export async function GET(req: Request, ctx: Context) {
  try {
    const principal = await requirePrincipal();
    const { connectionId } = await ctx.params;
    const sessionId = z.string().min(1).max(200).parse(new URL(req.url).searchParams.get('sessionId'));
    return Response.json(await nativeAdministration(principal.user.id, connectionId, sessionId, { operation: 'inspect' }), { headers });
  } catch (error) { return failure(error); }
}
export async function POST(req: Request, ctx: Context) {
  try {
    const principal = await requirePrincipal(); assertAuthOrigin(req.headers);
    const { connectionId } = await ctx.params;
    const reader = req.body?.getReader(); if (!reader) throw new HttpError(400, 'Missing administration request.');
    let size = 0; const chunks: Uint8Array[] = [];
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 32_000) throw new HttpError(413, 'Administration request is too large.'); chunks.push(value); }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    let raw: unknown;
    try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Invalid administration request.'); }
    const input = envelope.parse(raw);
    return Response.json(await nativeAdministration(principal.user.id, connectionId, input.sessionId, input.input), { headers });
  } catch (error) { return failure(error); }
}
