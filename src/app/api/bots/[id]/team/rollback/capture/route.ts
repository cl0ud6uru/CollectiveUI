import { requirePrincipal } from '@/lib/session';
import { captureTeamRollback } from '@/lib/hermes-team/rollback';
import { readTeamPublicationRequest, teamPublicationFailure, teamPublicationResponse } from '@/lib/hermes-team/publication-http';
export async function POST(request: Request, ctx: RouteContext<'/api/bots/[id]/team/rollback/capture'>) {
  try { return teamPublicationResponse(await captureTeamRollback(await requirePrincipal(), (await ctx.params).id, await readTeamPublicationRequest(request)), 201); }
  catch (e) { return teamPublicationFailure(e); }
}
