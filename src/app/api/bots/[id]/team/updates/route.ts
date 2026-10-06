import { requirePrincipal } from '@/lib/session';
import { applyMemberUpdate, previewMemberUpdate } from '@/lib/hermes-team/member-updates';
import { readTeamPublicationRequest, teamPublicationFailure, teamPublicationResponse } from '@/lib/hermes-team/publication-http';
import { HttpError } from '@/lib/authz';
export async function GET(request: Request, ctx: RouteContext<'/api/bots/[id]/team/updates'>) {
  try {
    const principal = await requirePrincipal(), query = new URL(request.url).searchParams;
    if ([...query.keys()].some(key => key !== 'targetRevision') || query.getAll('targetRevision').length > 1) throw new HttpError(400, 'Invalid update preview.');
    const target = query.get('targetRevision');
    if (target !== null && !/^(0|[1-9][0-9]{0,9})$/.test(target)) throw new HttpError(400, 'Invalid Team revision.');
    return teamPublicationResponse(await previewMemberUpdate(principal, (await ctx.params).id, target === null ? {} : { targetRevision: Number(target) }));
  } catch (error) { return teamPublicationFailure(error); }
}
export async function POST(request: Request, ctx: RouteContext<'/api/bots/[id]/team/updates'>) {
  try {
    const principal = await requirePrincipal();
    return teamPublicationResponse(await applyMemberUpdate(principal, (await ctx.params).id, await readTeamPublicationRequest(request)));
  } catch (error) { return teamPublicationFailure(error); }
}
