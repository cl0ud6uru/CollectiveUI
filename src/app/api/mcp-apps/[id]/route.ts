import { z } from 'zod';
import { assertAuthOrigin } from '@/lib/auth/origin';
import { HttpError } from '@/lib/authz';
import { errorResponse, requirePrincipal } from '@/lib/session';
import { callMcpAppTool, decideMcpAppAction, listMcpAppActions, loadMcpApp } from '@/lib/mcp/apps';

const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
const bodySchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('call'), id: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/), name: z.string().min(1).max(256), arguments: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ operation: z.literal('decide'), id: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/), approve: z.boolean() }).strict(),
]);

export async function GET(request: Request, ctx: RouteContext<'/api/mcp-apps/[id]'>) {
  try {
    const p = await requirePrincipal(), { id } = await ctx.params;
    if (new URL(request.url).searchParams.has('actions')) return Response.json({ actions: await listMcpAppActions(p, id) }, { headers });
    return Response.json({ view: await loadMcpApp(p, id), actions: await listMcpAppActions(p, id) }, { headers });
  } catch (error) { const response = errorResponse(error); response.headers.set('Cache-Control', 'no-store'); return response; }
}

export async function POST(request: Request, ctx: RouteContext<'/api/mcp-apps/[id]'>) {
  try {
    assertAuthOrigin(request.headers);
    const p = await requirePrincipal(), { id } = await ctx.params;
    if (!request.headers.get('content-type')?.startsWith('application/json')) throw new HttpError(415, 'JSON required.');
    const reader = request.body?.getReader();
    if (!reader) throw new HttpError(400, 'Request body required.');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 40000) { await reader.cancel(); throw new HttpError(413, 'Widget request too large.'); }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    let json: unknown;
    try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON.'); }
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) throw new HttpError(400, 'Invalid widget request.');
    const body = parsed.data;
    const action = body.operation === 'call' ? await callMcpAppTool(p, id, body) : await decideMcpAppAction(p, id, body.id, body.approve);
    return Response.json({ action }, { headers });
  } catch (error) { const response = errorResponse(error); response.headers.set('Cache-Control', 'no-store'); return response; }
}
