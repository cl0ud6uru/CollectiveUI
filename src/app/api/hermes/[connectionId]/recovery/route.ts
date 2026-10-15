import { z } from 'zod';
import { requirePrincipal } from '@/lib/session';
import { assertAuthOrigin } from '@/lib/auth/origin';
import { HttpError } from '@/lib/authz';
import { recoveryInput } from '@/lib/remote-hermes/recovery-contract';
import { nativeRecovery } from '@/lib/remote-hermes/recovery';

export async function POST(req: Request, ctx: { params: Promise<{ connectionId: string }> }) {
  const headers = { 'Cache-Control': 'private, no-store' };
  try {
    const principal = await requirePrincipal();
    assertAuthOrigin(req.headers);
    if (!req.headers.get('content-type')?.startsWith('application/json')) throw new HttpError(415, 'Send a JSON recovery request.');
    const reader = req.body?.getReader();
    if (!reader) throw new HttpError(400, 'Missing recovery request.');
    let length = 0; const chunks: Uint8Array[] = [];
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; length += value.length;
        if (length > 2048) throw new HttpError(413, 'Recovery request is too large.'); chunks.push(value); }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    let raw: unknown;
    try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new HttpError(400, 'Invalid recovery request.'); }
    const { connectionId } = await ctx.params;
    return Response.json(await nativeRecovery(principal.user.id, connectionId, recoveryInput.parse(raw)), { headers });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : error instanceof z.ZodError ? 400 : 502;
    return Response.json({ error: error instanceof HttpError ? error.message : status === 400 ? 'Invalid recovery request.' : 'Recovery could not be verified. Reservations remain blocked.' }, { status, headers });
  }
}
