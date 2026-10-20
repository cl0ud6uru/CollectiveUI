import { z } from 'zod';
import { requirePrincipal } from '@/lib/session';
import { assertAuthOrigin } from '@/lib/auth/origin';
import { HttpError } from '@/lib/authz';
import { nativeMcpOAuth } from '@/lib/remote-hermes/mcp-oauth';

const envelope = z.object({ sessionId: z.string().min(1).max(200), input: z.unknown() }).strict();
const headers = { 'Cache-Control': 'private, no-store' };
export async function POST(req: Request, ctx: { params: Promise<{ connectionId: string }> }) {
  try {
    const principal = await requirePrincipal();
    assertAuthOrigin(req.headers);
    const { connectionId } = await ctx.params;
    const reader = req.body?.getReader();
    if (!reader) throw new HttpError(400, 'Missing OAuth request.');
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 12_000) throw new HttpError(413, 'OAuth request is too large.');
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    let raw: unknown;
    try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Invalid OAuth request.'); }
    const input = envelope.parse(raw);
    return Response.json(await nativeMcpOAuth(principal.user.id, connectionId, input.sessionId, input.input), { headers });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : error instanceof z.ZodError ? 400 : 502;
    // Authorization URLs and native diagnostics can contain protected values.
    return Response.json({ error: error instanceof HttpError ? error.message : status === 400 ? 'Invalid OAuth request.' : 'Hermes OAuth could not be completed. Check its outcome in Hermes.' }, { status, headers });
  }
}
