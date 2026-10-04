import { z } from 'zod';
import { requirePrincipal } from '@/lib/session';
import { HttpError } from '@/lib/authz';
import { personalProfileBinding, dockerStatus } from '@/lib/docker-hermes/store';
import { dockerControl } from '@/lib/docker-hermes/client';
import { profileUpdate, profileTest, type ProfileSettings, type ProfileTestResult } from '@/docker-hermes/settings';

const response = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
// Never log validation errors or upstream bodies: a rejected input may contain a credential.
const failure = (e: unknown) => response({ error: e instanceof HttpError ? e.message : e instanceof z.ZodError ? 'Invalid profile settings. Check the fields and try again.' : 'Profile settings are unavailable. Reload before retrying.' }, e instanceof HttpError ? e.status : e instanceof z.ZodError ? 400 : 503);
export async function GET(_request: Request, ctx: RouteContext<'/api/bots/[id]/native/settings'>) {
  try {
    const p = await requirePrincipal(), b = await personalProfileBinding(p, (await ctx.params).id);
    const runtime = await dockerStatus(p);
    const settings = runtime.phase === 'ready' ? await dockerControl<ProfileSettings>(p.user.id, `/settings/${b.bindingId}`) : null;
    return response({ settings, runtime: { phase: runtime.phase, network: runtime.network } });
  } catch (e) { return failure(e); }
}
export async function POST(request: Request, ctx: RouteContext<'/api/bots/[id]/native/settings'>) {
  try {
    const p = await requirePrincipal();
    if (request.headers.get('origin') !== new URL(process.env.AUTH_URL || request.url).origin) throw new HttpError(403, 'Invalid request origin.');
    const b = await personalProfileBinding(p, (await ctx.params).id);
    if (!request.headers.get('content-type')?.startsWith('application/json')) throw new HttpError(415, 'JSON required.');
    if (Number(request.headers.get('content-length')) > 16384 || !request.body) throw new HttpError(413, 'Profile request is too large.');
    const reader = request.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 16384) { await reader.cancel(); throw new HttpError(413, 'Profile request is too large.'); } chunks.push(value); }
    } finally { reader.releaseLock(); }
    let raw: unknown; try { raw = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new HttpError(400, 'Invalid JSON.'); }
    const input = z.discriminatedUnion('operation', [z.object({ operation: z.literal('save'), settings: profileUpdate }).strict(), z.object({ operation: z.literal('test'), test: profileTest }).strict()]).parse(raw);
    const result = input.operation === 'save'
      ? await dockerControl<ProfileSettings>(p.user.id, `/settings/${b.bindingId}`, input.settings)
      : await dockerControl<ProfileTestResult>(p.user.id, `/settings/${b.bindingId}/test`, input.test);
    return response(result);
  } catch (e) { return failure(e); }
}
