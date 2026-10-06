import { requirePrincipal } from '@/lib/session';
import { getTeamPublicationRollout, publishTeamPublication } from '@/lib/hermes-team/publication';
import { readTeamPublicationRequest, teamPublicationFailure, teamPublicationResponse } from '@/lib/hermes-team/publication-http';
export async function GET(_request: Request, ctx: RouteContext<'/api/bots/[id]/team/publish'>) {
  try { return teamPublicationResponse(await getTeamPublicationRollout(await requirePrincipal(), (await ctx.params).id)); }
  catch (error) { return teamPublicationFailure(error); }
}
export async function POST(request: Request, ctx: RouteContext<'/api/bots/[id]/team/publish'>) {
  try {
    const principal = await requirePrincipal();
    return teamPublicationResponse(await publishTeamPublication(principal, (await ctx.params).id, await readTeamPublicationRequest(request)));
  } catch (error) { return teamPublicationFailure(error); }
}
