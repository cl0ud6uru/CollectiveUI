import { assertAuthOrigin } from '@/lib/auth/origin';
import { requirePrincipal } from '@/lib/session';
import { HttpError } from '@/lib/authz';
import { decideApproval } from '@/personal-codex/approvals';

export async function POST(request: Request, ctx: RouteContext<'/api/me/codex/approvals/[id]'>) {
  try {
    const p = await requirePrincipal();
    assertAuthOrigin(request.headers);
    // Decision is selected by a fixed HTTP header; no command, permission, endpoint or token input.
    const decision = request.headers.get('x-codex-decision');
    if (!['decline', 'cancel'].includes(decision ?? '') || request.body) throw new HttpError(400, 'Choose Deny or Stop.');
    await decideApproval(p.user.id, p.user.sessionVersion, (await ctx.params).id, decision as 'decline' | 'cancel');
    return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) { return Response.json({ error: e instanceof HttpError ? e.message : 'Codex approval is unavailable.' }, { status: e instanceof HttpError ? e.status : 503, headers: { 'Cache-Control': 'no-store' } }); }
}
