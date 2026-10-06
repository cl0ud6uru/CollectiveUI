import { requirePrincipal } from '@/lib/session';
import { cancelMemberUpdate } from '@/lib/hermes-team/member-updates';
import { readTeamPublicationRequest, teamPublicationFailure, teamPublicationResponse } from '@/lib/hermes-team/publication-http';
export async function POST(request: Request, ctx: RouteContext<'/api/bots/[id]/team/updates/cancel'>) {
  try {
    const principal = await requirePrincipal();
    return teamPublicationResponse(await cancelMemberUpdate(principal, (await ctx.params).id, await readTeamPublicationRequest(request)));
  } catch (error) { return teamPublicationFailure(error); }
}
