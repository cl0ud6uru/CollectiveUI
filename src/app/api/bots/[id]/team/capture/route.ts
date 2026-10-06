import { requirePrincipal } from '@/lib/session';
import { captureTeamPublication } from '@/lib/hermes-team/publication';
import { readTeamPublicationRequest, teamPublicationFailure, teamPublicationResponse } from '@/lib/hermes-team/publication-http';
export async function POST(request: Request, ctx: RouteContext<'/api/bots/[id]/team/capture'>) {
  try {
    const principal = await requirePrincipal();
    return teamPublicationResponse(await captureTeamPublication(principal, (await ctx.params).id, await readTeamPublicationRequest(request)), 201);
  } catch (error) { return teamPublicationFailure(error); }
}
