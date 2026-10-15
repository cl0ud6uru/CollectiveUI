import { z } from 'zod';
import { requirePrincipal } from '@/lib/session';
import { assertAuthOrigin } from '@/lib/auth/origin';
import { HttpError } from '@/lib/authz';
import { modelInput, nativeSessionModel } from '@/lib/remote-hermes/model';

const envelope = z.object({ sessionId: z.string().min(1).max(200), input: modelInput }).strict();
export async function POST(req: Request, ctx: { params: Promise<{ connectionId: string }> }) {
  const headers = { 'Cache-Control': 'private, no-store' };
  try {
    const principal = await requirePrincipal(); assertAuthOrigin(req.headers);
    const reader = req.body?.getReader(); if (!reader) throw new HttpError(400, 'Missing model request.');
    let size = 0; const chunks: Uint8Array[] = [];
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 8000) throw new HttpError(413, 'Model request is too large.'); chunks.push(value); } }
    finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    let raw: unknown; try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Invalid model request.'); }
    const { connectionId } = await ctx.params;
    const input = envelope.parse(raw);
    const result = await nativeSessionModel(principal.user.id, connectionId, input.sessionId, input.input);
    return Response.json(result, { headers });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : error instanceof z.ZodError ? 400 : 502;
    const message = error instanceof HttpError ? error.message : status === 400 ? 'Invalid model request.' : 'Hermes did not confirm the model operation. Refresh before continuing.';
    return Response.json({ error: message }, { status, headers });
  }
}
