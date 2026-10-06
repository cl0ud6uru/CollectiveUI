import { requirePrincipal } from '@/lib/session';
import { captureTeamPublication } from '@/lib/hermes-team/publication';
import { inventoryTeamResources } from '@/lib/hermes-team/transport';
import { readTeamPublicationRequest, teamPublicationFailure, teamPublicationResponse } from '@/lib/hermes-team/publication-http';
export async function GET(_request: Request, context: RouteContext<'/api/bots/[id]/team/capture'>) {
  try { return Response.json(await inventoryTeamResources(await requirePrincipal(), (await context.params).id), { headers: { 'Cache-Control': 'private, no-store' } }); }
  catch (error) { return teamPublicationFailure(error); }
}
export async function POST(request: Request, ctx: RouteContext<'/api/bots/[id]/team/capture'>) {
  try {
    const principal = await requirePrincipal();
    return teamPublicationResponse(await captureTeamPublication(principal, (await ctx.params).id, await readTeamPublicationRequest(request)), 201);
  } catch (error) { return teamPublicationFailure(error); }
}
