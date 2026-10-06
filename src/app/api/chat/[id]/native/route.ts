import { z } from 'zod';
import { requirePrincipal } from '@/lib/session';
import { assertAuthOrigin } from '@/lib/auth/origin';
import { HermesError } from '@/lib/llm/providers/hermes/client';
import { HttpError } from '@/lib/authz';
import { mutateManagedNative, viewManagedNative } from '@/lib/hermes-native/managed';

const response = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });
// A protected value may be invalid. Never log or return its body or upstream exception.
const failure = (e: unknown) => response({ error: e instanceof HermesError ? 'Hermes did not confirm this native operation. Reload the chat before continuing.' : e instanceof HttpError ? e.message : e instanceof z.ZodError ? 'Invalid native request.' : 'Native controls are unavailable. Reload the chat before trying again.' }, e instanceof HttpError ? e.status : e instanceof z.ZodError ? 400 : 503);
export async function GET(_request: Request, ctx: RouteContext<'/api/chat/[id]/native'>) {
  try { return response(await viewManagedNative(await requirePrincipal(), (await ctx.params).id)); }
  catch (e) { return failure(e); }
}
export async function POST(request: Request, ctx: RouteContext<'/api/chat/[id]/native'>) {
  try {
    const p = await requirePrincipal(); assertAuthOrigin(request.headers);
    if (!request.headers.get('content-type')?.startsWith('application/json')) throw new HttpError(415, 'JSON required.');
    const reader = request.body?.getReader(); if (!reader) throw new HttpError(400, 'Missing native request.');
    let size = 0; const chunks: Uint8Array[] = [];
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 32 * 1024) { await reader.cancel(); throw new HttpError(413, 'Native request is too large.'); } chunks.push(value); } }
    finally { reader.releaseLock(); }
    let input: unknown; try { input = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new HttpError(400, 'Invalid native request JSON.'); }
    return response(await mutateManagedNative(p, (await ctx.params).id, input));
  } catch (e) { return failure(e); }
}
