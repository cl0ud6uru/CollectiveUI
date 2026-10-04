import { z } from 'zod';
import { requirePrincipal } from '@/lib/session';
import { HttpError } from '@/lib/authz';
import { personalProfileBinding, dockerStatus, withDockerAccess } from '@/lib/docker-hermes/store';
import { dockerControl } from '@/lib/docker-hermes/client';
import { assertDockerCreate } from '@/lib/docker-hermes/policy';
import { getSetting } from '@/lib/settings';
import { codexAction, type CodexStatus } from '@/docker-hermes/oauth';

const response = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
// Never log validation errors or upstream bodies: a rejected input may contain a credential.
const failure = (e: unknown) => response({ error: e instanceof HttpError ? e.message : e instanceof z.ZodError ? 'Invalid subscription sign-in request.' : 'Subscription sign-in is unavailable. Reload before retrying.' }, e instanceof HttpError ? e.status : e instanceof z.ZodError ? 400 : 503);
export async function GET(_request: Request, ctx: RouteContext<'/api/bots/[id]/native/codex'>) {
  try {
    const p = await requirePrincipal(), b = await personalProfileBinding(p, (await ctx.params).id);
    const runtime = await dockerStatus(p);
    const status = runtime.phase === 'ready' ? await dockerControl<CodexStatus>(p.user.id, `/codex/${b.bindingId}`) : null;
    return response({ status, runtime: { phase: runtime.phase, network: runtime.network } });
  } catch (e) { return failure(e); }
}
export async function POST(request: Request, ctx: RouteContext<'/api/bots/[id]/native/codex'>) {
  try {
    const p = await requirePrincipal();
    if (request.headers.get('origin') !== new URL(process.env.AUTH_URL || request.url).origin) throw new HttpError(403, 'Invalid request origin.');
    const id = (await ctx.params).id;
    await personalProfileBinding(p, id);
    if (!request.headers.get('content-type')?.startsWith('application/json')) throw new HttpError(415, 'JSON required.');
    if (Number(request.headers.get('content-length')) > 16384 || !request.body) throw new HttpError(413, 'Profile request is too large.');
    const reader = request.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 16384) { await reader.cancel(); throw new HttpError(413, 'Profile request is too large.'); } chunks.push(value); }
    } finally { reader.releaseLock(); }
    let raw: unknown; try { raw = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new HttpError(400, 'Invalid JSON.'); }
    const input = codexAction.parse(raw);
    // Parse outside the owner lock; dispatch rechecks enrollment after any queued revocation.
    const result = await withDockerAccess(p, false, async (fresh, tx) => {
      const b = await personalProfileBinding(fresh, id, tx);
      let canCreate = true;
      try { await assertDockerCreate(fresh, await getSetting('tools', tx), tx); }
      catch (e) { if (!(e instanceof HttpError) || e.status !== 403) throw e; canCreate = false; }
      // The worker skips a busy owner lock. Refresh this authorized lease before bounded maintenance.
      await dockerControl(fresh.user.id, '/control/lease', { canCreate }, 3000);
      return dockerControl<CodexStatus>(fresh.user.id, `/codex/${b.bindingId}`, input);
    });
    return response(result);
  } catch (e) { return failure(e); }
}
